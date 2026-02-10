#!/usr/bin/env bash
set -euo pipefail

TMPDIR="${XDG_RUNTIME_DIR:-/tmp}"
TMPIMG="$(mktemp --tmpdir="$TMPDIR" swaylock.XXXXXX.png)"
LOGFILE="${HOME}/.cache/sway/fuzzy_lock.log"
mkdir -p "$(dirname "$LOGFILE")"

echo "$(date --iso-8601=seconds) fuzzy_lock start" >> "$LOGFILE"

# capture full screen
grim "$TMPIMG"

# pixelate + blur + subtle darken using ImageMagick v7 (magick)
PIXEL_SCALE=10
BLUR_RADIUS=6
magick "$TMPIMG" -scale "${PIXEL_SCALE}%" -scale 1000% -blur 0x${BLUR_RADIUS} \
  -fill '#00000088' -colorize 18% "$TMPIMG"

# optional vignette (uncomment if desired)
# magick "$TMPIMG" -vignette 0x0.6 "$TMPIMG"

# improved color palette for indicator
INSIDE_COLOR="0f172088"
RING_COLOR="7dd3fc"
KEY_HL_COLOR="e6eef8"
RING_CLEAR="34d399"
RING_VER="60a5fa"
RING_WRONG="ef4444"
LINE_COLOR="0b1220"
TEXT_COLOR="e6eef8"

swaylock \
  --image="$TMPIMG" \
  --indicator-idle-visible \
  --indicator-radius 92 \
  --indicator-thickness 14 \
  --inside-color "$INSIDE_COLOR" \
  --ring-color "$RING_COLOR" \
  --key-hl-color "$KEY_HL_COLOR" \
  --ring-clear-color "$RING_CLEAR" \
  --ring-ver-color "$RING_VER" \
  --ring-wrong-color "$RING_WRONG" \
  --line-color "$LINE_COLOR" \
  --text-color "$TEXT_COLOR" \
  --font "Noto Sans" \
  --font-size 18 \
  --show-failed-attempts

# cleanup
rm -f "$TMPIMG"
echo "$(date --iso-8601=seconds) fuzzy_lock end" >> "$LOGFILE"
