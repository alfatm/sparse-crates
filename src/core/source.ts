import { exec } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import semver from 'semver'
import { parseTOML } from 'toml-eslint-parser'
import type { TOMLKeyValue, TOMLTable } from 'toml-eslint-parser/lib/ast/ast'

import type { CliToolsAvailability, CustomGitHost, DependencySource, FetchOptions } from './types'

const execAsync = promisify(exec)

/** Timeout for git operations in milliseconds */
const GIT_TIMEOUT_MS = 30000

/**
 * Escape a string for safe use in shell commands.
 * Uses single quotes and escapes any embedded single quotes.
 */
const shellEscape = (str: string): string => {
  // Single quotes prevent all interpretation except for single quotes themselves
  // Replace ' with '\'' (end quote, escaped quote, start quote)
  return `'${str.replace(/'/g, "'\\''")}'`
}

/** Cached CLI tools availability check result */
let cliToolsCache: CliToolsAvailability | undefined

/**
 * Check if required CLI tools are available on the system.
 * Results are cached for the lifetime of the process.
 */
export async function checkCliToolsAvailability(): Promise<CliToolsAvailability> {
  if (cliToolsCache) {
    return cliToolsCache
  }

  const checkCommand = async (cmd: string): Promise<boolean> => {
    try {
      await execAsync(`command -v ${cmd}`, { timeout: 5000 })
      return true
    } catch {
      return false
    }
  }

  const [git, sh, tar] = await Promise.all([checkCommand('git'), checkCommand('sh'), checkCommand('tar')])

  cliToolsCache = { git, sh, tar }
  return cliToolsCache
}

/**
 * Reset CLI tools cache (useful for testing)
 */
export function resetCliToolsCache(): void {
  cliToolsCache = undefined
}

/**
 * Result of resolving a dependency source
 */
export interface SourceResolution {
  /** The version from the source's Cargo.toml */
  version: semver.SemVer | undefined
  /** Error if resolution failed */
  error?: Error
}

/**
 * Resolves the version from a dependency source (path or git).
 * For registry dependencies, returns undefined (handled by fetchVersions).
 */
export function resolveSourceVersion(
  source: DependencySource,
  crateName: string,
  cargoTomlDir: string,
  options?: FetchOptions,
): Promise<SourceResolution> {
  if (source.type === 'registry') {
    return Promise.resolve({ version: undefined })
  }

  if (source.type === 'path') {
    return resolvePathVersion(source.path, crateName, cargoTomlDir, options)
  }

  if (source.type === 'git') {
    return resolveGitVersion(source.git, crateName, source.branch, source.tag, source.rev, options)
  }

  return Promise.resolve({ version: undefined })
}

/**
 * Reads the version from a local path dependency's Cargo.toml
 */
async function resolvePathVersion(
  depPath: string,
  crateName: string,
  cargoTomlDir: string,
  options?: FetchOptions,
): Promise<SourceResolution> {
  try {
    // Resolve relative path
    const absolutePath = path.isAbsolute(depPath) ? depPath : path.resolve(cargoTomlDir, depPath)
    const cargoTomlPath = path.join(absolutePath, 'Cargo.toml')

    options?.logger?.debug(`Reading path dependency from: ${cargoTomlPath}`)

    const content = await readFile(cargoTomlPath, 'utf-8')
    const info = extractCargoTomlInfo(content)

    // Use explicit version, or workspace version if usesWorkspaceVersion is true
    const effectiveVersion = info.version ?? (info.usesWorkspaceVersion ? info.workspaceVersion : undefined)
    if (effectiveVersion) {
      options?.logger?.debug(`Found version ${depPath}:${effectiveVersion} in path dependency`)
      return { version: effectiveVersion }
    }

    // If no version found, check if this is a workspace and search members
    if (info.workspaceMembers && info.workspaceMembers.length > 0) {
      options?.logger?.debug(`Found workspace with members: ${info.workspaceMembers.join(', ')}`)
      const expandedMembers = await expandWorkspaceMembers(absolutePath, info.workspaceMembers)

      for (const memberPath of expandedMembers) {
        const memberCargoTomlPath = path.join(absolutePath, memberPath, 'Cargo.toml')
        try {
          const memberContent = await readFile(memberCargoTomlPath, 'utf-8')
          const memberInfo = extractCargoTomlInfo(memberContent)

          // Check if this member's package name matches the crate we're looking for
          const memberName = extractPackageName(memberContent)
          if (memberName === crateName) {
            // Use explicit version, or workspace version if member uses workspace inheritance
            const memberEffectiveVersion =
              memberInfo.version ?? (memberInfo.usesWorkspaceVersion ? info.workspaceVersion : undefined)
            if (memberEffectiveVersion) {
              options?.logger?.debug(
                `Found version ${memberEffectiveVersion} for ${crateName} in workspace member ${memberPath}`,
              )
              return { version: memberEffectiveVersion }
            }
          }
        } catch {
          // Member Cargo.toml doesn't exist or can't be read, skip
        }
      }
    }

    return {
      version: undefined,
      error: new Error(`No version found in ${depPath}:${cargoTomlPath}`),
    }
  } catch (err) {
    return {
      version: undefined,
      error: err instanceof Error ? err : new Error(String(err)),
    }
  }
}

