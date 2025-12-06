import { readFile } from 'node:fs/promises'
import path from 'node:path'

import semver from 'semver'
import { ParseError, parseTOML } from 'toml-eslint-parser'
import type { TOMLTable } from 'toml-eslint-parser/lib/ast/ast'
import { DEFAULT_CONFIG, getRegistry } from './config'
import { fetchVersions } from './fetch'
import { type CargoLockfile, findCargoLockPath, getLockedVersion, readCargoLockfile } from './lockfile'
import { parseCargoDependencies } from './parse'
import { resolveSourceVersion } from './source'
import type {
  Dependency,
  DependencyStatus,
  DependencyValidationResult,
  ValidationResult,
  ValidatorConfig,
} from './types'

/**
 * Extract the minimum version from a semver Range.
 * For ranges like "^1.1.0" returns "1.1.0".
 * For ranges like ">=1.0.0 <2.0.0" returns "1.0.0".
 * For ranges like "<1.0.0" (no lower bound) returns "0.0.0".
 */
export const getMinVersionFromRange = (range: semver.Range): semver.SemVer | null => {
  // semver.Range has a 'set' property which is an array of Comparator arrays
  // Each Comparator has an 'operator' and a 'semver' (SemVer object)
  // We need to find the minimum version from the range
  let minVersion: semver.SemVer | null = null
  let hasLowerBound = false

  for (const comparators of range.set) {
    for (const comp of comparators) {
      if (comp.semver && comp.semver.version !== '') {
        const op = comp.operator as string
        // For operators like >= or empty (which means = in semver), the semver is the minimum
        // Note: ^ and ~ are expanded by semver into >= and < comparators
        if (op === '' || op === '>=' || op === '>') {
          hasLowerBound = true
          if (minVersion === null || comp.semver.compare(minVersion) < 0) {
            minVersion = comp.semver
          }
        }
      }
    }
  }

  // If no lower bound was found (e.g., "<1.0.0" from "^0"), the implicit minimum is 0.0.0
  if (!hasLowerBound && minVersion === null) {
    return new semver.SemVer('0.0.0')
  }

  return minVersion
}

/**
 * Compare two versions and determine how far behind `current` is from `target`.
 * Returns the type of version difference.
 */
export const compareVersionDiff = (
  current: semver.SemVer,
  target: semver.SemVer,
): 'latest' | 'patch-behind' | 'minor-behind' | 'major-behind' => {
  if (current.compare(target) >= 0) {
    return 'latest'
  }

  if (current.major < target.major) {
    return 'major-behind'
  }

  if (current.minor < target.minor) {
    return 'minor-behind'
  }

  if (current.patch < target.patch) {
    return 'patch-behind'
  }

  // Prerelease difference (e.g., 1.0.0-alpha vs 1.0.0)
  return 'patch-behind'
}

/**
 * Check if a version string represents an exact (full) version like "1.2.3".
 * Exact versions should be compared as equality, not as ranges.
 *
 * Returns true for: "1.2.3", "0.1.0", "10.20.30"
 * Returns false for: "1", "1.2", "^1.2.3", ">=1.0.0", "~1.2.3", "1.2.3, <2.0.0"
 */
export const isExactVersion = (versionRaw: string): boolean => {
  // Exact version is a plain version with all three components: major.minor.patch
  // It should not have any operators or multiple requirements
  const trimmed = versionRaw.trim()
  // Must start with a digit (no operators like ^, ~, =, >, <)
  // Must have exactly 3 numeric components separated by dots
  // May have pre-release or build metadata
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(trimmed)
}

