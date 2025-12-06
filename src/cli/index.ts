#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Command } from 'commander'
import { toJsonWithSummary } from '../api/index'
import type { DependencyValidationResult, Logger, RegistryConfig, ValidatorConfig } from '../core/index'
import {
  DEFAULT_CONFIG,
  DOCS_RS_URL,
  formatDependencyResult,
  getSourceReplacement,
  loadCargoConfig,
  mergeRegistries,
  SYMBOL_ERROR,
  SYMBOL_LATEST,
  SYMBOL_MAJOR_BEHIND,
  SYMBOL_MINOR_BEHIND,
  SYMBOL_PATCH_BEHIND,
  validateCargoToml,
} from '../core/index'

/**
 * Format a single dependency result for CLI output.
 * Uses the same formatting as VSCode extension.
 */
function formatResult(result: DependencyValidationResult, lineContent: string, showHover: boolean): string {
  const { decoration, hoverMarkdown } = formatDependencyResult(result, DOCS_RS_URL.toString())
  const line = result.dependency.line + 1
  const registry = result.dependency.registry ? ` (${result.dependency.registry})` : ''

  const output = [`L${line}: ${lineContent.trim()}${registry}    ${decoration}`]

  if (showHover) {
    output.push('', 'Hover info:', hoverMarkdown, '', '─'.repeat(50))
  }

  return output.join('\n')
}

function parseRegistry(value: string, previous: RegistryConfig[]): RegistryConfig[] {
  const parts = value.split('=')
  const name = parts[0]
  const index = parts.slice(1).join('=') // Handle URLs with = in them
  if (name && index) {
    previous.push({ name, index })
  }
  return previous
}

interface Options {
  filter?: string
  line?: string
  showPlugin: boolean
  cache: boolean
  json: boolean
  registry: RegistryConfig[]
  verbose: number
}

const program = new Command()

program
  .name('fancy-crates-cli')
  .description('Validate Cargo.toml dependencies and check for updates')
  .argument('<path>', 'Path to Cargo.toml file')
  .option('--filter <name>', 'Filter by dependency name (can be partial match)')
  .option('--line <num>', 'Filter by line number')
  .option('--show-plugin', 'Show output as VSCode plugin would display it', false)
  .option('--no-cache', 'Disable Cargo cache lookup')
  .option('--json', 'Output results as JSON', false)
  .option('-v, --verbose', 'Verbosity level: -v error, -vv info, -vvv debug', (_, prev) => prev + 1, 0)
  .option(
    '--registry <name=url>',
    'Add alternate registry (format: name=index_url). Overrides registries from cargo config.',
    parseRegistry,
    [],
  )
  .addHelpText(
    'after',
    `
Registries are automatically loaded from cargo config (cargo config get registries).
Use --registry to override or add additional registries.

Examples:
  $ fancy-crates-cli ./Cargo.toml
  $ fancy-crates-cli ./Cargo.toml --filter external2 --show-plugin
  $ fancy-crates-cli ./Cargo.toml --line 38 --show-plugin
  $ fancy-crates-cli ./Cargo.toml --no-cache
  $ fancy-crates-cli ./Cargo.toml --registry public-registry=http://localhost:8000/api/v1/crates/`,
  )
  .action(main)

