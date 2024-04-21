#!/bin/bash
#
# Take a screenshot
grim /tmp/screen_locked.png

# Pixellate it 10x
mogrify -scale 10% -scale 1000% -blur 0x8 /tmp/screen_locked.png

# Lock screen displaying this image
swaylock --inside-color f5deb3 \
	--ring-color 66cdaa \
	--key-hl-color 81a1c1 \
	--ring-clear-color 84ffff \
	--ring-ver-color 3b8eea \
	--ring-wrong-color 8b0000 \
	--image=/tmp/screen_locked.png
