#!/usr/bin/env bash

set -euo pipefail

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd git
require_cmd make

repo_url="https://github.com/neovim/neovim"
repo_dir="$(mktemp -d)"
trap 'rm -rf "${repo_dir}"' EXIT

git clone --filter=blob:none "${repo_url}" "${repo_dir}"
git -C "${repo_dir}" checkout stable

make -C "${repo_dir}" \
  CMAKE_INSTALL_PREFIX="${HOME}/.local" \
  CMAKE_BUILD_TYPE=Release \
  -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"

make -C "${repo_dir}" install
