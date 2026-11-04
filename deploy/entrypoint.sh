#!/bin/sh
set -eu
umask 077
: "${APP_STATE_DIR:?APP_STATE_DIR is required}"
: "${APP_ORIGIN:?APP_ORIGIN is required}"
if [ -n "${RAILWAY_ENVIRONMENT_ID:-}" ]; then
  if [ "${RAILWAY_VOLUME_MOUNT_PATH:-}" != "$APP_STATE_DIR" ]; then
    echo "Persistent Railway volume must be mounted at APP_STATE_DIR." >&2
    exit 1
  fi
fi
mkdir -p "$APP_STATE_DIR"
if [ "$(id -u)" = 0 ]; then
  chown node:node "$APP_STATE_DIR"
  chmod 700 "$APP_STATE_DIR"
  exec gosu node flock --no-fork -n "$APP_STATE_DIR/application.lock" node /app/app/server.mjs
fi
exec flock --no-fork -n "$APP_STATE_DIR/application.lock" node /app/app/server.mjs
