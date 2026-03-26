#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: DOMAINS='cbrowse.example.com, backup.example.com' $0 <user@droplet-ip> [remote-dir]" >&2
  exit 1
fi

if [[ -z "${DOMAINS:-}" ]]; then
  : "${DOMAIN:?Set DOMAINS or DOMAIN to the public hostname(s) that point at the Droplet.}"
  DOMAINS=$DOMAIN
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required." >&2
  exit 1
fi

if ! command -v ssh >/dev/null 2>&1; then
  echo "ssh is required." >&2
  exit 1
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
TARGET=$1
REMOTE_SUDO="sudo"

if [[ "$TARGET" == root || "$TARGET" == root@* ]]; then
  REMOTE_SUDO=""
  REMOTE_DIR=${2:-/opt/cBrowse}
else
  REMOTE_DIR=${2:-~/cBrowse}
fi

ssh "$TARGET" "REMOTE_DIR=$REMOTE_DIR; mkdir -p \"\$REMOTE_DIR\""

rsync -az --delete \
  --exclude ".DS_Store" \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "dist" \
  --exclude "deploy/digitalocean/.env" \
  "$PROJECT_ROOT/" "$TARGET:$REMOTE_DIR/"

ssh "$TARGET" "REMOTE_DIR=$REMOTE_DIR; mkdir -p \"\$REMOTE_DIR/deploy/digitalocean\""
ssh "$TARGET" "REMOTE_DIR=$REMOTE_DIR; cat > \"\$REMOTE_DIR/deploy/digitalocean/.env\" <<'EOF'
DOMAINS=$DOMAINS
EOF"

ssh "$TARGET" "REMOTE_DIR=$REMOTE_DIR; cd \"\$REMOTE_DIR\" && chmod +x deploy/digitalocean/install-ubuntu.sh"
ssh "$TARGET" "REMOTE_DIR=$REMOTE_DIR; cd \"\$REMOTE_DIR\" && $REMOTE_SUDO ./deploy/digitalocean/install-ubuntu.sh"
ssh "$TARGET" "REMOTE_DIR=$REMOTE_DIR; cd \"\$REMOTE_DIR/deploy/digitalocean\" && $REMOTE_SUDO docker compose up -d --build"
ssh "$TARGET" "REMOTE_DIR=$REMOTE_DIR; cd \"\$REMOTE_DIR/deploy/digitalocean\" && $REMOTE_SUDO docker compose ps"
