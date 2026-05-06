#!/bin/bash
set -euo pipefail

usage() {
    echo "Usage: $0 -k <key.gpg> -c <cert.crt> -i <input.efi> -o <output.efi>"
    echo "  -k   GPG encrypted private key file (e.g., db.key.gpg)"
    echo "  -c   Corresponding certificate file (e.g., db.crt)"
    echo "  -i   Input UKI file (Unsigned)"
    echo "  -o   Output UKI file (Signed)"
    exit 1
}

# Parse arguments
while getopts "k:c:i:o:" opt; do
  case $opt in
    k) KEYFILE="$OPTARG" ;;
    c) CERTFILE="$OPTARG" ;;
    i) INPUT="$OPTARG" ;;
    o) OUTPUT="$OPTARG" ;;
    *) usage ;;
  esac
done

if [[ -z "${KEYFILE:-}" || -z "${CERTFILE:-}" || -z "${INPUT:-}" || -z "${OUTPUT:-}" ]]; then
    usage
fi

FIFO="key_pipe"

# Cleanup function: delete FIFO on exit
cleanup() {
    [[ -p "$FIFO" ]] && rm -f "$FIFO"
}
trap cleanup EXIT INT TERM

# Create FIFO
mkfifo -m 600 "$FIFO"

# Decrypt and write into FIFO
gpg --decrypt "$KEYFILE" > "$FIFO" &

# Use FIFO as the key input
sudo sbsign --key "$FIFO" \
            --cert "$CERTFILE" \
            --output "$OUTPUT" \
            "$INPUT"

echo -e "\033[1;32mSigned:\033[0m $INPUT → $OUTPUT"
