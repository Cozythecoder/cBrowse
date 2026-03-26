#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

if ! command -v doctl >/dev/null 2>&1; then
  echo "doctl is required. Install it first: https://docs.digitalocean.com/reference/doctl/" >&2
  exit 1
fi

: "${SSH_KEYS:?Set SSH_KEYS to a comma-separated list of DigitalOcean SSH key IDs or fingerprints.}"

DROPLET_NAME=${DROPLET_NAME:-cbrowse}
REGION=${REGION:-sgp1}
SIZE=${SIZE:-s-1vcpu-1gb}
IMAGE=${IMAGE:-ubuntu-24-04-x64}
TAG_NAMES=${TAG_NAMES:-cbrowse}
USER_DATA_FILE=${USER_DATA_FILE:-"$SCRIPT_DIR/cloud-init.yaml"}

args=(
  compute
  droplet
  create
  "$DROPLET_NAME"
  --region
  "$REGION"
  --size
  "$SIZE"
  --image
  "$IMAGE"
  --ssh-keys
  "$SSH_KEYS"
  --tag-names
  "$TAG_NAMES"
  --user-data-file
  "$USER_DATA_FILE"
  --enable-monitoring
  --enable-ipv6
  --wait
  --format
  ID,Name,PublicIPv4,Status,Region,Image,SizeSlug
)

if [[ -n "${PROJECT_ID:-}" ]]; then
  args+=(--project-id "$PROJECT_ID")
fi

if [[ -n "${VPC_UUID:-}" ]]; then
  args+=(--vpc-uuid "$VPC_UUID")
fi

if [[ "${ENABLE_BACKUPS:-false}" == "true" ]]; then
  args+=(--enable-backups)
fi

doctl "${args[@]}"
