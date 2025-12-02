# Elder Crates

A VSCode extension and CLI tool helping Rust developers spot outdated dependencies in `Cargo.toml` manifest files.

This is a fork of [**sparse-crates**](https://github.com/citreae535/sparse-crates) by [citreae535](https://github.com/citreae535), which itself was a fork of [**crates**](https://github.com/serayuzgur/crates) by [Seray Uzgur](https://github.com/serayuzgur).

![Elder Crates in Action](https://github.com/alfatm/elder-crates/raw/main/elder_crates_in_action.png)

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
elder-crates-cli <path-to-Cargo.toml> [options]

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
elder-crates-cli ./Cargo.toml

# Filter by name
elder-crates-cli ./Cargo.toml --filter serde

# JSON output for scripting
elder-crates-cli ./Cargo.toml --json

# Use custom registry
elder-crates-cli ./Cargo.toml --registry my-registry=https://my-registry.example.com/api/v1/crates/
```

### Exit Codes

| Code | Meaning                                 |
| ---- | --------------------------------------- |
| 0    | All dependencies are up to date         |
| 1    | Patch or minor updates available        |
| 2    | Major updates available                 |
| 3    | Errors occurred (e.g., crate not found) |

## Version Requirements

Elder Crates uses [Cargo's version requirement syntax](https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html). A dependency is considered **up-to-date** if the latest stable version satisfies the specified range.

### Default (Caret) Requirements

When you specify a version without operators (e.g., `"1.2.3"`), Cargo interprets it as a caret requirement (`^1.2.3`), allowing SemVer-compatible updates:

| Requirement | Equivalent Range  | Example Matches     |
| ----------- | ----------------- | ------------------- |
| `1.2.3`     | `>=1.2.3, <2.0.0` | 1.2.3, 1.3.0, 1.9.9 |
| `1.2`       | `>=1.2.0, <2.0.0` | 1.2.0, 1.3.0, 1.9.9 |
| `1`         | `>=1.0.0, <2.0.0` | 1.0.0, 1.5.0, 1.9.9 |
| `0.2.3`     | `>=0.2.3, <0.3.0` | 0.2.3, 0.2.9        |
| `0.2`       | `>=0.2.0, <0.3.0` | 0.2.0, 0.2.9        |
| `0.0.3`     | `>=0.0.3, <0.0.4` | 0.0.3 only          |
| `0.0`       | `>=0.0.0, <0.1.0` | 0.0.0, 0.0.9        |
| `0`         | `>=0.0.0, <1.0.0` | 0.0.0, 0.5.0, 0.9.9 |

### Status Indicators

| Symbol | Status       | Meaning                                            |
| ------ | ------------ | -------------------------------------------------- |
| ✅      | latest       | Latest stable version satisfies your requirement   |
| 🟨      | patch-behind | Patch update available outside your range          |
| 🟧      | minor-behind | Minor update available outside your range          |
| 🟥      | major-behind | Major update available outside your range          |
| ❗      | error        | Failed to fetch crate info or no matching versions |

### Examples

- `tokio = "1"` with latest `1.40.0` → ✅ (1.40.0 satisfies `>=1.0.0, <2.0.0`)
- `serde = "1.0"` with latest `1.0.210` → ✅ (1.0.210 satisfies `>=1.0.0, <2.0.0`)
- `clap = "3"` with latest `4.5.0` → 🟥 major-behind (4.5.0 doesn't satisfy `>=3.0.0, <4.0.0`)
- `rand = "0.7"` with latest `0.8.5` → 🟧 minor-behind (0.8.5 doesn't satisfy `>=0.7.0, <0.8.0`)

## VSCode Extension Configuration

- `elder-crates.useCargoCache`: If true, Cargo's index cache is searched first before the registries. Cache must be stored in the sparse format.

- `elder-crates.cratesIoIndex`: The index URL of the default crates.io registry. Change this value only if you use a remote or local mirror of crates.io. The index must use the sparse protocol. Use a file URL if the mirror is on disk.

- `elder-crates.cratesIoCache`: The index cache directory of the default crates.io registry. Change this value only if you use a remote or local mirror of crates.io. You can find the directories at CARGO_HOME/registry/index.

- `elder-crates.registries`: An array of alternate registries:
```json
{
    "name": "(Required) Registry name matching dependencies' \"registry\" key",
    "index": "(Required) Index URL (sparse protocol, supports file:// for local)",
    "cache": "(Optional) Cargo's index cache directory at CARGO_HOME/registry/index",
    "docs": "(Optional) Docs URL, used for hover links as ${docs}${name}/${version}"
}
```

## Planned Features

- Status bar items and notifications
- Parse and show dependency versions from Cargo.lock

## Thanks

- [citreae535](https://github.com/citreae535), the original author of [**sparse-crates**](https://github.com/citreae535/sparse-crates)
- [Seray Uzgur](https://github.com/serayuzgur), the original author of [**crates**](https://github.com/serayuzgur/crates)
