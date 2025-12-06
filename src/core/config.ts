import type { Registry, ValidatorConfig } from './types'

/** Default URLs and cache identifiers */
export const CRATES_IO_INDEX = new URL('https://index.crates.io/')
export const CRATES_IO_CACHE = 'index.crates.io-6f17d22bba15001f'
export const DOCS_RS_URL = new URL('https://docs.rs/')

export const DEFAULT_CONFIG: ValidatorConfig = {
  cratesIoIndex: CRATES_IO_INDEX,
  cratesIoCache: CRATES_IO_CACHE,
  useCargoCache: true,
  registries: [],
}

/** Registry config as stored in settings/cargo config */
export interface RegistryConfig {
  name: string
  index: string
  cache?: string
  docs?: string
  token?: string
}

/**
 * Parse a registry config into a Registry object.
 * @param registry - The registry configuration to parse
 * @returns Parsed Registry object with URL instances
 * @throws Error if the index URL or docs URL is invalid
 */
export const parseRegistryConfig = (registry: RegistryConfig): Registry => {
  let index: URL
  let docs: URL | undefined

  try {
    index = new URL(registry.index)
  } catch {
    throw new Error(`registry ${registry.name} - invalid index URL: ${registry.index}`)
  }

  if (registry.docs) {
    try {
      docs = new URL(registry.docs)
    } catch {
      throw new Error(`registry ${registry.name} - invalid docs URL: ${registry.docs}`)
    }
  }

  return { index, cache: registry.cache, docs, token: registry.token }
}

/**
 * Merge registry arrays, where later entries override earlier ones with the same name.
 */
export const mergeRegistries = (...registrySets: RegistryConfig[][]): RegistryConfig[] => {
  const merged: RegistryConfig[] = []

  for (const registries of registrySets) {
    for (const reg of registries) {
      const existingIndex = merged.findIndex((r) => r.name === reg.name)
      if (existingIndex >= 0) {
        merged[existingIndex] = reg
      } else {
        merged.push(reg)
      }
    }
  }

  return merged
}

/**
 * Get registry configuration by name, or default crates.io registry.
 * @param name - Registry name, or undefined for crates.io
 * @param config - Validator configuration containing registry definitions
 * @returns Registry configuration with URL instances
 * @throws Error if named registry is not found or has invalid URLs
 */
export const getRegistry = (name: string | undefined, config: ValidatorConfig): Registry => {
  if (name) {
    const registry = config.registries.find((r) => r.name === name)
    if (registry) {
      return parseRegistryConfig(registry)
    }
    throw new Error(`unknown registry: ${name}`)
  }

  // Source replacement (crates.io mirror)
  if (config.sourceReplacement) {
    let index: URL
    try {
      index = new URL(config.sourceReplacement.index)
    } catch {
      throw new Error(`source replacement - invalid index URL: ${config.sourceReplacement.index}`)
    }
    return { index, token: config.sourceReplacement.token, docs: DOCS_RS_URL }
  }

  // Default: crates.io
  return {
    index: config.cratesIoIndex,
    cache: config.cratesIoCache,
    docs: DOCS_RS_URL,
  }
}
