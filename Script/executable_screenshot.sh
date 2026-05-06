#!/bin/bash
#
# Set the directory
output_dir="$HOME/Pictures/Screenshots"
mkdir -p "$output_dir"

# File name
timestamp=$(date +%F-%H%M%S)
output="$output_dir/$timestamp.png"

# Screenshot and copy to clipboard
if grim -g "$(slurp)" - | tee "$output" | wl-copy; then
  notify-send "Screenshot completed" "Saved to $output and copied to clipboard"
else
  notify-send "Screenshot failed" "Could not save or copy screenshot"
  exit 1
fi
