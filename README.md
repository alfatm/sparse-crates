# Fancy Crates

A VSCode extension and CLI tool helping Rust developers spot outdated dependencies in `Cargo.toml` manifest files.

This is a fork of [**sparse-crates**](https://github.com/citreae535/sparse-crates) by [citreae535](https://github.com/citreae535), which itself was a fork of [**crates**](https://github.com/serayuzgur/crates) by [Seray Uzgur](https://github.com/serayuzgur).

![Fancy Crates in Action](https://github.com/alfatm/fancy-crates/raw/main/fancy-crates-in-action.png)

## Features

- Cargo's [sparse protocol](https://rust-lang.github.io/rfcs/2789-sparse-index.html) for fast index lookups
- Granular version status: ✅ latest, 🟡 patch behind, 🟠 minor behind, ❌ major behind
- Remote and local crates.io mirrors (HTTP/HTTPS/file URLs)
- Alternate registries with authentication token support
- Automatic registry detection from `.cargo/config.toml`
- Package rename support
- Detailed logs in VSCode output channel

## CLI

A standalone CLI tool is included for CI/CD pipelines and terminal usage.

### Installation

```bash
# Build the CLI
pnpm run build:cli

# Run directly
node dist/cli.cjs ./Cargo.toml
```

### Usage

```bash
fancy-crates-cli <path-to-Cargo.toml> [options]

Options:
  --filter <name>        Filter by dependency name (partial match)
  --line <num>           Filter by line number
  --show-plugin          Show output as VSCode plugin would display it
  --no-cache             Disable Cargo cache lookup
  --json                 Output results as JSON
  -v, --verbose          Verbosity level: -v warn/error, -vv info, -vvv debug
  --registry <name=url>  Add alternate registry (overrides cargo config)
```

### Examples

```bash
# Check all dependencies
fancy-crates-cli ./Cargo.toml

# Filter by name
fancy-crates-cli ./Cargo.toml --filter serde

# JSON output for scripting
fancy-crates-cli ./Cargo.toml --json

# Use custom registry
fancy-crates-cli ./Cargo.toml --registry my-registry=https://my-registry.example.com/api/v1/crates/
```

### Exit Codes

| Code | Meaning                                 |
| ---- | --------------------------------------- |
| 0    | All dependencies are up to date         |
| 1    | Patch or minor updates available        |
| 2    | Major updates available                 |
| 3    | Errors occurred (e.g., crate not found) |

## Version Requirements

Fancy Crates uses [Cargo's version requirement syntax](https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html). A dependency is considered **up-to-date** if the latest stable version satisfies the specified range.

### Exact vs Range Versions

Fancy Crates distinguishes between **exact versions** and **range versions**:

- **Exact versions** (`1.2.3`, `0.5.0`) — compared directly against latest. If you specify `1.2.3` and latest is `1.2.4`, you'll see 🟨 patch-behind.
- **Short/range versions** (`1`, `1.2`, `^1.2.3`, `~1.2.3`) — evaluated as ranges. If you specify `1` and latest is `1.9.0`, you'll see ✅ latest because `1.9.0` satisfies `>=1.0.0, <2.0.0`.

### Range Version Syntax

When you specify a short version or use operators, Cargo interprets it as a range:

| Requirement | Equivalent Range  | Example Matches     |
| ----------- | ----------------- | ------------------- |
| `1.2`       | `>=1.2.0, <2.0.0` | 1.2.0, 1.3.0, 1.9.9 |
| `1`         | `>=1.0.0, <2.0.0` | 1.0.0, 1.5.0, 1.9.9 |
| `0.2`       | `>=0.2.0, <0.3.0` | 0.2.0, 0.2.9        |
| `0.0`       | `>=0.0.0, <0.1.0` | 0.0.0, 0.0.9        |
| `0`         | `>=0.0.0, <1.0.0` | 0.0.0, 0.5.0, 0.9.9 |
| `^1.2.3`    | `>=1.2.3, <2.0.0` | 1.2.3, 1.3.0, 1.9.9 |
| `~1.2.3`    | `>=1.2.3, <1.3.0` | 1.2.3, 1.2.9        |

### Status Indicators

| Symbol | Status       | Meaning                                            |
| ------ | ------------ | -------------------------------------------------- |
| ✅      | latest       | Latest stable version satisfies your requirement   |
| 🟨      | patch-behind | Patch update available                             |
| 🟧      | minor-behind | Minor update available                             |
| 🟥      | major-behind | Major update available                             |
| ❗      | error        | Failed to fetch crate info or no matching versions |

### Examples

- `tokio = "1"` with latest `1.40.0` → ✅ (range: 1.40.0 satisfies `>=1.0.0, <2.0.0`)
- `serde = "1.0"` with latest `1.0.210` → ✅ (range: 1.0.210 satisfies `>=1.0.0, <2.0.0`)
- `serde = "1.0.200"` with latest `1.0.210` → 🟨 patch-behind (exact: 1.0.200 < 1.0.210)
- `clap = "3"` with latest `4.5.0` → 🟥 major-behind (range: 4.5.0 doesn't satisfy `>=3.0.0, <4.0.0`)
- `rand = "0.7"` with latest `0.8.5` → 🟧 minor-behind (range: 0.8.5 doesn't satisfy `>=0.7.0, <0.8.0`)
- `rand = "0.8.4"` with latest `0.8.5` → 🟨 patch-behind (exact: 0.8.4 < 0.8.5)

## VSCode Extension Configuration

- `fancy-crates.useCargoCache`: If true, Cargo's index cache is searched first before the registries. Cache must be stored in the sparse format.

- `fancy-crates.cratesIoIndex`: The index URL of the default crates.io registry. Change this value only if you use a remote or local mirror of crates.io. The index must use the sparse protocol. Use a file URL if the mirror is on disk.

- `fancy-crates.cratesIoCache`: The index cache directory of the default crates.io registry. Change this value only if you use a remote or local mirror of crates.io. You can find the directories at CARGO_HOME/registry/index.

- `fancy-crates.registries`: An array of alternate registries:
```json
{
    "name": "(Required) Registry name matching dependencies' \"registry\" key",
    "index": "(Required) Index URL (sparse protocol, supports file:// for local)",
    "cache": "(Optional) Cargo's index cache directory at CARGO_HOME/registry/index",
    "docs": "(Optional) Docs URL, used for hover links as ${docs}${name}/${version}"
}
```

## Commands

- **Fancy Crates: Refresh Dependencies** — Re-check dependencies for all visible `Cargo.toml` files
- **Fancy Crates: Reload (Clear Cache)** — Clear all caches (versions, cargo config, CLI tools) and reload the current file

## Disabling Checks

You can skip version checking for specific dependencies or entire files using comments.

### Disable a Single Dependency

Add `# crates: disable-check` comment on the dependency line:

```toml
[dependencies]
serde = "1.0"
legacy-crate = "0.1.0"  # crates: disable-check
tokio = "1"
```

### Disable All Checks in a File

Add `#! crates: disable-check` at the beginning of the file:

```toml
#! crates: disable-check
[package]
name = "my-crate"
version = "0.1.0"

[dependencies]
# All dependencies in this file will be skipped
```

Comments are case-insensitive and allow flexible spacing (e.g., `#crates:disable-check` also works).

## Planned Features

- Status bar items and notifications

## Thanks

- [citreae535](https://github.com/citreae535), the original author of [**sparse-crates**](https://github.com/citreae535/sparse-crates)
- [Seray Uzgur](https://github.com/serayuzgur), the original author of [**crates**](https://github.com/serayuzgur/crates)
