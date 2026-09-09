#!/bin/sh
# Mounted volumes (Fly, Render, docker bind mounts) arrive owned by root, so fix
# ownership before dropping privileges. The library may legitimately be
# read-only, so failures there are not fatal.
set -e

DATA_DIR="${AUDIOSHELF_DATA:-/data}"
LIBRARY_DIR="${AUDIOSHELF_LIBRARY:-/library}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" "$LIBRARY_DIR" 2>/dev/null || true
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  chown node:node "$LIBRARY_DIR" 2>/dev/null || true
  exec su-exec node "$@"
fi

exec "$@"
