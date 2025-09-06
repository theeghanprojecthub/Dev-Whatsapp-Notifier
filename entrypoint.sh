#!/usr/bin/env bash
"Seed whatsapp-web.js auth from WWEBJS_AUTH_B64 if provided, then start API"
set -euo pipefail

if [ -n "${WWEBJS_AUTH_B64:-}" ]; then
  mkdir -p /app/.wwebjs_auth /.wwebjs_tmp
  echo "$WWEBJS_AUTH_B64" | base64 -d > /.wwebjs_tmp/auth.tgz
  tar -xzf /.wwebjs_tmp/auth.tgz -C /app/.wwebjs_auth
  rm -rf /.wwebjs_tmp
fi

exec node /app/server.js