/**
 * Compute dependency status based on the version specified in Cargo.toml and available versions.
 *
 * The logic is:
 * 1. For exact versions (like "1.2.3"), compare directly with the latest version
 * 2. For range versions (like "1", "1.2", "^1.2.3"), check if latestStable satisfies the range
 * 3. Otherwise, compare the minimum version from the range against latestStable to determine
 *    how far behind the specification is
 *
 * This correctly handles short version formats like "0", "1", "1.0" which represent ranges:
 * - "0" means >=0.0.0 <1.0.0, so if latestStable is 0.5.0, it's still "latest"
 * - "1" means >=1.0.0 <2.0.0, so if latestStable is 1.9.0, it's still "latest"
 *
 * But for exact versions like "1.2.3", we compare directly:
 * - "1.2.3" with latest 1.2.4 means patch-behind (not "latest")
 */
export const computeStatus = (
  specifiedRange: semver.Range,
  latestStable: semver.SemVer | undefined,
  latest: semver.SemVer | undefined,
  versionRaw?: string,
): DependencyStatus => {
  if (!latest) {
    return 'error'
  }

  // Compare against latest stable if available, otherwise against latest (which may be prerelease)
  const targetVersion = latestStable ?? latest

  // For exact versions, compare directly instead of using range satisfaction
  if (versionRaw && isExactVersion(versionRaw)) {
    const specifiedVersion = getMinVersionFromRange(specifiedRange)
    if (!specifiedVersion) {
      return 'error'
    }
    return compareVersionDiff(specifiedVersion, targetVersion)
  }

  // If the target version satisfies the specified range, the dependency is up-to-date
  if (specifiedRange.test(targetVersion)) {
    return 'latest'
  }

  // Otherwise, compare the minimum version from the range against the target
  const specifiedVersion = getMinVersionFromRange(specifiedRange)
  if (!specifiedVersion) {
    return 'error'
  }

  return compareVersionDiff(specifiedVersion, targetVersion)
}

/**
 * Get the locked version for a dependency from the lockfile.
 * Returns undefined if lockfile is not available or dependency has no version requirement.
 */
const getLocked = (lockfile: CargoLockfile | undefined, dep: Dependency): semver.SemVer | undefined => {
  if (!lockfile || !dep.version) {
    return undefined
  }
  return getLockedVersion(lockfile, dep.name, dep.version)
}

/**
 * Find the best matching version for a given semver range.
 * Unlike semver.maxSatisfying, this properly handles Cargo's version requirements.
 */
const findResolvedVersion = (versions: semver.SemVer[], range: semver.Range): semver.SemVer | null => {
  // Filter versions that satisfy the range and return the highest one
  const matching = versions.filter((v) => range.test(v))
  // versions are already sorted descending, so first match is highest
  return matching[0] ?? null
}

const validateRegistryDependency = async (
  dep: Dependency,
  config: ValidatorConfig,
  lockfile: CargoLockfile | undefined,
): Promise<DependencyValidationResult> => {
  try {
    const registry = getRegistry(dep.registry, config)
    const versions = await fetchVersions(dep.name, registry, config.useCargoCache, config.fetchOptions)

    versions.sort(semver.compareBuild).reverse()
    const resolved = dep.version ? findResolvedVersion(versions, dep.version) : null
    const latestStable = versions.find((v) => v.prerelease.length === 0)
    const latest = versions[0]
    return {
      dependency: dep,
      resolved,
      latestStable,
      latest,
      locked: getLocked(lockfile, dep),
      status: dep.version ? computeStatus(dep.version, latestStable, latest, dep.versionRaw) : 'error',
    }
  } catch (err) {
    return {
      dependency: dep,
      resolved: null,
      latestStable: undefined,
      latest: undefined,
      locked: getLocked(lockfile, dep),
      error: err instanceof Error ? err : new Error(String(err)),
      status: 'error',
    }
  }
}

