import { commands, type ExtensionContext, ProgressLocation, type TextEditor, window, workspace } from 'vscode'

import { clearVersionsCache, resetCliToolsCache } from '../core/index.js'
import { clearCargoConfigCache } from './config.js'
import { decorate } from './decorate.js'
import log from './log.js'

/** Track decorated editors to avoid redundant decoration */
const decoratedEditors = new Set<TextEditor>()

/** Track pending decoration operations */
const pendingDecorations = new Map<string, AbortController>()

export function activate(context: ExtensionContext) {
  log.info('Elder Crates activated')

  // Register command to manually refresh decorations
  const refreshCommand = commands.registerCommand('elder-crates.refresh', () => {
    refreshAllCargoToml()
  })

  // Register command to reload current file with full cache clear
  const reloadCommand = commands.registerCommand('elder-crates.reload', () => {
    reloadCurrentFile()
  })

  // Decorate files when they are first opened
  const visibleEditorsListener = window.onDidChangeVisibleTextEditors((editors) => {
    // Clean up editors that are no longer visible
    for (const editor of decoratedEditors) {
      if (!editors.includes(editor)) {
        decoratedEditors.delete(editor)
        cancelPendingDecoration(editor.document.fileName)
      }
    }

    // Decorate new Cargo.toml editors
    for (const editor of editors) {
      if (isCargoToml(editor) && !decoratedEditors.has(editor)) {
        decoratedEditors.add(editor)
        decorateWithProgress(editor)
      }
    }
  })

  // Decorate files when their changes are saved
  const saveListener = workspace.onDidSaveTextDocument((document) => {
    if (document.fileName.endsWith('Cargo.toml')) {
      const editor = window.visibleTextEditors.find((e) => e.document === document)
      if (editor !== undefined) {
        decorateWithProgress(editor)
      }
    }
  })

  // Listen for configuration changes
  const configListener = workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('elder-crates')) {
      log.info('Configuration changed, refreshing decorations')
      clearCargoConfigCache()
      refreshAllCargoToml()
    }
  })

  // Register all disposables
  context.subscriptions.push(refreshCommand, reloadCommand, visibleEditorsListener, saveListener, configListener, {
    dispose: () => {
      decoratedEditors.clear()
      for (const controller of pendingDecorations.values()) {
        controller.abort()
      }
      pendingDecorations.clear()
      log.dispose()
    },
  })

  // Decorate already visible Cargo.toml files on activation
  for (const editor of window.visibleTextEditors) {
    if (isCargoToml(editor)) {
      decoratedEditors.add(editor)
      decorateWithProgress(editor)
    }
  }
}

export function deactivate() {
  // Cleanup handled by disposables
}

function isCargoToml(editor: TextEditor): boolean {
  return editor.document.fileName.endsWith('Cargo.toml')
}

function cancelPendingDecoration(fileName: string) {
  const controller = pendingDecorations.get(fileName)
  if (controller) {
    controller.abort()
    pendingDecorations.delete(fileName)
  }
}

async function decorateWithProgress(editor: TextEditor): Promise<void> {
  const fileName = editor.document.fileName

  // Cancel any pending decoration for this file
  cancelPendingDecoration(fileName)

  const controller = new AbortController()
  pendingDecorations.set(fileName, controller)

  try {
    await window.withProgress(
      {
        location: ProgressLocation.Window,
        title: 'Elder Crates: Checking dependencies...',
      },
      async () => {
        if (controller.signal.aborted) {
          return
        }
        await decorate(editor)
      },
    )
  } catch (err) {
    if (!controller.signal.aborted) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`Failed to decorate ${fileName}: ${message}`)
      window.showErrorMessage(`Elder Crates: Failed to check dependencies. See output for details.`)
    }
  } finally {
    pendingDecorations.delete(fileName)
  }
}

function refreshAllCargoToml() {
  for (const editor of window.visibleTextEditors) {
    if (isCargoToml(editor)) {
      decorateWithProgress(editor)
    }
  }
}

function reloadCurrentFile() {
  // Clear all caches
  clearCargoConfigCache()
  clearVersionsCache()
  resetCliToolsCache()

  log.info('All caches cleared, reloading current file')

  // Reload the active editor if it's a Cargo.toml
  const activeEditor = window.activeTextEditor
  if (activeEditor && isCargoToml(activeEditor)) {
    decorateWithProgress(activeEditor)
  } else {
    // Reload all visible Cargo.toml files
    refreshAllCargoToml()
  }
}
