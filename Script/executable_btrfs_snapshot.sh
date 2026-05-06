#! /usr/bin/env bash
set -euo pipefail

# ============
#  Configure
# ============
SNAP_ROOT="/mnt/backup"
SYS_SUBVOL="$(findmnt -no TARGET /)"

KEEP=5
LOG_FILE="/var/log/btrfs-snapshot.log"
LOCK_FILE="/run/btrfs-snapshot.lock"
MIN_FREE_GB=10

DATE=$(date +"%Y-%m-%d_%H-%M-%S")

# ================
#  Tool Functions
# ================
log() {
    echo "[$(date '+%F %T')] $*" | tee -a "$LOG_FILE"
}

cleanup_lock() {
    rm -f "$LOCK_FILE"
}
trap cleanup_lock EXIT

rotate_snapshots() {
    mapfile -t snaps < <(ls -1dt "$SNAP_ROOT"/* 2>/dev/null || true)

    local count=0
    for s in "${snaps[@]}"; do
        count=$((count+1))
        if [ "$count" -gt "$KEEP" ]; then
            log "Deleting old snapshot: $s"
            btrfs subvolume delete "$s"
        fi
    done
}

# ========================
#  Concurrency Protection
# ========================
if [ -e "$LOCK_FILE" ]; then
    log "ERROR: snapshot already running."
    exit 1
fi
touch "$LOCK_FILE"

# ===========
#  Pre-check
# ===========
mkdir -p "$SNAP_ROOT"

FREE_GB=$(df -BG --output=avail "$SNAP_ROOT" | tail -1 | tr -dc '0-9')
if [ "$FREE_GB" -lt "$MIN_FREE_GB" ]; then
    log "ERROR: not enough free space (${FREE_GB}G < ${MIN_FREE_GB}G)"
    exit 1
fi

command -v btrfs >/dev/null || { log "ERROR: btrfs tool not found"; exit 1; }

# ========================
#  Create System Snapshot
# ========================
SYS_SNAP="${SNAP_ROOT}/sys_${DATE}"
log "Creating system snapshot: $SYS_SNAP"
btrfs subvolume snapshot -r "$SYS_SUBVOL" "$SYS_SNAP"

# ======================
#  Rotate old snapshots
# ======================
log "Rotating system snapshots (keep $KEEP)"
rotate_snapshots

btrfs filesystem sync "$SNAP_ROOT"

log "Snapshot job finished successfully."
