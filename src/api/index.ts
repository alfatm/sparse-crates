/**
 * Programmatic API for fancy-crates
 * Use this module for batch analysis and integration with other tools
 */

import { readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type {
  DependencyValidationResult,
  Logger,
  RegistryConfig,
  ValidationResult,
  ValidatorConfig,
} from '../core/index'
import {
  DEFAULT_CONFIG,
  getSourceReplacement,
  loadCargoConfig,
  mergeRegistries,
  validateCargoToml,
} from '../core/index'

/** Default maximum concurrent validations for batch operations */
const DEFAULT_BATCH_CONCURRENCY = 10

/**
 * Options for batch validation
 */
export interface BatchValidationOptions {
  /** Directory containing Cargo.toml files to analyze */
  rootDir: string
  /** Glob pattern for finding Cargo.toml files (default: "** /Cargo.toml") */
  pattern?: string
  /** Use Cargo cache for faster lookups */
  useCargoCache?: boolean
  /** Additional registries to use */
  registries?: RegistryConfig[]
  /** Logger for debug/info output */
  logger?: Logger
  /** Maximum concurrent validations (default: 10) */
  concurrency?: number
}

/**
 * Result of batch validation
 */
export interface BatchValidationResult {
  /** Total number of Cargo.toml files found */
  totalFiles: number
  /** Total number of dependencies analyzed */
  totalDependencies: number
  /** Results per file */
  results: ValidationResult[]
  /** Files that failed to analyze */
  errors: Array<{ path: string; error: Error }>
  /** Summary statistics */
  summary: {
    latest: number
    patchBehind: number
    minorBehind: number
    majorBehind: number
    errors: number
  }
}

/**
 * JSON-friendly dependency result for export
 */
export interface DependencyResultJson {
  name: string
  currentVersion?: string
  resolvedVersion?: string
  latestStable?: string
  latest?: string
  locked?: string
  registry?: string
  status: string
  error?: string
  line: number
  source: {
    type: string
    [key: string]: unknown
  }
}

/**
 * JSON-friendly validation result for export
 */
export interface ValidationResultJson {
  filePath: string
  dependencies: DependencyResultJson[]
  parseError?: string
  summary: {
    total: number
    latest: number
    patchBehind: number
    minorBehind: number
    majorBehind: number
    errors: number
  }
}

/**
 * Create a no-op logger
 */
const createNoopLogger = (): Logger => ({
  debug: () => {
    /* noop */
  },
  info: () => {
    /* noop */
  },
  warn: () => {
    /* noop */
  },
  error: () => {
    /* noop */
  },
})

/**
 * Recursively find Cargo.toml files in a directory
 */
async function findCargoTomlFiles(dir: string, pattern: string): Promise<string[]> {
  const results: string[] = []

  // Simple implementation: recursively search for Cargo.toml files
  // For pattern support, we'd need a proper glob library, but for now handle the common case
  const isRecursive = pattern.includes('**')

  async function walk(currentDir: string): Promise<void> {
    try {
      const entries = await readdir(currentDir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = resolve(currentDir, entry.name)

        if (entry.isDirectory()) {
          // Skip common directories that don't contain crates
          if (entry.name === 'node_modules' || entry.name === 'target' || entry.name === '.git') {
            continue
          }
          if (isRecursive) {
            await walk(fullPath)
          }
        } else if (entry.isFile() && entry.name === 'Cargo.toml') {
          results.push(fullPath)
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  await walk(dir)
  return results
}

/**
 * Convert DependencyValidationResult to JSON-friendly format
 */
export function toJson(result: DependencyValidationResult): DependencyResultJson {
  return {
    name: result.dependency.name,
    currentVersion: result.dependency.versionRaw,
    resolvedVersion: result.resolved?.version,
    latestStable: result.latestStable?.version,
    latest: result.latest?.version,
    locked: result.locked?.version,
    registry: result.dependency.registry,
    status: result.status,
    error: result.error?.message,
    line: result.dependency.line + 1, // Convert to 1-based line numbers
    source: {
      type: result.dependency.source.type,
      ...(result.dependency.source.type === 'registry'
        ? { registry: result.dependency.source.registry }
        : result.dependency.source.type === 'path'
          ? { path: result.dependency.source.path }
          : result.dependency.source.type === 'git'
            ? {
                git: result.dependency.source.git,
                branch: result.dependency.source.branch,
                tag: result.dependency.source.tag,
                rev: result.dependency.source.rev,
              }
            : {}),
    },
  }
}

/**
 * Convert ValidationResult to JSON-friendly format with summary
 */
export function toJsonWithSummary(result: ValidationResult): ValidationResultJson {
  const deps = result.dependencies
  const latest = deps.filter((d) => d.status === 'latest').length
  const patchBehind = deps.filter((d) => d.status === 'patch-behind').length
  const minorBehind = deps.filter((d) => d.status === 'minor-behind').length
  const majorBehind = deps.filter((d) => d.status === 'major-behind').length
  const errors = deps.filter((d) => d.status === 'error').length

  return {
    filePath: result.filePath,
    dependencies: deps.map(toJson),
    parseError: result.parseError?.message,
    summary: {
      total: deps.length,
      latest,
      patchBehind,
      minorBehind,
      majorBehind,
      errors,
    },
  }
}

/**
 * Validate a single Cargo.toml file with automatic config loading
 *
 * @param filePath - Path to the Cargo.toml file
 * @param options - Optional configuration overrides
 * @returns Validation result
 *
 * @example
 * ```ts
 * import { validateCrate } from 'fancy-crates/api'
 *
 * const result = await validateCrate('./Cargo.toml')
 * console.log(`Found ${result.dependencies.length} dependencies`)
 * ```
 */
export async function validateCrate(
  filePath: string,
  options?: {
    useCargoCache?: boolean
    registries?: RegistryConfig[]
    logger?: Logger
  },
): Promise<ValidationResult> {
  const absolutePath = resolve(filePath)
  const cargoDir = dirname(absolutePath)

  // Load cargo config
  const cargoConfig = await loadCargoConfig(cargoDir)
  const registries = mergeRegistries(cargoConfig.registries, options?.registries ?? [])
  const sourceReplacement = getSourceReplacement(cargoConfig)

  const config: ValidatorConfig = {
    ...DEFAULT_CONFIG,
    useCargoCache: options?.useCargoCache ?? true,
    registries,
    sourceReplacement,
    fetchOptions: {
      logger: options?.logger ?? createNoopLogger(),
    },
  }

  return validateCargoToml(absolutePath, config)
}

/**
 * Validate multiple Cargo.toml files in a directory tree
 *
 * @param options - Batch validation options
 * @returns Batch validation result with aggregated statistics
 *
 * @example
 * ```ts
 * import { validateBatch } from 'fancy-crates/api'
 *
 * const result = await validateBatch({
 *   rootDir: './my-workspace',
 *   pattern: '** /Cargo.toml', // Find all Cargo.toml files
 *   concurrency: 5
 * })
 *
 * console.log(`Analyzed ${result.totalDependencies} dependencies across ${result.totalFiles} crates`)
 * console.log(`${result.summary.majorBehind} dependencies need major updates`)
 * ```
 */
export async function validateBatch(options: BatchValidationOptions): Promise<BatchValidationResult> {
  const {
    rootDir,
    pattern = '**/Cargo.toml',
    useCargoCache = true,
    registries = [],
    logger = createNoopLogger(),
    concurrency = DEFAULT_BATCH_CONCURRENCY,
  } = options

  const absoluteRoot = resolve(rootDir)

  // Find all Cargo.toml files
  logger.info(`Searching for Cargo.toml files in ${absoluteRoot}`)
  const files = await findCargoTomlFiles(absoluteRoot, pattern)

  logger.info(`Found ${files.length} Cargo.toml files`)

  const results: ValidationResult[] = []
  const errors: Array<{ path: string; error: Error }> = []

  // Process files with concurrency limit
  const chunks = []
  for (let i = 0; i < files.length; i += concurrency) {
    chunks.push(files.slice(i, i + concurrency))
  }

  for (const chunk of chunks) {
    const chunkResults = await Promise.allSettled(
      chunk.map((file) =>
        validateCrate(file, {
          useCargoCache,
          registries,
          logger,
        }),
      ),
    )

    for (let i = 0; i < chunkResults.length; i++) {
      const result = chunkResults[i]
      const filePath = chunk[i]
      if (!result || !filePath) {
        continue
      }
      if (result.status === 'fulfilled') {
        results.push(result.value)
        logger.info(`✓ ${filePath}`)
      } else {
        const error = result.reason instanceof Error ? result.reason : new Error(String(result.reason))
        errors.push({ path: filePath, error })
        logger.error(`✗ ${filePath}: ${error.message}`)
      }
    }
  }

  // Calculate summary statistics
  let totalDependencies = 0
  let latest = 0
  let patchBehind = 0
  let minorBehind = 0
  let majorBehind = 0
  let statusErrors = 0

  for (const result of results) {
    totalDependencies += result.dependencies.length
    latest += result.dependencies.filter((d) => d.status === 'latest').length
    patchBehind += result.dependencies.filter((d) => d.status === 'patch-behind').length
    minorBehind += result.dependencies.filter((d) => d.status === 'minor-behind').length
    majorBehind += result.dependencies.filter((d) => d.status === 'major-behind').length
    statusErrors += result.dependencies.filter((d) => d.status === 'error').length
  }

  return {
    totalFiles: files.length,
    totalDependencies,
    results,
    errors,
    summary: {
      latest,
      patchBehind,
      minorBehind,
      majorBehind,
      errors: statusErrors,
    },
  }
}

/**
 * Export batch validation results to JSON string
 */
export function exportBatchToJson(result: BatchValidationResult, pretty = true): string {
  const json = {
    totalFiles: result.totalFiles,
    totalDependencies: result.totalDependencies,
    summary: result.summary,
    results: result.results.map(toJsonWithSummary),
    errors: result.errors.map((e) => ({
      path: e.path,
      error: e.error.message,
    })),
  }

  return JSON.stringify(json, null, pretty ? 2 : 0)
}

// Re-export core types that are useful for API consumers
export type {
  DependencyValidationResult,
  Logger,
  RegistryConfig,
  ValidationResult,
  ValidatorConfig,
} from '../core/index'
