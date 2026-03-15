#!/usr/bin/env bash

# Ensure gnome-keyring-daemon is running
if ! pgrep -f "gnome-keyring-daemon" > /dev/null; then
    eval "$(gnome-keyring-daemon --start --daemonize --components=secrets,ssh,pkcs11)"
else
    # If running, set control path (standard location)
    export GNOME_KEYRING_CONTROL="/run/user/$(id -u)/keyring/control"

    # Set SSH socket if it exists
    if [ -S "/run/user/$(id -u)/keyring/ssh" ]; then
        export SSH_AUTH_SOCK="/run/user/$(id -u)/keyring/ssh"
    fi

    # Get the PID (always do this, regardless of SSH socket)
    export GNOME_KEYRING_PID=$(pgrep -f "gnome-keyring-daemon" | head -1)
fi

# Export to systemd user environment (so applications launched from .desktop can see it)
systemctl --user import-environment GNOME_KEYRING_CONTROL SSH_AUTH_SOCK GNOME_KEYRING_PID

# Update D-Bus environment
dbus-update-activation-environment --systemd GNOME_KEYRING_CONTROL SSH_AUTH_SOCK GNOME_KEYRING_PID 2>/dev/null || true
