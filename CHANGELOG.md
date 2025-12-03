# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Disable check comments**: Skip version checking for specific dependencies or entire files using comments:
  - `# crates: disable-check` on a dependency line skips that crate
  - `#! crates: disable-check` at file start disables all checks in the file
- **Reload command**: New `Elder Crates: Reload (Clear Cache)` command that clears all caches and reloads the current file

## [1.1.2] - 2025-12-02

### Added

- **Cargo.lock support**: Now reads `Cargo.lock` to show the currently locked version alongside the specified requirement and latest available version.

### Changed

- **Exact version comparison**: Full versions like `"1.2.3"` are now compared directly against the latest version instead of being treated as ranges. This means `serde = "1.2.3"` with latest `1.2.4` will show as patch-behind, not latest. Short versions like `"1"` or `"1.2"` still use range semantics.

## [1.0.0] - 2025-12-02

### Added

- **CLI tool**: New standalone command-line interface for validating `Cargo.toml` files outside of VSCode.
  - Supports `--filter` to show only specific statuses (latest, patch, minor, major, error).
  - Supports `--registry` for alternate registries via command line.
  - Supports `--show-hover` for detailed version information.
  - Supports `--show-plugin` for debug output of plugin configurations.
- **Granular dependency status**: Replaced binary outdated/up-to-date with more precise indicators:
  - `✓` - Using the latest version
  - `↑` - Patch update available (1.2.3 → 1.2.4)
  - `⇡` - Minor update available (1.2.3 → 1.3.0)
  - `⇧` - Major update available (1.2.3 → 2.0.0)
  - `✗` - Error fetching version info
- **Verbose logging**: Added `-v` flag with multiple verbosity levels (error/info/debug).
- **Logger interface**: Configurable logging for both extension and CLI.
- **Test workspace**: Added example crates for testing alternate registries and various configurations.
- **CODE_STYLE.md**: Documented project coding conventions.

### Changed

- **Modular architecture**: Split codebase into three modules:
  - `core/` - Shared validation logic, parsing, and registry fetching
  - `extension/` - VSCode extension code
  - `cli/` - Command-line interface
- **Linter migration**: Replaced Rome with Biome for linting and formatting.
- **Build system**: Migrated from esbuild to Vite for bundling.
- **HTTP client**: Replaced node-fetch with undici for better performance.
- **Cargo config support**: Now reads `.cargo/config.toml` for registry configurations.

## [0.1.0] - 2023-03-23

### Added

- Support for Cargo's sparse protocol and sparse cache index.
- Support for crates.io remote and local mirrors.
- Support for alternate registries that use the sparse protocol.
- Support for package renaming.

### Changed

- Bumped minimum VSCode version from 1.45 to 1.72.
- Hover messages on the decorators are simplified.
- Logs are written to VSCode's output channel, and they are more structured and detailed.
- Replaced handwritten TOML parser with `toml-eslint-parser`.
- Replaced handwritten semver parser with `semver`.
- Changed the HTTP client library from unmaintained `request-promise` to `node-fetch`.
- Changed the linter from deprecated `tslint` to `rome`.
- Changed the bundler from `webpack` to `esbuild`.
- Changed the package manager from `npm` to `pnpm`.

### Removed

- Support for Cargo's Git index protocol and cache.
- All actions, commands, and completions.
- Decorator customizations.
- Unused dependencies and dead code.
- Status bar items are temporarily removed.
- Unit tests are removed for now.
