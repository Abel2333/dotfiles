#!/bin/bash

# Copyright (c) 2025 Abel, abelsparda@outlook.com.
#
# Licensed under the Apache License, Version 2.0 (the "License")
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writting, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# ===== Script Description =====
# This script automates Secure Boot key management and kernel signing.
# Features:
#   - Generate Platform Key (PK), Key Exchange Key (KEK), and db certificates
#   - Backuo factory keys and create custom keys
#   - Install keys into firmware (requires Setup Mode)
#   - Sign kernel or Unified Kernel Image (UKI) with db key
#
# Usage:
#   ./sb-tool.sh -g <gpg-recipient> -b <base-dir> [options]
#
# See the repository README for detailed instructions.

set -euo pipefail

# ====== Color output function ======
info() { echo -e "\033[1;32m[*]\033[0m $*"; }
success() { echo -e "\033[1;36m[✔]\033[0m $*"; }
warn() { echo -e "\033[1;33m[!]\033[0m $*"; }
error() { echo -e "\033[1;31m[x]\033[0m $*"; }

usage() {
  echo "Usage: $0 -g <gpg-recipient> -b <base-dir> [-i <kernel-image>] [--gen-keys] [--install-keys] [--sign-kernel]"
  echo
  echo "  -g   GPG recipient (e.g., user@example.com)"
  echo "  -b   Base directory for factory_config and custom_config"
  echo "  -i   Kernel image to sign (optional, auto-detect latest if omitted)"
  echo
  echo "Steps (choose one or more):"
  echo "  --gen-keys       Generate keys and certificates"
  echo "  --install-keys   Install keys into firmware (Setup Mode required)"
  echo "  --sign-kernel    Sign kernel/UKI with db key"
  exit 1
}

# ====== Parser Arguments ======
STEP_GEN=false
STEP_INSTALL=false
STEP_SIGN=false
KERNEL_IMAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
  -g)
    GPG_KEY="$2"
    shift 2
    ;;
  -b)
    BASE_DIR="$2"
    shift 2
    ;;
  -i)
    KERNEL_IMAGE="$2"
    shift 2
    ;;
  --gen-keys)
    STEP_GEN=true
    shift
    ;;
  --install-keys)
    STEP_INSTALL=true
    shift
    ;;
  --sign-kernel)
    STEP_SIGN=true
    shift
    ;;
  *) usage ;;
  esac
done

if [[ -z "${GPG_KEY:-}" || -z "${BASE_DIR:-}" ]]; then
  usage
fi

if ! $STEP_GEN && ! $STEP_INSTALL && ! $STEP_SIGN; then
  error "No step specified. Please choose at least one of --gen-keys, --install-keys, or --sign-kernel."
  usage
fi

FACTORY="$BASE_DIR/factory_config"
CUSTOM="$BASE_DIR/custom_config"

# ====== Check Commands ======
check_deps() {
  local missing=0
  local deps=(
    efi-readvar
    uuidgen
    openssl
    gpg
    cert-to-efi-sig-list
    sign-efi-sig-list
  )

  for cmd in "${deps[@]}"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      error "Missing required command: $cmd"
      missing=1
    fi
  done

  if [[ $missing -ne 0 ]]; then
    error "Please install the missing tools before running this script."
    exit 1
  fi
}

# ====== Step Functions ======

