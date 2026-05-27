#!/usr/bin/env bash
# Overleaf + Claude Code AI Assistant — one-command setup.
# Usage: ./bin/setup.sh [public-url]
#   ./bin/setup.sh http://192.168.0.6:8082
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEVELOP="$ROOT/develop"
COMPOSE="docker compose -p overleaf-claude"

PUBLIC_URL="${1:-http://localhost:8082}"

cd "$DEVELOP"

# ── 1. dev.env ────────────────────────────────────────────
if [ ! -f dev.env ]; then
  TOKEN_KEY=$(openssl rand -hex 32 2>/dev/null || \
    python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null || \
    python -c "import os,binascii; print(binascii.hexlify(os.urandom(32)).decode())")
  cat > dev.env <<DEVENV
AI_ASSISTANT_CLAUDE_BIN=claude
AI_ASSISTANT_TOKEN_KEY=$TOKEN_KEY
AI_ASSISTANT_IDLE_MS=600000
PUBLIC_URL=$PUBLIC_URL
DOWNLOAD_HOST=clsi-nginx
DEVENV
  echo "✓ Created dev.env (TOKEN_KEY auto-generated)"
else
  echo "✓ dev.env exists"
fi

# ── 2. Webpack output ─────────────────────────────────────
if [ ! -f webpack-output/manifest.json ]; then
  echo "⏳ Building frontend assets (webpack) …"
  mkdir -p webpack-output

  # Pre-populate img/fonts from the built image
  docker run --rm -v "$DEVELOP/webpack-output:/tmp/out" \
    overleaf-claude-web:latest \
    sh -c 'cp -a /overleaf/services/web/public/img /tmp/out/ 2>/dev/null; cp -a /overleaf/services/web/public/fonts /tmp/out/ 2>/dev/null; true'

  # Override to run webpack production build
  cat > docker-compose.override.yml <<'OVERRIDE'
services:
  webpack:
    image: overleaf-claude-web:latest
    command: ["npx", "webpack", "--config", "webpack.config.prod.js"]
    working_dir: /overleaf/services/web
    user: root
    volumes:
      - ../services/web/frontend:/overleaf/services/web/frontend
      - ../services/web/app/src:/overleaf/services/web/app/src
      - ../services/web/locales:/overleaf/services/web/locales
      - ../services/web/webpack.config.prod.js:/overleaf/services/web/webpack.config.prod.js
      - ./webpack-output:/overleaf/services/web/public
    environment:
      - NODE_ENV=production
OVERRIDE

  $COMPOSE run --rm webpack
  rm -f docker-compose.override.yml
  echo "✓ Webpack done"
else
  echo "✓ Webpack output exists"
fi

# ── 3. Start ──────────────────────────────────────────────
echo "⏳ Starting services …"
$COMPOSE up -d

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Ready: $PUBLIC_URL"
echo "  Create admin:  docker exec -it overleaf-claude-web-1 node /overleaf/tools/cli create-admin"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
