#!/usr/bin/env bash
# ARM64 local smoke test for C1/W4; never uploads binaries or secrets.
# Usage: bash scripts/smoke-prepare-ml-arm64.sh [absolute-model-directory]
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODELS="$HOME/catboost_261027/models/v4_age_only"
if [[ "$#" -gt 0 ]]; then MODELS="$1"; fi

for dep in docker curl python3 openssl shasum; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "ERROR: required command missing: $dep" >&2
    exit 2
  fi
done
if [[ "$MODELS" != /* ]]; then
  echo "ERROR: supply an absolute model directory" >&2
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon is not running (start Docker Desktop)" >&2
  exit 2
fi
if [[ "$(uname -m)" != arm64 ]]; then
  echo "NOTICE: host is not arm64; Docker will still build linux/arm64." >&2
fi
C1="$MODELS/c1_mae.cbm"
W4="$MODELS/w4_mae.cbm"
for model in "$C1" "$W4"; do
  if [[ ! -s "$model" ]]; then echo "ERROR: missing trained model: $model" >&2; exit 2; fi
done

check_hash() {
  local model="$1"
  local expected="$2"
  local actual
  actual="$(shasum -a 256 "$model" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: SHA-256 mismatch: $model" >&2
    exit 1
  fi
  printf '[PASS] sha256 %s\n' "$(basename "$model")"
}
check_hash "$C1" e8def4a0753a4a5d90472c638ccbe85a3838aa366134c1a279fd1a7f850da7e8
check_hash "$W4" 16cc8bd739c17caa363ab8b5976fc155b9ce43c92cd1ffd6848999a95c8f77b7

IMAGE=respec-prepare-ml:smoke-arm64
CONTAINER="respec-prepare-ml-smoke-$$"
TEMP="$(mktemp -d)"
cleanup() {
  docker stop "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$TEMP"
}
trap cleanup EXIT

TOKEN="$(openssl rand -hex 32)"
printf 'CATBOOST_API_TOKEN=%s\n' "$TOKEN" > "$TEMP/token.env"
chmod 600 "$TEMP/token.env"

echo '== Docker build (linux/arm64; NO model binaries in image) =='
docker build --platform linux/arm64 -t "$IMAGE" "$ROOT/services/prepare-ml"
ARCH="$(docker image inspect -f '{{.Architecture}}' "$IMAGE")"
if [[ "$ARCH" != arm64 ]]; then echo "ERROR: image is $ARCH, expected arm64" >&2; exit 1; fi
docker run --rm --platform linux/arm64 --entrypoint sh "$IMAGE" -c \
  'test ! -f /app/models/v4_age_only/c1_mae.cbm && test ! -f /app/models/v4_age_only/w4_mae.cbm'
echo '[PASS] arm64 image / no embedded model binaries'

echo '== Isolated local container (bind mount read-only; loopback only) =='
docker run -d --rm --platform linux/arm64 --name "$CONTAINER" \
  -p 127.0.0.1:8093:8091 \
  --mount "type=bind,src=$MODELS,dst=/app/models/v4_age_only,readonly" \
  --env-file "$TEMP/token.env" \
  "$IMAGE" >/dev/null

docker inspect -f '{{json .Mounts}}' "$CONTAINER" | python3 -c \
  'import json,sys; m=json.load(sys.stdin); assert any(x["Destination"]=="/app/models/v4_age_only" and x["RW"] is False for x in m)'
echo '[PASS] model mount is read-only'

READY=0
for _ in $(seq 1 60); do
  STATUS="$(curl --silent --max-time 2 --output "$TEMP/health.json" --write-out '%{http_code}' http://127.0.0.1:8093/health || true)"
  if [[ "$STATUS" == 200 ]] &&
     python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["ok"] is True and set(d["loaded_models"])=={"c1_mae","w4_mae"}' "$TEMP/health.json" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done
if [[ "$READY" -ne 1 ]]; then
  echo 'ERROR: models did not become ready; container logs:' >&2
  docker logs --tail 70 "$CONTAINER" >&2
  exit 1
fi
echo '[PASS] /health 200, ok=true, both models loaded'

MODELS_UNAUTH="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8093/models)"
PRED_UNAUTH="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
  -d '{"model":"c1_mae","features":{}}' http://127.0.0.1:8093/predict)"
if [[ "$MODELS_UNAUTH" != 401 || "$PRED_UNAUTH" != 401 ]]; then
  echo "ERROR: expected unauthenticated 401 (models=$MODELS_UNAUTH, predict=$PRED_UNAUTH)" >&2
  exit 1
fi
echo '[PASS] missing API key denied with 401'

MODELS_AUTH="$(curl -sS -o "$TEMP/models.json" -w '%{http_code}' -H "x-api-key: $TOKEN" http://127.0.0.1:8093/models)"
if [[ "$MODELS_AUTH" != 200 ]]; then echo "ERROR: authorized /models returned $MODELS_AUTH" >&2; exit 1; fi
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert {x["key"] for x in d["models"]}=={"c1_mae","w4_mae"} and not d["missing"] and not d["load_errors"]' "$TEMP/models.json"
echo '[PASS] authenticated model schema'

predict() {
  local label="$1"
  local payload="$2"
  local code
  code="$(curl -sS -o "$TEMP/$label.json" -w '%{http_code}' \
    -H "x-api-key: $TOKEN" -H 'Content-Type: application/json' \
    --data "$payload" http://127.0.0.1:8093/predict)"
  if [[ "$code" != 200 ]]; then
    echo "ERROR: $label prediction returned HTTP $code" >&2
    cat "$TEMP/$label.json" >&2
    exit 1
  fi
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["model"]==sys.argv[2] and d["prediction_type"]=="point" and isinstance(d["minutes"],int) and 10<=d["minutes"]<=240; print("[PASS]",sys.argv[2],"predict",d["minutes"],"minutes")' "$TEMP/$label.json" "$label"
}

predict c1_mae '{"model":"c1_mae","features":{"weekday_code":"3","평토일구분코드":"1","휴일종류코드":"1","연령코드":"2"}}'
predict w4_mae '{"model":"w4_mae","features":{"weekday_code":"3","평토일구분코드":"1","휴일종류코드":"1","previous_day_target_minutes":60,"연령코드":"2"}}'
echo '== PASS: local ARM64 image, mounted C1/W4 inference, health and authentication =='
echo 'No EC2, Supabase Edge, or production deployment was changed.'
