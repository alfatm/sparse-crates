import { Range, WorkspaceEdit, window, workspace } from 'vscode'

import log from './log.js'

export interface UpdateDependencyArgs {
  /** File path of the Cargo.toml */
  filePath: string
  /** 0-based line number of the dependency */
  line: number
  /** The new version string to set */
  newVersion: string
  /** The crate name (for logging) */
  crateName: string
}

/**
 * Updates a dependency version in a Cargo.toml file.
 * Handles both inline version strings and table-style dependencies.
 */
export async function updateDependencyVersion(args: UpdateDependencyArgs): Promise<void> {
  const { filePath, line, newVersion, crateName } = args

  const document = await workspace.openTextDocument(filePath)
  const lineText = document.lineAt(line).text

  // Match version patterns:
  // 1. Inline: `crate = "1.0.0"` or `crate = "^1.0.0"`
  // 2. Table style: `version = "1.0.0"` or `version = "^1.0.0"`
  // 3. Inline object: `crate = { version = "1.0.0", ... }`
  const versionPatterns = [
    // version = "X.Y.Z" (table style or inline object)
    /(\bversion\s*=\s*")([^"]+)(")/,
    // crate = "X.Y.Z" (simple inline, but not if it looks like a table)
    /^(\s*[a-zA-Z0-9_-]+\s*=\s*")([^"]+)(")\s*$/,
  ]

  let match: RegExpExecArray | null = null

  for (const p of versionPatterns) {
    match = p.exec(lineText)
    if (match) {
      break
    }
  }

  const prefix = match?.[1]
  const version = match?.[2]

  if (!match || prefix === undefined || version === undefined) {
    log.warn(`Could not find version pattern on line ${line + 1} for ${crateName}`)
    window.showWarningMessage(`Could not find version to update for ${crateName}`)
    return
  }

  const matchIndex = match.index ?? 0
  const startCol = matchIndex + prefix.length
  const endCol = startCol + version.length

  const edit = new WorkspaceEdit()
  const range = new Range(line, startCol, line, endCol)
  edit.replace(document.uri, range, newVersion)

  const success = await workspace.applyEdit(edit)

  if (success) {
    log.info(`Updated ${crateName} to version ${newVersion}`)
    // Save the document to trigger re-decoration
    await document.save()
  } else {
    log.error(`Failed to update ${crateName} to version ${newVersion}`)
    window.showErrorMessage(`Failed to update ${crateName}`)
  }
}
