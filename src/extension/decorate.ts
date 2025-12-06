import {
  type DecorationOptions,
  MarkdownString,
  type Progress,
  type TextEditor,
  type TextEditorDecorationType,
  ThemeColor,
  window,
} from 'vscode'
import {
  type AdvisoryMap,
  checkAdvisories,
  type DependencyValidationResult,
  DOCS_RS_URL,
  findCargoLockPath,
  formatAdvisoriesForHover,
  formatDependencyResult,
  readCargoLockfile,
  SYMBOL_ADVISORY,
  validateCargoTomlContent,
} from '../core/index'
import type { DependencyStatus, ValidatorConfig } from '../core/types'
import { buildValidatorConfig, loadConfigForScope, VSCODE_USER_AGENT } from './config'
import log from './log'

/** All dependency statuses - single source of truth */
const ALL_STATUSES: DependencyStatus[] = ['latest', 'patch-behind', 'minor-behind', 'major-behind', 'error']

/** Theme colors for each status */
const STATUS_COLORS: Record<DependencyStatus, string> = {
  latest: 'editorInfo.foreground',
  'patch-behind': 'editorWarning.foreground',
  'minor-behind': 'editorWarning.foreground',
  'major-behind': 'editorError.foreground',
  error: 'editorError.foreground',
}

/** Lazily initialized decoration types */
let decorationTypes: Record<DependencyStatus, TextEditorDecorationType> | null = null

/** Get or create decoration types (lazy initialization) */
function getDecorationTypes(): Record<DependencyStatus, TextEditorDecorationType> {
  if (!decorationTypes) {
    decorationTypes = Object.fromEntries(
      ALL_STATUSES.map((status) => [
        status,
        window.createTextEditorDecorationType({
          after: {
            margin: '2em',
            color: new ThemeColor(STATUS_COLORS[status]),
          },
        }),
      ]),
    ) as Record<DependencyStatus, TextEditorDecorationType>
  }
  return decorationTypes
}

/** Dispose all decoration types - call on extension deactivation */
export function disposeDecorations() {
  if (decorationTypes) {
    for (const status of ALL_STATUSES) {
      decorationTypes[status].dispose()
    }
    decorationTypes = null
  }
}

/** Build decoration options for a single dependency */
function buildDecorationOptions(
  editor: TextEditor,
  depResult: DependencyValidationResult,
  fileName: string,
  docsUrl: string,
  advisories: AdvisoryMap,
): { status: DependencyStatus; options: DecorationOptions } {
  const { status, decoration, hoverMarkdown, updateVersion } = formatDependencyResult(depResult, docsUrl)
  const crateName = depResult.dependency.name

  // Check if this crate has security advisories
  const crateAdvisories = advisories.get(crateName) ?? []
  const hasAdvisories = crateAdvisories.length > 0

  // Build hover message with optional update command and advisories
  const hoverMessage = new MarkdownString(hoverMarkdown)
  hoverMessage.isTrusted = true

  // Add update button if there's a newer version available
  if (updateVersion && depResult.dependency.source.type === 'registry') {
    const commandArgs = encodeURIComponent(
      JSON.stringify({
        filePath: fileName,
        line: depResult.dependency.line,
        newVersion: updateVersion,
        crateName: crateName,
      }),
    )
    hoverMessage.appendMarkdown(
      `\n\n[⬆️ Update to ${updateVersion}](command:fancy-crates.updateDependency?${commandArgs})`,
    )
  }

  // Add advisory information to hover if present
  if (hasAdvisories) {
    hoverMessage.appendMarkdown(formatAdvisoriesForHover(crateAdvisories))
  }

  // Add advisory emoji to decoration if there are security issues
  const finalDecoration = hasAdvisories ? `${SYMBOL_ADVISORY} ${decoration}` : decoration

  return {
    status,
    options: {
      range: editor.document.lineAt(depResult.dependency.line).range,
      hoverMessage,
      renderOptions: {
        after: {
          contentText: finalDecoration,
        },
      },
    },
  }
}

/** Apply decorations to editor grouped by status */
function applyDecorations(
  editor: TextEditor,
  dependencies: DependencyValidationResult[],
  fileName: string,
  docsUrl: string,
  advisories: AdvisoryMap,
) {
  const decorationsByStatus = Object.fromEntries(
    ALL_STATUSES.map((status) => [status, [] as DecorationOptions[]]),
  ) as Record<DependencyStatus, DecorationOptions[]>

  for (const depResult of dependencies) {
    const { status, options } = buildDecorationOptions(editor, depResult, fileName, docsUrl, advisories)
    decorationsByStatus[status].push(options)
  }

  // Apply decorations for each status (clear empty ones too to remove stale decorations)
  const types = getDecorationTypes()
  for (const status of ALL_STATUSES) {
    editor.setDecorations(types[status], decorationsByStatus[status])
  }
}

