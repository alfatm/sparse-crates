import { readFile } from 'node:fs/promises'

import semver from 'semver'
import { ParseError, parseTOML } from 'toml-eslint-parser'
import type { TOMLTable } from 'toml-eslint-parser/lib/ast/ast.js'
import { DEFAULT_CONFIG, getRegistry } from './config.js'
import { fetchVersions } from './fetch.js'
import { parseCargoDependencies } from './parse.js'
import type {
  Dependency,
  DependencyStatus,
  DependencyValidationResult,
  ValidationResult,
  ValidatorConfig,
} from './types.js'

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
 * Compute dependency status based on the version specified in Cargo.toml and available versions.
 *
 * The logic is:
 * 1. If latestStable satisfies the specified range, the dependency is up-to-date ("latest")
 * 2. Otherwise, compare the minimum version from the range against latestStable to determine
 *    how far behind the specification is
 *
 * This correctly handles short version formats like "0", "1", "1.0" which represent ranges:
 * - "0" means >=0.0.0 <1.0.0, so if latestStable is 0.5.0, it's still "latest"
 * - "1" means >=1.0.0 <2.0.0, so if latestStable is 1.9.0, it's still "latest"
 */
export const computeStatus = (
  specifiedRange: semver.Range,
  latestStable: semver.SemVer | undefined,
  latest: semver.SemVer | undefined,
): DependencyStatus => {
  if (!latest) {
    return 'error'
  }

  // Compare against latest stable if available, otherwise against latest (which may be prerelease)
  const targetVersion = latestStable ?? latest

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
 * Find the best matching version for a given semver range.
 * Unlike semver.maxSatisfying, this properly handles Cargo's version requirements.
 */
const findResolvedVersion = (versions: semver.SemVer[], range: semver.Range): semver.SemVer | null => {
  // Filter versions that satisfy the range and return the highest one
  const matching = versions.filter((v) => range.test(v))
  // versions are already sorted descending, so first match is highest
  return matching[0] ?? null
}

const validateDependency = async (dep: Dependency, config: ValidatorConfig): Promise<DependencyValidationResult> => {
  try {
    const registry = getRegistry(dep.registry, config)
    const versions = await fetchVersions(dep.name, registry, config.useCargoCache, config.fetchOptions)

    versions.sort(semver.compareBuild).reverse()
    const resolved = findResolvedVersion(versions, dep.version)
    const latestStable = versions.find((v) => v.prerelease.length === 0)
    const latest = versions[0]

    return {
      dependency: dep,
      resolved,
      latestStable,
      latest,
      status: computeStatus(dep.version, latestStable, latest),
    }
  } catch (err) {
    return {
      dependency: dep,
      resolved: null,
      latestStable: undefined,
      latest: undefined,
      error: err instanceof Error ? err : new Error(String(err)),
      status: 'error',
    }
  }
}

export const validateCargoToml = async (
  filePath: string,
  config: ValidatorConfig = DEFAULT_CONFIG,
): Promise<ValidationResult> => {
  const content = await readFile(filePath, 'utf-8')
  return validateCargoTomlContent(content, filePath, config)
}

export const validateCargoTomlContent = async (
  content: string,
  filePath: string,
  config: ValidatorConfig = DEFAULT_CONFIG,
): Promise<ValidationResult> => {
  try {
    const toml = parseTOML(content)
    const tables = toml.body[0].body.filter((v): v is TOMLTable => v.type === 'TOMLTable')
    const dependencies = parseCargoDependencies(tables)
    const results = await Promise.all(dependencies.map((dep) => validateDependency(dep, config)))

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
