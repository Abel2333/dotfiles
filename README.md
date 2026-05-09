# Dotfiles

This repository contains my personal dotfiles managed with [chezmoi](https://www.chezmoi.io/).
The current desktop setup is centered around **niri + KDE** on a **Wayland** workflow, with
support for **Gentoo**, **Fedora**, and **WSL2 on Windows**.

## Overview

- **Dotfile manager**: [chezmoi](https://www.chezmoi.io/)
- **Platforms**: Gentoo Linux, Fedora Linux, Windows with WSL2
- **Display stack**: Wayland
- **Compositor / WM**: [niri](https://github.com/YaLTeR/niri)
- **Desktop environment**: KDE / Plasma
- **Terminal**: [Kitty](https://sw.kovidgoyal.net/kitty/)
- **Shells**: [Zsh](https://www.zsh.org/) and [Nushell](https://www.nushell.sh/)
- **Editor**: [Neovim](https://neovim.io/)
- **File manager**: [Yazi](https://yazi-rs.github.io/)
- **Status bar**: [Waybar](https://github.com/Alexays/Waybar)
- **Notifications**: [Mako](https://github.com/emersion/mako)
- **Launcher**: [Wofi](https://hg.sr.ht/~scoopta/wofi)

## Notes

- `niri` is the primary window-management setup in this repo.
- Some older or secondary configs are still kept here as references, including `hypr`-related files.
- A few files use chezmoi templates so values can vary per machine, such as host-specific font sizes or home-directory-dependent paths.
- Some machine-local files are tracked with chezmoi's `create_` behavior so they are copied to a new machine once and not overwritten afterward.

## Prerequisites

Before applying this repo on a new machine, make sure these basics are available:

- `git`
- `chezmoi`
- `gpg` for encrypted files
- the core programs you expect to use from this repo, such as `niri`, `kitty`, `zsh`, `nushell`, `neovim`, and `yazi`

Platform-specific packages are intentionally not exhaustively listed here, since this repo is used across Gentoo, Fedora, and WSL2.

## Bootstrap

Typical first-time setup flow:

1. Install `git`, `chezmoi`, and `gpg`.
2. Initialize the dotfiles repo with chezmoi.
3. Review the generated diff if needed.
4. Apply the configuration.
5. Install any application-level dependencies referenced by these dotfiles.

Initialize the repo with chezmoi:

```bash
chezmoi init https://github.com/<your-user>/<your-repo>.git
chezmoi apply
```

If the repo is already cloned locally:

```bash
chezmoi init --source ~/.local/share/chezmoi
chezmoi apply
```

## Repository Layout

- `private_dot_config/`: application configs
- `private_dot_ssh/`: SSH-related files
- `private_dot_gnupg/`: GnuPG-related files
- `Script/`: helper scripts
- `dot_codex/`: Codex-related configuration

## Machine-specific Configuration

When a config needs to vary between machines, use one of these patterns:

- Prefer the target program's own features first, such as `~`, include support, or native variables.
- Use chezmoi templates when the target program does not support a portable form and the generated value depends on the machine.
- Use `chezmoi add --create` or the `create_` attribute for files that should be created on first setup but left unmanaged afterward.
