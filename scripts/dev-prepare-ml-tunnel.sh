#!/usr/bin/env bash
# Development only: expose a LOCAL Docker CatBoost API through a temporary HTTPS tunnel.
# No cloud billing account, model upload, or permanent public service is needed.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/services/prepare-ml"
ENV_DIR="$HOME/.config/respec-alarm"
ENV_FILE="$ENV_DIR/prepare-ml-tunnel.env"
CONTAINER="respec-catboost-tunnel"
PORT=8093

for cmd in docker cloudflared openssl curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    if [[ "$cmd" == cloudflared ]]; then
      printf '%s\n' 'cloudflared not installed. Run: brew install cloudflared' >&2
    else
      printf 'Missing command: %s\n' "$cmd" >&2
    fi
    exit 2
  fi
done
if ! docker info >/dev/null 2>&1; then
  printf '%s\n' 'Docker Desktop is not running.' >&2
  exit 2
fi

for filename in c1_mae.cbm w4_mae.cbm; do
  if [[ ! -s "$SOURCE/models/v4_age_only/$filename" ]]; then
    printf 'Missing model: %s\n' "$SOURCE/models/v4_age_only/$filename" >&2
    exit 2
  fi
done

mkdir -p "$ENV_DIR"
chmod 700 "$ENV_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  printf 'CATBOOST_API_TOKEN=%s\n' "$(openssl rand -hex 32)" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  printf 'Created a random private API key in: %s\n' "$ENV_FILE"
fi
if ! grep -Eq '^CATBOOST_API_TOKEN=[0-9a-f]{64}$' "$ENV_FILE"; then
  printf 'Refusing to use an invalid token file: %s\n' "$ENV_FILE" >&2
  exit 2
fi

printf '%s\n' 'Building the C1/W4 Docker image (cached layers are reused)...'
docker build -t respec-catboost:tunnel "$SOURCE"

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  printf '%s\n' 'Restarting the prior development container (port 8093 only)...'
  docker rm -f "$CONTAINER" >/dev/null
fi

docker run --rm -d --name "$CONTAINER" \
  -p "127.0.0.1:${PORT}:8091" \
  --env-file "$ENV_FILE" \
  respec-catboost:tunnel >/dev/null

cleanup() {
  printf '\nStopping the temporary CatBoost development container...\n'
  docker stop "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

healthy=0
for i in {1..15}; do
  if curl --fail --silent --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
if [[ "$healthy" -ne 1 ]]; then
  docker logs --tail 40 "$CONTAINER" >&2
  printf '%s\n' 'Container failed to start.' >&2
  exit 1
fi

printf '\n%s\n' 'Docker model API ready on http://127.0.0.1:8093.'
printf '%s\n' 'Starting a temporary, public HTTPS endpoint.'
printf '%s\n' 'Find the https://....trycloudflare.com URL in the output below.'
printf '%s\n' 'Keep this terminal OPEN. Ctrl+C stops the tunnel and its Docker container.'
printf '%s\n' 'The /predict endpoint requires a secret key; do NOT post it in chat.'
printf '\n'
cloudflared tunnel --url "http://127.0.0.1:${PORT}"
