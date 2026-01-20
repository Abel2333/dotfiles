#!/usr/bin/env bash

set -euo pipefail

is_wsl() {
  [[ -n "${WSL_INTEROP-}" ]] && return 0
  [[ -n "${WSL_DISTRO_NAME-}" ]] && return 0
  grep -qi "microsoft" /proc/version 2>/dev/null
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

is_musl() {
  if command -v ldd >/dev/null 2>&1; then
    ldd --version 2>&1 | grep -qi "musl" && return 0
  fi
  ls /lib/ld-musl-*.so* >/dev/null 2>&1
}

arm_is_hf() {
  [[ -e /lib/ld-linux-armhf.so.3 ]] && return 0
  [[ -e /lib/arm-linux-gnueabihf/ld-linux-armhf.so.3 ]]
}

sha256_check() {
  local file="$1"
  local expected="$2"
  if command -v sha256sum >/dev/null 2>&1; then
    echo "${expected}  ${file}" | sha256sum -c -
  elif command -v shasum >/dev/null 2>&1; then
    echo "${expected}  ${file}" | shasum -a 256 -c -
  else
    echo "Missing sha256 checker (sha256sum or shasum)" >&2
    exit 1
  fi
}

require_cmd curl

if is_wsl; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  exit 0
fi

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"

case "${os}" in
  linux) ;;
  *) echo "Unsupported OS: ${os}" >&2; exit 1 ;;
esac

case "${arch}" in
  x86_64)
    if is_musl; then
      target_triple="x86_64-unknown-linux-musl"
    else
      target_triple="x86_64-unknown-linux-gnu"
    fi
    ;;
  aarch64|arm64)
    if is_musl; then
      target_triple="aarch64-unknown-linux-musl"
    else
      target_triple="aarch64-unknown-linux-gnu"
    fi
    ;;
  armv7l|armv7|armv8l)
    if arm_is_hf; then
      target_triple="armv7-unknown-linux-gnueabihf"
    else
      echo "Unsupported armv7 ABI (need hard-float for armv7-unknown-linux-gnueabihf)" >&2
      exit 1
    fi
    ;;
  armv6l|armv6|arm)
    if arm_is_hf; then
      target_triple="arm-unknown-linux-gnueabihf"
    else
      target_triple="arm-unknown-linux-gnueabi"
    fi
    ;;
  *) echo "Unsupported architecture: ${arch}" >&2; exit 1 ;;
esac

base_url="https://static.rust-lang.org/rustup/dist/${target_triple}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

echo "Using rustup target triple: ${target_triple}"

installer="${tmp_dir}/rustup-init"
checksum_file="${tmp_dir}/rustup-init.sha256"

curl -sSfL "${base_url}/rustup-init" -o "${installer}"
curl -sSfL "${base_url}/rustup-init.sha256" -o "${checksum_file}"

expected_sha="$(cut -d ' ' -f1 < "${checksum_file}")"
sha256_check "${installer}" "${expected_sha}"

chmod +x "${installer}"
"${installer}"