const validateSourceDependency = async (
  dep: Dependency,
  cargoTomlDir: string,
  config: ValidatorConfig,
  lockfile: CargoLockfile | undefined,
): Promise<DependencyValidationResult> => {
  try {
    // Resolve the version from the source (path or git)
    const sourceResolution = await resolveSourceVersion(dep.source, dep.name, cargoTomlDir, config.fetchOptions)

    if (sourceResolution.error || !sourceResolution.version) {
      return {
        dependency: dep,
        resolved: sourceResolution.version ?? null,
        latestStable: sourceResolution.version,
        latest: sourceResolution.version,
        locked: getLocked(lockfile, dep),
        error: sourceResolution.error,
        status: sourceResolution.version ? 'latest' : 'error',
      }
    }

    const sourceVersion = sourceResolution.version

    // For path/git dependencies, the "latest" is the version from the source
    // If there's also a version requirement, check if the source version satisfies it
    if (dep.version) {
      const satisfies = dep.version.test(sourceVersion)
      return {
        dependency: dep,
        resolved: satisfies ? sourceVersion : null,
        latestStable: sourceVersion,
        latest: sourceVersion,
        locked: getLocked(lockfile, dep),
        status: satisfies ? 'latest' : 'error',
        error: satisfies ? undefined : new Error(`Source version ${sourceVersion} does not satisfy ${dep.versionRaw}`),
      }
    }

    // No version requirement, just show the source version
    return {
      dependency: dep,
      resolved: sourceVersion,
      latestStable: sourceVersion,
      latest: sourceVersion,
      locked: undefined,
      status: 'latest',
    }
  } catch (err) {
    return {
      dependency: dep,
      resolved: null,
      latestStable: undefined,
      latest: undefined,
      locked: undefined,
      error: err instanceof Error ? err : new Error(String(err)),
      status: 'error',
    }
  }
}

const validateDependency = (
  dep: Dependency,
  cargoTomlDir: string,
  config: ValidatorConfig,
  lockfile: CargoLockfile | undefined,
): Promise<DependencyValidationResult> => {
  if (dep.source.type === 'registry') {
    return validateRegistryDependency(dep, config, lockfile)
  }
  return validateSourceDependency(dep, cargoTomlDir, config, lockfile)
}

/**
 * Validate all dependencies in a Cargo.toml file.
 * @param filePath - Path to the Cargo.toml file
 * @param config - Validator configuration
 * @returns Validation results for all dependencies
 * @throws Error if the file cannot be read
 */
export const validateCargoToml = async (
  filePath: string,
  config: ValidatorConfig = DEFAULT_CONFIG,
): Promise<ValidationResult> => {
  const content = await readFile(filePath, 'utf-8')

  // Try to find and load Cargo.lock
  const lockPath = await findCargoLockPath(filePath)
  const lockfile = lockPath ? readCargoLockfile(lockPath) : undefined

  return validateCargoTomlContent(content, filePath, config, lockfile)
}

/**
 * Validate all dependencies in Cargo.toml content string.
 * @param content - The Cargo.toml file content
 * @param filePath - Path to the Cargo.toml file (used for relative path resolution)
 * @param config - Validator configuration
 * @param lockfile - Optional parsed Cargo.lock for locked version info
 * @returns Validation results for all dependencies (includes parseError if TOML is invalid)
 */
export const validateCargoTomlContent = async (
  content: string,
  filePath: string,
  config: ValidatorConfig = DEFAULT_CONFIG,
  lockfile?: CargoLockfile,
): Promise<ValidationResult> => {
  try {
    const cargoTomlDir = path.dirname(filePath)
    const toml = parseTOML(content)
    const tables = toml.body[0].body.filter((v): v is TOMLTable => v.type === 'TOMLTable')
    const dependencies = parseCargoDependencies(tables, content)
    // Filter out disabled dependencies (those with `# crates: disable-check` comment)
    const activeDependencies = dependencies.filter((dep) => !dep.disabled)
    const results = await Promise.all(
      activeDependencies.map((dep) => validateDependency(dep, cargoTomlDir, config, lockfile)),
    )

    return { filePath, dependencies: results }
  } catch (err) {
    if (err instanceof ParseError) {
      return {
        filePath,
        dependencies: [],
        parseError: new Error(`Parse error at line ${err.lineNumber}, column ${err.column}: ${err.message}`),
      }
    }
    throw err
  }
}
