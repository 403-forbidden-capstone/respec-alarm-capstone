#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/services/prepare-ml"
PROJECT="${1:-${GCLOUD_PROJECT_ID:-}}"
REGION="${GCLOUD_REGION:-asia-northeast3}"
SERVICE="respec-prepare-ml"
ACCOUNT_NAME="respec-prepare-ml"
SECRET="respec-prepare-ml-api-token"
KEYFILE="$HOME/.config/respec-alarm/prepare-ml-api-token"

if ! command -v gcloud >/dev/null 2>&1; then
  printf '%s\n' 'gcloud CLI missing. Install with: brew install --cask gcloud-cli' >&2
  exit 2
fi
if ! command -v openssl >/dev/null 2>&1; then
  printf '%s\n' 'openssl is required to create an API token.' >&2
  exit 2
fi
if [[ -z "$PROJECT" ]]; then
  printf '%s\n' 'Specify your GCP project ID (not your Supabase project ref):'
  gcloud projects list --format='table(projectId,name)' || true
  printf '%s\n' 'Run: bash scripts/deploy-prepare-ml-cloud-run.sh YOUR_GCP_PROJECT_ID'
  exit 2
fi

for filename in c1_mae.cbm w4_mae.cbm; do
  if [[ ! -s "$SOURCE/models/v4_age_only/$filename" ]]; then
    printf 'Missing model: %s\n' "$SOURCE/models/v4_age_only/$filename" >&2
    exit 2
  fi
done

if [[ -z "$(gcloud auth list --filter='status:ACTIVE' --format='value(account)')" ]]; then
  printf '%s\n' 'Please run: gcloud auth login' >&2
  exit 2
fi

BILLING_ENABLED="$(gcloud beta billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null || true)"
if [[ "$BILLING_ENABLED" != 'True' && "$BILLING_ENABLED" != 'true' ]]; then
  printf 'Billing is not enabled for GCP project %s.\n' "$PROJECT" >&2
  printf '%s\n' 'Link an ACTIVE Cloud Billing account before deploying. No resources were created.' >&2
  exit 2
fi

printf '%s\n' "Cloud Run project: $PROJECT" "Region: $REGION" "Service: $SERVICE"
printf '%s\n' 'This creates billable Google Cloud resources (Cloud Build, Artifact Registry, Secret Manager, Cloud Run).'
printf '%s\n' 'The Cloud Run service will initially require Google IAM authentication (NOT publicly accessible).'
read -r -p 'Type DEPLOY to continue: ' consent
if [[ "$consent" != 'DEPLOY' ]]; then
  printf '%s\n' 'Cancelled.'
  exit 0
fi

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  --project="$PROJECT"

ACCOUNT_EMAIL="$ACCOUNT_NAME@$PROJECT.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$ACCOUNT_EMAIL" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$ACCOUNT_NAME" \
    --display-name='ReSpec prepare ML Cloud Run' --project="$PROJECT"
fi

if [[ ! -f "$KEYFILE" ]]; then
  mkdir -p "$(dirname "$KEYFILE")"
  openssl rand -hex 32 > "$KEYFILE"
  chmod 600 "$KEYFILE"
  printf 'Generated a private token file: %s\n' "$KEYFILE"
fi

if ! gcloud secrets describe "$SECRET" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud secrets create "$SECRET" --replication-policy=automatic --project="$PROJECT"
fi

VERSION_PATH="$(gcloud secrets versions add "$SECRET" --data-file="$KEYFILE" \
  --project="$PROJECT" --format='value(name)')"
VERSION="${VERSION_PATH##*/}"
if [[ ! "$VERSION" =~ ^[0-9]+$ ]]; then
  printf 'Could not determine Secret Manager version: %s\n' "$VERSION_PATH" >&2
  exit 1
fi

gcloud secrets add-iam-policy-binding "$SECRET" \
  --member="serviceAccount:$ACCOUNT_EMAIL" \
  --role='roles/secretmanager.secretAccessor' \
  --project="$PROJECT" >/dev/null

gcloud run deploy "$SERVICE" \
  --source="$SOURCE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --service-account="$ACCOUNT_EMAIL" \
  --memory=1Gi \
  --cpu=1 \
  --concurrency=4 \
  --max=1 \
  --min=0 \
  --timeout=15s \
  --port=8080 \
  --invoker-iam-check \
  --set-secrets="CATBOOST_API_TOKEN=$SECRET:$VERSION"

SERVICE_URL="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT" --region="$REGION" --format='value(status.url)')"
printf '\nCloud Run URL: %s\n' "$SERVICE_URL"
printf '%s\n' 'Private deployment completed. Do NOT share your token.'
printf '%s\n' 'The Supabase ML flag PREPARE_ML_ENABLED must stay 0 until validated.'
printf '%s\n' 'Run the authenticated smoke test described in services/prepare-ml/README.md.'
