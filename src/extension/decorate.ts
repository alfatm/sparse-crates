import {
  type DecorationOptions,
  MarkdownString,
  type TextEditor,
  type TextEditorDecorationType,
  ThemeColor,
  window,
} from 'vscode'
import { DOCS_RS_URL, formatDependencyResult, validateCargoTomlContent } from '../core/index.js'
import type { DependencyStatus, ValidatorConfig } from '../core/types.js'
import { buildValidatorConfig, loadConfigForScope, VSCODE_USER_AGENT } from './config.js'
import log from './log.js'

// Create decoration types for each status with appropriate colors
const DECORATION_TYPES: Record<DependencyStatus, TextEditorDecorationType> = {
  latest: window.createTextEditorDecorationType({
    after: {
      margin: '2em',
      color: new ThemeColor('editorInfo.foreground'),
    },
  }),
  'patch-behind': window.createTextEditorDecorationType({
    after: {
      margin: '2em',
      color: new ThemeColor('editorWarning.foreground'),
    },
  }),
  'minor-behind': window.createTextEditorDecorationType({
    after: {
      margin: '2em',
      color: new ThemeColor('editorWarning.foreground'),
    },
  }),
  'major-behind': window.createTextEditorDecorationType({
    after: {
      margin: '2em',
      color: new ThemeColor('editorError.foreground'),
    },
  }),
  error: window.createTextEditorDecorationType({
    after: {
      margin: '2em',
      color: new ThemeColor('editorError.foreground'),
    },
  }),
}

const ALL_STATUSES: DependencyStatus[] = ['latest', 'patch-behind', 'minor-behind', 'major-behind', 'error']

export async function decorate(editor: TextEditor) {
  const fileName = editor.document.fileName
  log.info(`${fileName} - decorating file`)
  const scope = editor.document.uri
  const start = Date.now()

  // Load cargo registries before processing dependencies
  await loadConfigForScope(scope)

  // Build validator config from extension settings
  const baseConfig = buildValidatorConfig(scope)
  const config: ValidatorConfig = {
    ...baseConfig,
    fetchOptions: {
      logger: log,
      userAgent: VSCODE_USER_AGENT,
    },
  }

  const result = await validateCargoTomlContent(editor.document.getText(), fileName, config)

  if (result.parseError) {
    log.error(`${fileName} - parse error: ${result.parseError.message}`)
    return
  }

  const docsUrl = DOCS_RS_URL.toString()

  // Group decorations by status for colored styling
  const decorationsByStatus: Record<DependencyStatus, DecorationOptions[]> = {
    latest: [],
    'patch-behind': [],
    'minor-behind': [],
    'major-behind': [],
    error: [],
  }

  for (const depResult of result.dependencies) {
    const { status, decoration, hoverMarkdown, updateVersion } = formatDependencyResult(depResult, docsUrl)

    // Build hover message with optional update command
    const hoverMessage = new MarkdownString(hoverMarkdown)
    hoverMessage.isTrusted = true

    // Add update button if there's a newer version available
    if (updateVersion && depResult.dependency.source.type === 'registry') {
      const commandArgs = encodeURIComponent(
        JSON.stringify({
          filePath: fileName,
          line: depResult.dependency.line,
          newVersion: updateVersion,
          crateName: depResult.dependency.name,
        }),
      )
      hoverMessage.appendMarkdown(
        `\n\n[⬆️ Update to ${updateVersion}](command:fancy-crates.updateDependency?${commandArgs})`,
      )
    }

    decorationsByStatus[status].push({
      range: editor.document.lineAt(depResult.dependency.line).range,
      hoverMessage,
      renderOptions: {
        after: {
          contentText: decoration,
        },
      },
    })
  }

  // Apply decorations for each status (clear empty ones too to remove stale decorations)
  for (const status of ALL_STATUSES) {
    editor.setDecorations(DECORATION_TYPES[status], decorationsByStatus[status])
  }

  log.info(`${fileName} - file decorated in ${Math.round((Date.now() - start) / 10) / 100} seconds`)
}