/**
 * Fetches the version from a git repository's Cargo.toml
 * First tries git archive (works with SSH keys, private repos), then falls back to HTTP
 */
async function resolveGitVersion(
  gitUrl: string,
  crateName: string,
  branch?: string,
  tag?: string,
  rev?: string,
  options?: FetchOptions,
): Promise<SourceResolution> {
  // Determine the git ref to use
  const ref = rev || tag || branch || 'HEAD'

  // First, try git archive (works with SSH keys, private repos, etc.)
  const cliResult = await tryGitCliFetch(gitUrl, ref, crateName, options)
  if (cliResult.version) {
    return cliResult
  }

  if (cliResult.error) {
    options?.logger?.debug(`git archive failed for ${gitUrl} at ${ref}, trying HTTP: ${cliResult.error}`)
  }

  // If git archive failed, try HTTP fetch for known hosts (GitHub/GitLab)
  const httpResult = await tryHttpFetch(gitUrl, ref, crateName, options)
  if (httpResult.version) {
    return httpResult
  }

  // Return the more informative error
  return cliResult.error ? cliResult : httpResult
}

/**
 * Build headers for git HTTP fetch
 */
function buildGitFetchHeaders(userAgent?: string, token?: string): Record<string, string> {
  const headers: Record<string, string> = {}
  if (userAgent) {
    headers['User-Agent'] = userAgent
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

/**
 * Try to fetch Cargo.toml via HTTP for GitHub/GitLab
 */
async function tryHttpFetch(
  gitUrl: string,
  ref: string,
  crateName: string,
  options?: FetchOptions,
): Promise<SourceResolution> {
  try {
    const customHosts = options?.gitOptions?.customHosts

    // Convert git URL to raw file URL for GitHub/GitLab
    const rawUrlResult = getGitRawFileUrl(gitUrl, ref, crateName, customHosts)

    if (!rawUrlResult) {
      options?.logger?.debug(`Cannot determine raw URL for git dependency: ${gitUrl}`)
      return {
        version: undefined,
        error: new Error(`Unsupported git host for HTTP fetch: ${gitUrl}`),
      }
    }

    options?.logger?.debug(`Fetching git dependency Cargo.toml from: ${rawUrlResult.url}`)

    const headers = buildGitFetchHeaders(options?.userAgent, rawUrlResult.token)
    const response = await fetch(rawUrlResult.url, {
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    })

    if (!response.ok) {
      // Try root Cargo.toml if crate-specific path failed
      const rootRawUrlResult = getGitRawFileUrl(gitUrl, ref, undefined, customHosts)
      if (rootRawUrlResult && rootRawUrlResult.url !== rawUrlResult.url) {
        options?.logger?.debug(`Trying root Cargo.toml: ${rootRawUrlResult.url}`)
        const rootHeaders = buildGitFetchHeaders(options?.userAgent, rootRawUrlResult.token)
        const rootResponse = await fetch(rootRawUrlResult.url, {
          headers: Object.keys(rootHeaders).length > 0 ? rootHeaders : undefined,
        })
        if (rootResponse.ok) {
          const content = await rootResponse.text()
          const info = extractCargoTomlInfo(content)

          // Use explicit version, or workspace version if usesWorkspaceVersion is true
          const effectiveVersion = info.version ?? (info.usesWorkspaceVersion ? info.workspaceVersion : undefined)
          if (effectiveVersion) {
            options?.logger?.debug(`Found version ${effectiveVersion} in git dependency root`)
            return { version: effectiveVersion }
          }

          // Check workspace members if no direct version
          if (info.workspaceMembers && info.workspaceMembers.length > 0) {
            const workspaceResult = await searchWorkspaceMembersHttp(
              gitUrl,
              ref,
              crateName,
              info.workspaceMembers,
              info.workspaceVersion,
              customHosts,
              options,
            )
            if (workspaceResult.version) {
              return workspaceResult
            }
          }
        }
      }

      return {
        version: undefined,
        error: new Error(`HTTP fetch failed: ${response.status} ${response.statusText}`),
      }
    }

    const content = await response.text()
    const info = extractCargoTomlInfo(content)

    // Use explicit version, or workspace version if usesWorkspaceVersion is true
    const effectiveVersion = info.version ?? (info.usesWorkspaceVersion ? info.workspaceVersion : undefined)
    if (effectiveVersion) {
      options?.logger?.debug(`Found version ${effectiveVersion} in git dependency via HTTP`)
      return { version: effectiveVersion }
    }

    // Check workspace members if no direct version
    if (info.workspaceMembers && info.workspaceMembers.length > 0) {
      const workspaceResult = await searchWorkspaceMembersHttp(
        gitUrl,
        ref,
        crateName,
        info.workspaceMembers,
        info.workspaceVersion,
        customHosts,
        options,
      )
      if (workspaceResult.version) {
        return workspaceResult
      }
    }

    return {
      version: undefined,
      error: new Error(`No version found in git repository ${gitUrl}`),
    }
  } catch (err) {
    return {
      version: undefined,
      error: err instanceof Error ? err : new Error(String(err)),
    }
  }
}

/**
 * Search workspace members via HTTP for the crate version
 * Note: For patterns like "crates/*", we try common paths based on crateName
 */
async function searchWorkspaceMembersHttp(
  gitUrl: string,
  ref: string,
  crateName: string,
  workspaceMembers: string[],
  workspaceVersion: semver.SemVer | undefined,
  customHosts: CustomGitHost[] | undefined,
  options?: FetchOptions,
): Promise<SourceResolution> {
  options?.logger?.debug(`Searching workspace members for ${crateName}: ${workspaceMembers.join(', ')}`)

  // Build list of potential paths to check
  const pathsToCheck: string[] = []

  for (const member of workspaceMembers) {
    if (member.includes('*')) {
      // For glob patterns like "crates/*", try the crateName directly
      const prefix = member.replace('*', '')
      pathsToCheck.push(`${prefix}${crateName}`)
    } else {
      pathsToCheck.push(member)
    }
  }

  // Try each path
  for (const memberPath of pathsToCheck) {
    const memberRawUrl = getGitRawFileUrlForPath(gitUrl, ref, `${memberPath}/Cargo.toml`, customHosts)
    if (!memberRawUrl) {
      continue
    }

    try {
      options?.logger?.debug(`Trying workspace member: ${memberRawUrl.url}`)
      const headers = buildGitFetchHeaders(options?.userAgent, memberRawUrl.token)
      const response = await fetch(memberRawUrl.url, {
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      })

      if (response.ok) {
        const content = await response.text()
        const memberName = extractPackageName(content)
        const memberInfo = extractCargoTomlInfo(content)

        if (memberName === crateName) {
          // Use explicit version, or workspace version if member uses workspace inheritance
          const effectiveVersion =
            memberInfo.version ?? (memberInfo.usesWorkspaceVersion ? workspaceVersion : undefined)
          if (effectiveVersion) {
            options?.logger?.debug(
              `Found version ${effectiveVersion} for ${crateName} in workspace member ${memberPath}`,
            )
            return { version: effectiveVersion }
          }
        }
      }
    } catch {
      // Skip failed requests
    }
  }

  return { version: undefined }
}

/**
 * Try to fetch Cargo.toml using git archive (supports SSH, private repos)
 */
async function tryGitCliFetch(
  gitUrl: string,
  ref: string,
  crateName: string,
  options?: FetchOptions,
): Promise<SourceResolution> {
  const cliTools = await checkCliToolsAvailability()
  const hasRequiredTools = cliTools.git && cliTools.sh && cliTools.tar

  if (!hasRequiredTools) {
    options?.logger?.debug(
      `Skipping git archive: missing CLI tools (git=${cliTools.git}, sh=${cliTools.sh}, tar=${cliTools.tar})`,
    )
    return {
      version: undefined,
      error: new Error(`Could not fetch Cargo.toml from ${gitUrl} via git CLI (missing required CLI tools)`),
    }
  }

  const result = await tryGitArchive(gitUrl, ref, crateName, options)

  if (!result.version && result.error) {
    options?.logger?.debug(`Unable to fetch via git archive: ${result.error}`)
  }

  return result.version
    ? result
    : { version: undefined, error: result.error ?? new Error(`Could not fetch Cargo.toml from ${gitUrl} via git CLI`) }
}

/**
 * Execute git archive and extract file contents safely.
 * Uses shell escaping to prevent command injection.
 */
async function execGitArchive(gitUrl: string, ref: string, filePath: string): Promise<string> {
  // Use shell escaping to safely pass arguments
  const escapedUrl = shellEscape(gitUrl)
  const escapedRef = shellEscape(ref)
  const escapedPath = shellEscape(filePath)

  const { stdout } = await execAsync(
    `git archive --remote=${escapedUrl} ${escapedRef} ${escapedPath} 2>/dev/null | tar -xO`,
    {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    },
  )

  return stdout
}

/**
 * Try git archive --remote (works with some git servers that support it)
 */
async function tryGitArchive(
  gitUrl: string,
  ref: string,
  crateName: string,
  options?: FetchOptions,
): Promise<SourceResolution> {
  const paths = crateName ? [`${crateName}/Cargo.toml`, 'Cargo.toml'] : ['Cargo.toml']

  for (const archivePath of paths) {
    try {
      options?.logger?.debug(`Trying git archive for ${gitUrl} ref=${ref} path=${archivePath}`)

      const content = await execGitArchive(gitUrl, ref, archivePath)

      const info = extractCargoTomlInfo(content)

      // Use explicit version, or workspace version if usesWorkspaceVersion is true
      const effectiveVersion = info.version ?? (info.usesWorkspaceVersion ? info.workspaceVersion : undefined)
      if (effectiveVersion) {
        options?.logger?.debug(`Found version ${effectiveVersion} via git archive`)
        return { version: effectiveVersion }
      }

      // Check workspace members if no direct version
      if (info.workspaceMembers && info.workspaceMembers.length > 0) {
        options?.logger?.debug(`Found workspace with members: ${info.workspaceMembers.join(', ')}`)
        const workspaceResult = await searchWorkspaceMembersGitArchive(
          gitUrl,
          ref,
          crateName,
          info.workspaceMembers,
          info.workspaceVersion,
          options,
        )
        if (workspaceResult.version) {
          return workspaceResult
        }
      }
    } catch {
      options?.logger?.debug(`git archive attempt failed for ${gitUrl} ref=${ref} path=${archivePath}`)
      // Try next path
    }
  }

  return { version: undefined }
}

/**
 * Search workspace members via git archive for the crate version
 */
async function searchWorkspaceMembersGitArchive(
  gitUrl: string,
  ref: string,
  crateName: string,
  workspaceMembers: string[],
  workspaceVersion: semver.SemVer | undefined,
  options?: FetchOptions,
): Promise<SourceResolution> {
  options?.logger?.debug(`Searching workspace members via git archive for ${crateName}: ${workspaceMembers.join(', ')}`)

  // Build list of potential paths to check
  const pathsToCheck: string[] = []

  for (const member of workspaceMembers) {
    if (member.includes('*')) {
      // For glob patterns like "crates/*", try the crateName directly
      const prefix = member.replace('*', '')
      pathsToCheck.push(`${prefix}${crateName}`)
    } else {
      pathsToCheck.push(member)
    }
  }

  // Try each path
  for (const memberPath of pathsToCheck) {
    const memberFilePath = `${memberPath}/Cargo.toml`
    try {
      options?.logger?.debug(`Trying workspace member via git archive: ${memberFilePath}`)

      const content = await execGitArchive(gitUrl, ref, memberFilePath)

      const memberName = extractPackageName(content)
      const memberInfo = extractCargoTomlInfo(content)

      if (memberName === crateName) {
        // Use explicit version, or workspace version if member uses workspace inheritance
        const effectiveVersion = memberInfo.version ?? (memberInfo.usesWorkspaceVersion ? workspaceVersion : undefined)
        if (effectiveVersion) {
          options?.logger?.debug(`Found version ${effectiveVersion} for ${crateName} in workspace member ${memberPath}`)
          return { version: effectiveVersion }
        }
      }
    } catch {
      // Skip failed requests
    }
  }

  return { version: undefined }
}

/**
 * Result of resolving a git raw file URL
 */
export interface GitRawUrlResult {
  url: string
  token?: string
}

/**
 * Internal helper to build raw file URLs for git hosts.
 * Handles URL normalization, custom hosts, GitHub, and GitLab.
 */
const buildGitRawUrl = (
  gitUrl: string,
  ref: string,
  filePath: string,
  customHosts?: CustomGitHost[],
): GitRawUrlResult | undefined => {
  // Normalize the URL
  let url = gitUrl.trim()

  // Remove .git suffix if present
  if (url.endsWith('.git')) {
    url = url.slice(0, -4)
  }

  // Check custom hosts first
  if (customHosts) {
    for (const customHost of customHosts) {
      const hostPattern = customHost.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const hostRegex = new RegExp(`${hostPattern}[/:]([^/]+)/([^/]+)`)
      const match = url.match(hostRegex)
      if (match) {
        const [, owner, repo] = match
        if (customHost.type === 'github') {
          return {
            url: `https://${customHost.host}/raw/${owner}/${repo}/${ref}/${filePath}`,
            token: customHost.token,
          }
        }
        if (customHost.type === 'gitlab') {
          return {
            url: `https://${customHost.host}/${owner}/${repo}/-/raw/${ref}/${filePath}`,
            token: customHost.token,
          }
        }
      }
    }
  }

  // Handle GitHub
  const githubMatch = url.match(/github\.com[/:]([^/]+)\/([^/]+)/)
  if (githubMatch) {
    const [, owner, repo] = githubMatch
    return {
      url: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`,
    }
  }

  // Handle GitLab
  const gitlabMatch = url.match(/gitlab\.com[/:]([^/]+)\/([^/]+)/)
  if (gitlabMatch) {
    const [, owner, repo] = gitlabMatch
    return {
      url: `https://gitlab.com/${owner}/${repo}/-/raw/${ref}/${filePath}`,
    }
  }

  return undefined
}

/**
 * Converts a git URL to a raw file URL for fetching Cargo.toml
 * Supports GitHub, GitLab, and custom hosts
 */
export function getGitRawFileUrl(
  gitUrl: string,
  ref: string,
  crateName?: string,
  customHosts?: CustomGitHost[],
): GitRawUrlResult | undefined {
  const filePath = crateName ? `${crateName}/Cargo.toml` : 'Cargo.toml'
  return buildGitRawUrl(gitUrl, ref, filePath, customHosts)
}

/**
 * Converts a git URL to a raw file URL for a specific file path
 */
export function getGitRawFileUrlForPath(
  gitUrl: string,
  ref: string,
  filePath: string,
  customHosts?: CustomGitHost[],
): GitRawUrlResult | undefined {
  return buildGitRawUrl(gitUrl, ref, filePath, customHosts)
}

/**
 * Result of extracting version info from Cargo.toml
 */
interface CargoTomlVersionInfo {
  version?: semver.SemVer
  workspaceMembers?: string[]
  /** Version from [workspace.package] section */
  workspaceVersion?: semver.SemVer
  /** True if package uses version.workspace = true */
  usesWorkspaceVersion?: boolean
}

/**
 * Extracts version and workspace info from a Cargo.toml content string
 */
function extractCargoTomlInfo(content: string): CargoTomlVersionInfo {
  try {
    const toml = parseTOML(content)
    const result: CargoTomlVersionInfo = {}

    // Find [package], [workspace], and [workspace.package] tables
    for (const node of toml.body[0].body) {
      if (node.type === 'TOMLTable') {
        const table = node as TOMLTable
        const keys = table.key.keys.map((k) => (k.type === 'TOMLBare' ? k.name : k.value))

        if (keys.length === 1 && keys[0] === 'package') {
          // Look for version in [package] table
          for (const kv of table.body) {
            if (kv.type === 'TOMLKeyValue') {
              const keyValue = kv as TOMLKeyValue
              const kvKeys = keyValue.key.keys.map((k) => (k.type === 'TOMLBare' ? k.name : k.value))

              // Check for version = "x.y.z"
              if (kvKeys.length === 1 && kvKeys[0] === 'version') {
                const value = keyValue.value
                if (value.type === 'TOMLValue' && value.kind === 'string') {
                  const parsed = semver.parse(value.value)
                  if (parsed) {
                    result.version = parsed
                  }
                }
              }

              // Check for version.workspace = true (inline table style)
              if (kvKeys.length === 2 && kvKeys[0] === 'version' && kvKeys[1] === 'workspace') {
                const value = keyValue.value
                if (value.type === 'TOMLValue' && value.kind === 'boolean' && value.value === true) {
                  result.usesWorkspaceVersion = true
                }
              }
            }
          }
        } else if (keys.length === 1 && keys[0] === 'workspace') {
          // Look for members in [workspace] table
          for (const kv of table.body) {
            if (kv.type === 'TOMLKeyValue') {
              const keyValue = kv as TOMLKeyValue
              const key = keyValue.key.keys[0]
              if (key && (key.type === 'TOMLBare' ? key.name : key.value) === 'members') {
                const value = keyValue.value
                if (value.type === 'TOMLArray') {
                  result.workspaceMembers = value.elements
                    .filter((el) => el.type === 'TOMLValue' && el.kind === 'string')
                    .map((el) => (el as { value: string }).value)
                }
              }
            }
          }
        } else if (keys.length === 2 && keys[0] === 'workspace' && keys[1] === 'package') {
          // Look for version in [workspace.package] table
          for (const kv of table.body) {
            if (kv.type === 'TOMLKeyValue') {
              const keyValue = kv as TOMLKeyValue
              const key = keyValue.key.keys[0]
              if (key && (key.type === 'TOMLBare' ? key.name : key.value) === 'version') {
                const value = keyValue.value
                if (value.type === 'TOMLValue' && value.kind === 'string') {
                  const parsed = semver.parse(value.value)
                  if (parsed) {
                    result.workspaceVersion = parsed
                  }
                }
              }
            }
          }
        }
      } else if (node.type === 'TOMLKeyValue') {
        // Handle inline key-value at top level
        const kv = node as TOMLKeyValue
        const keys = kv.key.keys.map((k) => (k.type === 'TOMLBare' ? k.name : k.value))

        // package.version = "x.y.z"
        if (keys.length === 2 && keys[0] === 'package' && keys[1] === 'version') {
          const value = kv.value
          if (value.type === 'TOMLValue' && value.kind === 'string') {
            const parsed = semver.parse(value.value)
            if (parsed) {
              result.version = parsed
            }
          }
        }

        // workspace.package.version = "x.y.z"
        if (keys.length === 3 && keys[0] === 'workspace' && keys[1] === 'package' && keys[2] === 'version') {
          const value = kv.value
          if (value.type === 'TOMLValue' && value.kind === 'string') {
            const parsed = semver.parse(value.value)
            if (parsed) {
              result.workspaceVersion = parsed
            }
          }
        }

        // package.version.workspace = true
        if (keys.length === 3 && keys[0] === 'package' && keys[1] === 'version' && keys[2] === 'workspace') {
          const value = kv.value
          if (value.type === 'TOMLValue' && value.kind === 'boolean' && value.value === true) {
            result.usesWorkspaceVersion = true
          }
        }
      }
    }

    return result
  } catch {
    return {}
  }
}

/**
 * Extracts the package name from a Cargo.toml content string
 */
function extractPackageName(content: string): string | undefined {
  try {
    const toml = parseTOML(content)

    for (const node of toml.body[0].body) {
      if (node.type === 'TOMLTable') {
        const table = node as TOMLTable
        const keys = table.key.keys.map((k) => (k.type === 'TOMLBare' ? k.name : k.value))

        if (keys.length === 1 && keys[0] === 'package') {
          for (const kv of table.body) {
            if (kv.type === 'TOMLKeyValue') {
              const keyValue = kv as TOMLKeyValue
              const key = keyValue.key.keys[0]
              if (key && (key.type === 'TOMLBare' ? key.name : key.value) === 'name') {
                const value = keyValue.value
                if (value.type === 'TOMLValue' && value.kind === 'string') {
                  return value.value
                }
              }
            }
          }
        }
      }
    }

    return undefined
  } catch {
    return undefined
  }
}

/**
 * Expand workspace member patterns (e.g., "crates/*") to actual paths
 */
async function expandWorkspaceMembers(baseDir: string, members: string[]): Promise<string[]> {
  const expanded: string[] = []

  for (const member of members) {
    if (member.includes('*')) {
      // Simple glob expansion for patterns like "crates/*"
      const parts = member.split('*')
      if (parts.length === 2) {
        const prefix = parts[0] ?? ''
        const suffix = parts[1] ?? ''
        const parentDir = path.join(baseDir, prefix)
        try {
          const entries = await readdir(parentDir, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.isDirectory()) {
              expanded.push(path.join(prefix, entry.name, suffix).replace(/\/$/, ''))
            }
          }
        } catch {
          // Directory doesn't exist, skip
        }
      }
    } else {
      expanded.push(member)
    }
  }

  return expanded
}
