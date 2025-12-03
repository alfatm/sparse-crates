import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { Agent, fetch } from 'undici'

import type { FetchOptions, Logger, Registry } from './types.js'

const DEFAULT_USER_AGENT = 'ElderCrates (https://github.com/alfatm/elder-crates)'
const FETCH_TIMEOUT_MS = 30000
const MAX_SOCKETS = 6

/** Cargo cache format versions (Cargo 0.69 / Rust 1.68.0) */
const CACHE_FORMAT = {
  version: 3,
  indexVersion: 2,
} as const

const noop = () => {
  /* noop */
}

const noopLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop }

const agent = new Agent({ connections: MAX_SOCKETS })

interface VersionsCache {
  versions: semver.SemVer[]
  callbackId: NodeJS.Timeout
}

class CrateVersionsCache {
  private cache = new Map<string, VersionsCache>()
  private expiration = 3600000 // 1 hour

  set = (key: string, versions: semver.SemVer[]) => {
    const existing = this.cache.get(key)
    if (existing) {
      clearTimeout(existing.callbackId)
    }

    this.cache.set(key, {
      versions,
      callbackId: setTimeout(() => this.cache.delete(key), this.expiration),
    })
  }

  get = (key: string) => this.cache.get(key)?.versions

  clear = () => {
    for (const entry of this.cache.values()) {
      clearTimeout(entry.callbackId)
    }
    this.cache.clear()
  }
}

const versionsCache = new CrateVersionsCache()

export function clearVersionsCache(): void {
  versionsCache.clear()
}

type LocalSource = 'local registry' | 'cache'
type Source = 'registry' | LocalSource

export const fetchVersions = async (
  name: string,
  registry: Registry,
  useCache: boolean,
  options: FetchOptions = {},
): Promise<semver.SemVer[]> => {
  const log = options.logger ?? noopLogger
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT

  const cached = versionsCache.get(name)
  if (cached) {
    return cached
  }

  // Try local cache first
  if (useCache && registry.cache) {
    try {
      const versions = await fetchLocal(name, resolveCacheDir(registry.cache), 'cache', log)
      versionsCache.set(name, versions)
      return versions
    } catch {
      // Cache miss, continue to network
    }
  }

  // Fetch from registry
  const versions =
    registry.index.protocol === 'file:'
      ? await fetchLocal(name, fileURLToPath(registry.index), 'local registry', log)
      : await fetchRemote(name, registry.index, userAgent, registry.token, log)

  versionsCache.set(name, versions)
  return versions
}

const fetchRemote = async (
  name: string,
  registry: URL,
  userAgent: string,
  token: string | undefined,
  log: Logger,
): Promise<semver.SemVer[]> => {
  const url = new URL(path.posix.join(registry.pathname, resolveIndexPath(name)), registry)
  log.info(`${name} - fetching versions from registry: ${url}`)

  const headers: Record<string, string> = { 'User-Agent': userAgent }
  if (token) {
    headers.Authorization = token
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      dispatcher: agent,
      headers,
      signal: controller.signal,
    })

    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer())
      return parseIndex(name, buffer, 'registry', log)
    }

    const message =
      response.status === 404 || response.status === 410 || response.status === 451
        ? `crate not found in registry: HTTP ${response.status}`
        : `unexpected response code: HTTP ${response.status}`

    log.error(`${name} - ${message}`)
    throw new Error(message)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      const message = 'connection to registry timeout'
      log.error(`${name} - ${message}`)
      throw new Error(message)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

const fetchLocal = async (name: string, dir: string, source: LocalSource, log: Logger): Promise<semver.SemVer[]> => {
  const filePath = path.resolve(dir, resolveIndexPath(name))
  log.info(`${name} - fetching versions from ${source}: ${filePath}`)

  try {
    const buffer = await readFile(filePath)
    return parseIndex(name, buffer, source, log)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    const message = e.code === 'ENOENT' ? `crate not found in ${source}` : `${source} read error: ${e}`
    log.error(`${name} - ${message}`)
    throw new Error(message)
  }
}

const parseIndex = (name: string, buffer: Buffer, source: Source, log: Logger): semver.SemVer[] => {
  const lines = source === 'cache' ? parseCacheBuffer(name, buffer, log) : buffer.toString('utf8').trim().split('\n')

  const versions = lines
    .map((line, i) => {
      const result = parseRelease(line, name)
      if (result instanceof Error) {
        log.warn(`${name} - ${source} index line ${i} - ${result.message}`)
        return undefined
      }
      return result
    })
    .filter((v): v is semver.SemVer => v !== undefined)

  if (versions.length === 0) {
    const message = `no version found in ${source}`
    log.warn(`${name} - ${message}`)
    throw new Error(message)
  }

  log.info(`${name} - ${versions.length} versions parsed from ${source}`)

  const latest = versions.sort(semver.compareBuild).reverse()[0]
  if (latest) {
    log.debug(`${name} - latest version: ${latest}`)
  }

  return versions
}

const parseCacheBuffer = (name: string, buffer: Buffer, log: Logger): string[] => {
  const cacheVersion = buffer.readUInt8(0)
  const indexVersion = buffer.readUint32LE(1)

  if (cacheVersion !== CACHE_FORMAT.version) {
    const message = `unknown cache version: ${cacheVersion}`
    log.warn(`${name} - ${message}`)
    throw new Error(message)
  }

  if (indexVersion !== CACHE_FORMAT.indexVersion) {
    const message = `unknown index version: ${indexVersion}`
    log.warn(`${name} - ${message}`)
    throw new Error(message)
  }

  return buffer
    .toString('utf8', 5)
    .split('\0')
    .filter((_, i) => i % 2 === 0 && i !== 0)
}

interface Release {
  name?: string
  vers?: string
  yanked?: boolean
}

const parseRelease = (s: string, name: string): semver.SemVer | Error | undefined => {
  let r: Release
  try {
    r = JSON.parse(s)
  } catch (err) {
    return new Error(`invalid JSON: ${err}`)
  }

  if (r.name !== name) {
    return new Error(`crate name mismatch: ${r.name}`)
  }
  if (r.yanked === undefined) {
    return new Error(`"yanked" key missing`)
  }
  if (r.yanked) {
    return undefined
  }

  const version = semver.parse(r.vers)
  if (!version) {
    return new Error(`invalid semver: ${r.vers}`)
  }

  return version
}

const resolveCacheDir = (cacheDir: string): string => {
  const cargoHome = process.env.CARGO_HOME ?? path.resolve(os.homedir(), '.cargo')
  return path.resolve(cargoHome, 'registry/index', cacheDir, '.cache')
}

/** https://docs.rs/cargo/latest/cargo/sources/registry/index.html#the-format-of-the-index */
const resolveIndexPath = (name: string): string => {
  const len = name.length
  if (len === 0) {
    return ''
  }
  if (len === 1) {
    return `1/${name}`
  }
  if (len === 2) {
    return `2/${name}`
  }
  if (len === 3) {
    return `3/${name.charAt(0)}/${name}`
  }
  return `${name.substring(0, 2)}/${name.substring(2, 4)}/${name}`
}