async function main(pathArg: string, options: Options) {
  const filePath = resolve(pathArg)
  const useCache = options.cache
  const jsonOutput = options.json
  const showPlugin = options.showPlugin
  const filterName = options.filter
  const cliRegistries = options.registry

  // Validate --line option
  let filterLine: number | undefined
  if (options.line) {
    filterLine = Number.parseInt(options.line, 10)
    if (Number.isNaN(filterLine) || filterLine < 1) {
      console.error('Error: --line must be a positive integer')
      process.exit(1)
    }
  }

  // Load cargo config (registries and source replacement)
  const cargoDir = dirname(filePath)
  const cargoConfig = await loadCargoConfig(cargoDir)

  // Merge registries: CLI args override cargo config
  const registries = mergeRegistries(cargoConfig.registries, cliRegistries)

  // Build source replacement config if crates-io is replaced
  const sourceReplacement = getSourceReplacement(cargoConfig)

  const verbosity = options.verbose
  const noop = () => {
    /* noop */
  }
  const logger: Logger = {
    debug: verbosity >= 3 ? (msg) => console.log(`[debug] ${msg}`) : noop,
    info: verbosity >= 2 ? (msg) => console.log(`[info] ${msg}`) : noop,
    warn: verbosity >= 1 ? (msg) => console.warn(`[warn] ${msg}`) : noop,
    error: verbosity >= 1 ? (msg) => console.error(`[error] ${msg}`) : noop,
  }

  const config: ValidatorConfig = {
    ...DEFAULT_CONFIG,
    useCargoCache: useCache,
    registries,
    sourceReplacement,
    fetchOptions: { logger },
  }

  // Read file content for line display
  let fileLines: string[] = []
  try {
    fileLines = readFileSync(filePath, 'utf-8').split('\n')
  } catch {
    // ignore
  }

  console.log(`Validating: ${filePath}`)
  console.log(`Cache: ${useCache ? 'enabled' : 'disabled'}`)
  if (sourceReplacement) {
    console.log(`Mirror: crates.io -> ${sourceReplacement.index}`)
  }
  if (registries.length > 0) {
    console.log(`Registries: ${registries.map((r) => r.name).join(', ')}`)
  }
  if (filterName) {
    console.log(`Filter: name contains "${filterName}"`)
  }
  if (filterLine) {
    console.log(`Filter: line ${filterLine}`)
  }
  console.log('')

  try {
    const result = await validateCargoToml(filePath, config)

    if (result.parseError) {
      console.error(`Parse error: ${result.parseError.message}`)
      process.exit(1)
    }

    // Apply filters
    let deps = result.dependencies
    if (filterName) {
      const filter = filterName.toLowerCase()
      deps = deps.filter((d) => d.dependency.name.toLowerCase().includes(filter))
    }
    if (filterLine) {
      deps = deps.filter((d) => d.dependency.line + 1 === filterLine)
    }

    if (deps.length === 0) {
      console.log('No dependencies match the filter.')
      process.exit(0)
    }

    const latest = deps.filter((d) => d.status === 'latest')
    const patchBehind = deps.filter((d) => d.status === 'patch-behind')
    const minorBehind = deps.filter((d) => d.status === 'minor-behind')
    const majorBehind = deps.filter((d) => d.status === 'major-behind')
    const errors = deps.filter((d) => d.status === 'error')

    if (jsonOutput) {
      // Use API's JSON formatter for consistent output
      const jsonResult = toJsonWithSummary({ ...result, dependencies: deps })
      console.log(JSON.stringify(jsonResult, null, 2))
    } else {
      console.log(`Found ${deps.length} dependencies:\n`)

      if (latest.length > 0) {
        console.log(`${SYMBOL_LATEST} Latest (${latest.length}):`)
        for (const r of latest) {
          const lineContent = fileLines[r.dependency.line] || ''
          console.log(formatResult(r, lineContent, showPlugin))
        }
        console.log('')
      }

      if (patchBehind.length > 0) {
        console.log(`${SYMBOL_PATCH_BEHIND} Patch behind (${patchBehind.length}):`)
        for (const r of patchBehind) {
          const lineContent = fileLines[r.dependency.line] || ''
          console.log(formatResult(r, lineContent, showPlugin))
        }
        console.log('')
      }

      if (minorBehind.length > 0) {
        console.log(`${SYMBOL_MINOR_BEHIND} Minor behind (${minorBehind.length}):`)
        for (const r of minorBehind) {
          const lineContent = fileLines[r.dependency.line] || ''
          console.log(formatResult(r, lineContent, showPlugin))
        }
        console.log('')
      }

      if (majorBehind.length > 0) {
        console.log(`${SYMBOL_MAJOR_BEHIND} Major behind (${majorBehind.length}):`)
        for (const r of majorBehind) {
          const lineContent = fileLines[r.dependency.line] || ''
          console.log(formatResult(r, lineContent, showPlugin))
        }
        console.log('')
      }

      if (errors.length > 0) {
        console.log(`${SYMBOL_ERROR} Errors (${errors.length}):`)
        for (const r of errors) {
          const lineContent = fileLines[r.dependency.line] || ''
          console.log(formatResult(r, lineContent, showPlugin))
        }
        console.log('')
      }

      console.log('---')
      console.log(
        `Summary: ${latest.length} latest, ${patchBehind.length} patch, ${minorBehind.length} minor, ${majorBehind.length} major, ${errors.length} errors`,
      )
    }

    // Exit with error code based on severity
    if (errors.length > 0) {
      process.exit(3)
    }
    if (majorBehind.length > 0) {
      process.exit(2)
    }
    if (minorBehind.length > 0 || patchBehind.length > 0) {
      process.exit(1)
    }
  } catch (err) {
    console.error(`Error: ${err}`)
    process.exit(1)
  }
}

program.parse()