gen_keys() {
  mkdir -p "$FACTORY" "$CUSTOM"

  info "Backing up existing keys into $FACTORY ..."
  cd "$FACTORY"
  for key_type in PK KEK db dbx; do
    echo "    - Dumping $key_type"
    efi-readvar -v "$key_type" -o "${key_type}.esl" || true
  done

  info "Switching to $CUSTOM for new key generation ..."
  cd "$CUSTOM"

  info "Generating UUID ..."
  uuidgen >uuid.txt
  UUID=$(<uuid.txt)
  echo "    - UUID: $UUID"

  info "Create empty dbx ..."
  touch "${CUSTOM}/dbx.esl"

  info "Generating new certificates and encrypting private keys ..."
  PIPE=$(mktemp -u)
  mkfifo "$PIPE"
  for key_type in PK KEK db; do
    echo "    - Generating $key_type certificate and encrypted key"
    openssl req -new -x509 -newkey rsa:2048 \
      -subj "/CN=${USER}'s ${key_type}" \
      -keyout "$PIPE" \
      -out "${key_type}.crt" \
      -days 9999 \
      -noenc \
      -sha256 &
    gpg --output "${key_type}.key.gpg" \
      --recipient "${GPG_KEY}" \
      --encrypt <"$PIPE"
  done
  rm -f "$PIPE"

  info "Creating EFI Signature Lists ..."
  for key_type in PK KEK db; do
    echo "    - $key_type.esl"
    cert-to-efi-sig-list -g "$UUID" "${key_type}.crt" "${key_type}.esl"
  done

  info "Exporting DER (.cer) certificates ..."
  for key_type in PK KEK db; do
    echo "    - $key_type.cer"
    openssl x509 -outform DER -in "${key_type}.crt" -out "${key_type}.cer"
  done

  info "Combining factory and custom ESLs ..."
  cd "$BASE_DIR"
  for key_type in KEK db dbx; do
    echo "    - $key_type.esl"
    cat "${FACTORY}/${key_type}.esl" "${CUSTOM}/${key_type}.esl" >"${BASE_DIR}/${key_type}.esl"
  done
  cp "${CUSTOM}"/*.esl .

  info "Signing ESLs ..."
  # PK
  echo "    - Signing PK"
  PIPE=$(mktemp -u)
  mkfifo "$PIPE"
  gpg --decrypt "${CUSTOM}/PK.key.gpg" >"$PIPE" &
  sign-efi-sig-list -k "$PIPE" -c "${CUSTOM}/PK.crt" PK PK.esl PK.auth
  rm -f "$PIPE"

  # KEK
  echo "    - Signing KEK"
  PIPE=$(mktemp -u)
  mkfifo "$PIPE"
  gpg --decrypt "${CUSTOM}/PK.key.gpg" >"$PIPE" &
  sign-efi-sig-list -k "$PIPE" -c "${CUSTOM}/PK.crt" KEK KEK.esl KEK.auth
  rm -f "$PIPE"

  # db / dbx
  for db_type in db dbx; do
    echo "    - Signing $db_type"
    PIPE=$(mktemp -u)
    mkfifo "$PIPE"
    gpg --decrypt "${CUSTOM}/KEK.key.gpg" >"$PIPE" &
    sign-efi-sig-list -k "$PIPE" -c "${CUSTOM}/KEK.crt" "$db_type" "${db_type}.esl" "${db_type}.auth"
    rm -f "$PIPE"
  done

  success "All done. Signed ESLs and AUTH files are in $BASE_DIR"
  info "Next step:"
  info "    Reboot the machine and enter the Steup Mode."
  info "    Then, run this script with --install-keys to install the keys to firmware."
}

install_keys() {
  cd "$BASE_DIR"

  info "Installing the Key Exchange Key ..."
  sudo efi-updatevar -e -f KEK.esl KEK

  info "Installing the Database Keys ..."
  for db_type in db dbx; do
    sudo efi-updatevar -e -f "${db_type}.esl" "${db_type}"
  done

  info "Installing the Platform Key ..."
  sudo efi-updatevar -f PK.auth PK

  success "Keys have been installed into firmware successfully."
  info "Next step: run this script with --sign-kernel to sign your kernel."
}

sign_kernel() {
  cd "$BASE_DIR"

  info "Signing Kernel Image ..."
  OUT="$(dirname "$KERNEL_IMAGE")/$(basename "$KERNEL_IMAGE" .efi)-signed.efi"
  info "Input:  $KERNEL_IMAGE"
  info "Output: $OUT"

  PIPE=$(mktemp -u)
  mkfifo "$PIPE"
  gpg --decrypt "${CUSTOM}/db.key.gpg" >"$PIPE" &
  sudo sbsign --key "$PIPE" --cert "${CUSTOM}/db.crt" \
    --output "$OUT" "$KERNEL_IMAGE"
  rm -f "$PIPE"

  info "Verifying Signatures ..."
  sbverify --cert "${CUSTOM}/db.crt" "$OUT"

  success "Kernel signed successfully: $OUT"
  warn "Reminder: Secure Boot requires *every* EFI binary in the boot chain to be signed."
  info "That includes bootloaders (e.g., BOOTX64.EFI, GRUB, systemd-boot), shims, and any other EFI executables you intend to load."
  info "Unsigned components will cause boot failure under Secure Boot."
}

# ====== Process Step ======
check_deps
$STEP_GEN && gen_keys
$STEP_INSTALL && install_keys
$STEP_SIGN && sign_kernel
