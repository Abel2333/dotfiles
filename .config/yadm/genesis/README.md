# Genesis

A small bootstrap tool to install packages and deploy system configuration files on Linux.

## Features

- Cross-distro package mapping (Debian/Ubuntu/Arch/Gentoo)
- Multiple install methods: system package manager, cargo, local scripts
- Post-install commands per package
- Config file deployment with optional sudo, ownership, and backups
- One-time sudo prompt for a full task chain

## Requirements

- Python 3
- `sudo` for system installs and privileged config deployment

## Quick Start

1. Install Python dependencies:

```sh
python3 genesis.py
```

By default this runs all tasks with system installs.

## Usage

```sh
python3 genesis.py --task all --mode system
```

Options:
- `--task`: `install` | `config` | `all` (default: `all`)
- `--mode`: `system` | `source` (default: `system`)

## Package Configuration

All package lists and mapping live in a single file:

`packages/packages.toml`

Example:

```toml
install = ["git", "gcc", "curl", "make", "zsh", "neovim", "ripgrep", "fzf", "fd", "keyd"]

[packages.git]
arch = { method = "system", name = "git" }
debian = { method = "system", name = "git" }
ubuntu = { method = "system", name = "git" }
gentoo = { method = "system", name = "dev-vcs/git" }

[packages.rustup]
gentoo = { method = "system", name = "dev-util/rustup", post = ["rustup-init-gentoo --symlink"] }
```

Supported methods:
- `system`: system package manager (apt/pacman/emerge/etc.)
- `cargo`: `cargo install <name>`
- `script`: run a local script from `scripts/`

`post = ["..."]` runs after the package is installed.

## Local Script Installers

Place scripts under:

`scripts/`

Then reference them in `packages/packages.toml`:

```toml
[packages.rustup]
debian = { method = "script", script = "rustup.sh", args = ["-y"] }
ubuntu = { method = "script", script = "rustup.sh", args = ["-y"] }
```

## Config Deployment

Config deployment uses `configs/manifest.toml`:

```toml
[[files]]
src = "keyd/default.conf"
dest = "/etc/keyd/default.conf"
mode = "0644"
owner = "root"
group = "root"
backup = true
```

Files live under:

`configs/`

## TODO

- Test current setup on Gentoo
- Add installation scripts for more packages
- Add script signing and verification