/** Track pending advisory checks per file to allow cancellation */
const pendingAdvisoryChecks = new Map<string, AbortController>()

/** Cancel any pending advisory check for a file */
export function cancelPendingAdvisoryCheck(fileName: string): void {
  const controller = pendingAdvisoryChecks.get(fileName)
  if (controller) {
    controller.abort()
    pendingAdvisoryChecks.delete(fileName)
  }
}

/** Progress reporter type for decorate function */
export type ProgressReporter = Progress<{ message?: string }>

export async function decorate(editor: TextEditor, signal?: AbortSignal, progress?: ProgressReporter): Promise<void> {
  const fileName = editor.document.fileName
  log.info(`${fileName} - decorating file`)
  const scope = editor.document.uri
  const start = Date.now()

  // Cancel any pending advisory check for this file
  cancelPendingAdvisoryCheck(fileName)

  // Check if already aborted
  if (signal?.aborted) {
    return
  }

  // Load cargo registries before processing dependencies
  progress?.report({ message: 'Loading config...' })
  await loadConfigForScope(scope)

  if (signal?.aborted) {
    return
  }

  // Build validator config from extension settings
  const baseConfig = buildValidatorConfig(scope)
  const config: ValidatorConfig = {
    ...baseConfig,
    fetchOptions: {
      ...baseConfig.fetchOptions,
      logger: log,
      userAgent: VSCODE_USER_AGENT,
    },
  }

  // Load Cargo.lock if available
  progress?.report({ message: 'Reading Cargo.lock...' })
  const lockPath = await findCargoLockPath(fileName)
  const lockfile = lockPath ? readCargoLockfile(lockPath) : undefined
  log.debug(`${fileName} - Cargo.lock: ${lockPath ?? 'not found'}`)

  if (signal?.aborted) {
    return
  }

  // First, validate versions (fast operation)
  progress?.report({ message: 'Validating dependencies...' })
  const result = await validateCargoTomlContent(editor.document.getText(), fileName, config, lockfile)

  if (signal?.aborted) {
    return
  }

  if (result.parseError) {
    log.error(`${fileName} - parse error: ${result.parseError.message}`)
    return
  }

  const docsUrl = DOCS_RS_URL.toString()
  const emptyAdvisories: AdvisoryMap = new Map()

  // Show decorations immediately without advisories
  progress?.report({ message: `Decorated ${result.dependencies.length} dependencies` })
  applyDecorations(editor, result.dependencies, fileName, docsUrl, emptyAdvisories)
  log.info(`${fileName} - file decorated in ${((Date.now() - start) / 1000).toFixed(2)} seconds`)

  // Create abort controller for advisory check
  const advisoryController = new AbortController()
  pendingAdvisoryChecks.set(fileName, advisoryController)

  // Link parent signal to advisory controller
  if (signal) {
    signal.addEventListener('abort', () => advisoryController.abort(), { once: true })
  }

  // Run cargo-deny in background and update decorations when done
  checkAdvisories(fileName, log)
    .then((advisoryResult) => {
      // Check if aborted
      if (advisoryController.signal.aborted) {
        log.debug(`${fileName} - advisory check cancelled`)
        return
      }

      // Verify editor is still valid and document unchanged
      if (editor.document.isClosed || editor.document.fileName !== fileName) {
        log.debug(`${fileName} - editor changed, skipping advisory decoration update`)
        return
      }

      const advisories: AdvisoryMap = advisoryResult.advisories
      if (advisoryResult.available) {
        if (advisoryResult.error) {
          log.warn(`${fileName} - cargo-deny error: ${advisoryResult.error}`)
        } else {
          log.info(`${fileName} - cargo-deny found ${advisories.size} packages with advisories`)
        }

        // Only update decorations if there are advisories to show
        if (advisories.size > 0) {
          applyDecorations(editor, result.dependencies, fileName, docsUrl, advisories)
          log.info(`${fileName} - decorations updated with advisories`)
        }
      } else {
        log.debug(`${fileName} - cargo-deny not available, skipping advisory check`)
      }
    })
    .catch((err) => {
      if (!advisoryController.signal.aborted) {
        log.error(`${fileName} - advisory check failed: ${err}`)
      }
    })
    .finally(() => {
      // Clean up tracking
      if (pendingAdvisoryChecks.get(fileName) === advisoryController) {
        pendingAdvisoryChecks.delete(fileName)
      }
    })
}
