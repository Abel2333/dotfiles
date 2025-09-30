#!/bin/bash

if [ $# -eq 0 ]; then
    exit 1
fi

PROCESS_NAME="$1"

if pgrep -x "$PROCESS_NAME" > /dev/null; then
    pkill -x "$PROCESS_NAME"

    sleep 1

    if pgrep -x "$PROCESS_NAME" > /dev/null; then
        pkill -9 -x "$PROCESS_NAME"
        sleep 1
        if pgrep -x "$PROCESS_NAME" > /dev/null; then
            exit 1
        fi
    else
        exit 1
    fi
else
    if command -v "$PROCESS_NAME" > /dev/null; then
        "$PROCESS_NAME" &

        sleep 1
        if ! pgrep -x "$PROCESS_NAME" > /dev/null; then
            exit 1
        fi
    else
        exit 1
    fi
fi

exit 0
