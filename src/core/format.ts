import path from 'node:path'

import type semver from 'semver'

import type { DependencyStatus, DependencyValidationResult } from './types.js'

// Status symbols with colors:
// 🟢 latest - green
// 🟡 patch-behind - yellow (minor issue)
// 🟠 minor-behind - orange (warning)
// 🔴 major-behind - red (needs attention)
// 🔴 error - red
export const SYMBOL_LATEST = '✅'
export const SYMBOL_PATCH_BEHIND = '🟨'
export const SYMBOL_MINOR_BEHIND = '🟧'
export const SYMBOL_MAJOR_BEHIND = '🟥'
export const SYMBOL_ERROR = '❗'

const STATUS_SYMBOLS: Record<DependencyStatus, string> = {
  latest: SYMBOL_LATEST,
  'patch-behind': SYMBOL_PATCH_BEHIND,
  'minor-behind': SYMBOL_MINOR_BEHIND,
  'major-behind': SYMBOL_MAJOR_BEHIND,
  error: SYMBOL_ERROR,
}

/**
 * Result of formatting a dependency for display
 */
export interface FormattedDependency {
  /** The dependency status */
  status: DependencyStatus
  /** The decoration text (emoji + version if outdated) */
  decoration: string
  /** The hover message in markdown format */
  hoverMarkdown: string
}

/**
 * Format a dependency validation result for display.
 * This is used by both VSCode extension and CLI.
 */
export function formatDependencyResult(result: DependencyValidationResult, docsUrl?: string): FormattedDependency {
  const { dependency, resolved, latestStable, latest, status, error } = result
  const name = dependency.name

  if (status === 'error') {
    return {
      status,
      decoration: SYMBOL_ERROR,
      hoverMarkdown: error?.message ?? 'unknown error',
    }
  }

  if (resolved === null) {
    return {
      status: 'error',
      decoration: SYMBOL_ERROR,
      hoverMarkdown: `no versions of the crate ${name} satisfy the given requirement`,
    }
  }

  if (latest === undefined) {
    return {
      status: 'error',
      decoration: SYMBOL_ERROR,
      hoverMarkdown: 'No versions available',
    }
  }

  const symbol = STATUS_SYMBOLS[status]
  const targetVersion = latestStable ?? latest

  let decoration: string
  if (status === 'latest') {
    decoration = symbol
  } else {
    decoration = `${symbol} ${targetVersion}`
  }

  const hoverMarkdown = formatHoverMarkdown(resolved, latestStable, latest, name, docsUrl)

  return { status, decoration, hoverMarkdown }
}

/**
 * Format the hover message markdown for a dependency
 */
function formatHoverMarkdown(
  resolved: semver.SemVer | null,
  latestStable: semver.SemVer | undefined,
  latest: semver.SemVer,
  name: string,
  docsUrl?: string,
): string {
  const formatVersion = (v: semver.SemVer | null | undefined, label: string): string => {
    if (v === null) {
      return `- **${label}**: no versions satisfy the requirement`
    }
    if (v === undefined) {
      return `- **${label}**: not available`
    }
    if (docsUrl) {
      const url = docsUrl.endsWith('/') ? `${docsUrl}${name}/${v}` : `${docsUrl}/${name}/${v}`
      return `- **${label}**: [${v}](${url})`
    }
    return `- **${label}**: ${v}`
  }

  return [
    formatVersion(resolved, 'Resolved'),
    formatVersion(latestStable ?? null, 'Latest Stable'),
    formatVersion(latest, 'Latest'),
    '- **Locked**: feature not implemented',
  ].join('\n')
}

/**
 * Format a link to docs for a specific version
 */
export function formatDocsLink(v: semver.SemVer | null | undefined, name: string, docs: URL | undefined): string {
  if (v === null) {
    return `no versions of the crate ${name} satisfy the given requirement`
  } else if (v === undefined) {
    return 'not available'
  } else if (docs === undefined) {
    return v.format()
  } else {
    return `[${v}](${new URL(path.posix.join(docs.pathname, name, v.format()), docs)})`
  }
}
