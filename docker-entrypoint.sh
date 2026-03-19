#!/bin/sh
set -e

# Copy mounted Qwen credentials (read-only) to app-user-owned directory.
# This ensures the app can read them regardless of host file ownership.
MOUNT_DIR="/mnt/qwen-creds"
TARGET_DIR="/home/app/.qwen"

if [ -d "$MOUNT_DIR" ]; then
  cp -a "$MOUNT_DIR"/. "$TARGET_DIR"/
  chown -R app:app "$TARGET_DIR"
fi

# Drop to app user and exec the CMD
exec su-exec app "$@"
