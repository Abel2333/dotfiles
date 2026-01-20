#!/bin/bash

# ==============================================================================
# GPG COLD BACKUP SCRIPT
# Exports Public, Secret (Master+Sub), and Subkeys-only to a TAR.ZST.GPG archive.
# ==============================================================================

# Exit immediately if a command exits with a non-zero status
set -e

# --- Visual Styling (ANSI Escape Codes) ---
BOLD='\033[1m'
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper function for logging
log_info() {
    echo -e "${BLUE}${BOLD}[BACKUP]${NC} $1"
}

log_success() {
    echo -e "${GREEN}${BOLD}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}${BOLD}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}${BOLD}[ERROR]${NC} $1"
}

#Header
echo -e "${CYAN}======================================================${NC}"
echo -e "${CYAN}${BOLD}           GPG KEY BACKUP UTILITY           ${NC}"
echo -e "${CYAN}======================================================${NC}"

# 1. List Keys
log_info "Scanning local GPG keys..."
echo -e "${CYAN}------------------------------------------------------${NC}"
gpg --list-keys --keyid-format LONG
echo -e "${CYAN}------------------------------------------------------${NC}"

# 2. Input Key ID
echo -e "${BOLD}Step 1: Select Key${NC}"
read -p "Please enter the GPG Key ID or Email to backup: " KEY_ID

# Validation: Check if input is empty
if [ -z "$KEY_ID" ]; then
    log_error "Input cannot be empty. Exiting."
    exit 1
fi

# Validation: Check if key exists
if ! gpg --list-keys "$KEY_ID" > /dev/null 2>&1; then
    log_error "Key ID '$KEY_ID' not found in keyring. Exiting."
    exit 1
fi

# 3. Determine Directory Name (Tag)
DEFAULT_TAG=$(echo "$KEY_ID" | cut -d@ -f1)
if [ "$DEFAULT_TAG" == "$KEY_ID" ]; then
    DEFAULT_TAG="${KEY_ID: -8}"
fi

echo ""
echo -e "${BOLD}Step 2: Naming${NC}"
read -p "Enter a tag for the backup folder (Default: $DEFAULT_TAG): " USER_TAG

if [ -z "$USER_TAG" ]; then
    USER_TAG="$DEFAULT_TAG"
fi

# 4. Setup Variables
DATE=$(date +%Y%m%d)
BACKUP_DIR_NAME="gpg_backup_${USER_TAG}_${DATE}"
TEMP_DIR="./${BACKUP_DIR_NAME}"
OUTPUT_FILE="${BACKUP_DIR_NAME}.tar.zst.gpg"

echo ""
echo -e "${BOLD}Configuration Summary:${NC}"
echo -e "  Target Key  : ${CYAN}${KEY_ID}${NC}"
echo -e "  Temp Folder : ${CYAN}${TEMP_DIR}/${NC}"
echo -e "  Output File : ${GREEN}${OUTPUT_FILE}${NC}"
echo ""
read -p "Press [Enter] to proceed or [Ctrl+C] to cancel..."

# ================= Execution Start =================

log_info "Creating temporary directory..."
mkdir -p "${TEMP_DIR}"

# Export Public Key
log_info "Exporting Public Key..."
gpg --armor --export "${KEY_ID}" > "${TEMP_DIR}/public_key.asc"

# --- CHECK MASTER KEY STATUS ---
# Check if output contains 'sec#' which means the secret key is offline/stub
IS_OFFLINE=$(gpg --list-secret-keys "${KEY_ID}" | grep -q "sec#" && echo "yes" || echo "no")

if [ "$IS_OFFLINE" == "yes" ]; then
    echo ""
    log_warn "Detected Offline Master Key (sec#)."
    log_warn "Skipping 'Revocation Certificate' (Requires Master Key)."
    log_info "Exporting Master Key STUB (Structure only, no secret)..."

    # Export stub only
    gpg --armor --export-secret-keys "${KEY_ID}" > "${TEMP_DIR}/secret_master_stub.asc"
else
    # Main private key online, perform a full backup
    echo ""
    log_info "Master Key is ONLINE."
    log_info "Exporting MASTER Secret Keys (Keep this safe!)..."
    gpg --armor --export-secret-keys "${KEY_ID}" > "${TEMP_DIR}/secret_master_all.asc"

    # Generate Revocation Cert
    log_warn "Generating Revocation Certificate..."
    echo -e "${YELLOW}>>> INTERACTION REQUIRED: Select '1' and enter 'Backup' description. <<<${NC}"
    echo "Press [Enter] to launch GPG gen-revoke..."
    read
    gpg --output "${TEMP_DIR}/revocation_cert.asc" --gen-revoke "${KEY_ID}"
fi

# Export Subkeys Only
log_info "Exporting Subkeys ONLY (For daily use)..."
gpg --armor --export-secret-subkeys "${KEY_ID}" > "${TEMP_DIR}/secret_subkeys_only.asc"

# Compress and Encrypt
echo ""
log_info "Packaging and Encrypting..."
log_warn "A GPG pinentry prompt will appear."
echo -e "${BOLD}Please enter a STRONG PASSWORD to protect this archive.${NC}"

# Pipe logic: tar -> zstd -> gpg (symmetric) -> file
tar -I zstd -cf - "${TEMP_DIR}" | gpg -c -o "${OUTPUT_FILE}"

# Cleanup
log_info "Cleaning up temporary unencrypted files..."
rm -rf "${TEMP_DIR}"

# Summary
echo ""
echo -e "${CYAN}======================================================${NC}"
log_success "Backup Complete!"
echo -e "File generated: ${GREEN}${BOLD}${OUTPUT_FILE}${NC}"
echo -e "${RED}${BOLD}IMPORTANT:${NC} Store this file offline (USB/YubiKey). Do not upload to cloud."
echo -e "${CYAN}======================================================${NC}"
