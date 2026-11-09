# C1/W4 CatBoost service

Only two models are accepted: `c1_mae` and `w4_mae`.
The entrypoint is `app:app`; environment variables: `CATBOOST_MODEL_DIR`, `CATBOOST_API_TOKEN`, optional `PORT`.

## Local
```bash
cd services/prepare-ml
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
CATBOOST_MODEL_DIR="$HOME/catboost_261027/models/v4" CATBOOST_API_TOKEN="set-a-secret" uvicorn app:app --host 127.0.0.1 --port 8091
```

## Docker / HTTPS deployment
The Docker build context must be `services/prepare-ml`. Before building, place only these two local model artifacts in `services/prepare-ml/models/v4/`:

- `C1_optional_profile_mae.cbm`
- `W4_previous_duration_optional_profile_mae.cbm`

These files are **not present in GitHub yet** and the image cannot build until they are supplied. Do not copy any survey microdata into the container or repo. Check the project's model artifact sharing rules before committing generated model binaries.

```bash
docker build -t respec-prepare-ml services/prepare-ml
docker run --rm -p 8091:8091 -e CATBOOST_API_TOKEN="replace-this" respec-prepare-ml
```

For hosted Supabase, expose **HTTPS**, configure the endpoint and API token as Edge Function secrets (`PREPARE_ML_URL`, `PREPARE_ML_API_TOKEN`), and enable the flag only after verified survey-code mappings. The Mac localhost address cannot be called from hosted Supabase.

Health: `GET /health` (no token); model schema: `GET /models` (token); inference: `POST /predict` (token). Do not put the token in any Expo variable.

## Google Cloud Run — staged deployment

The deployment helper is `scripts/deploy-prepare-ml-cloud-run.sh` from the repo root.
It asks for the Google Cloud **project ID**, shows the region, and requires typing `DEPLOY`.
It enables required GCP APIs and creates billable resources. Billing must already be enabled.
The helper generates a random token at `~/.config/respec-alarm/prepare-ml-api-token` and
stores it in Secret Manager; never paste it into chat, terminal history, or Git.
The service runs with minimum instances 0 (cold starts possible), maximum 1.

**Important:** This first deployment uses `--invoker-iam-check` and is **private**.
It is a secure deployment test and will **not** yet accept requests from Supabase Edge,
because the current Edge client sends `x-api-key` but not the Google-signed OIDC ID
token required by Cloud Run IAM. Do not turn `PREPARE_ML_ENABLED=1` on just because
the Cloud Run URL exists. A later networking/authentication decision is required:
either implement Google OIDC authentication for the Edge caller, or explicitly opt
for a publicly invokable endpoint protected by the FastAPI key plus abuse controls.

To smoke-test a private endpoint, use an account with Cloud Run Invoker permissions.
Example (interactive gcloud auth from an account with appropriate role):

```bash
URL="$(gcloud run services describe respec-prepare-ml --region=asia-northeast3 --format='value(status.url)')"
curl -fsS -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$URL/health"
```

The above test checks the IAM identity token for the caller but does not test the
FastAPI API token or Supabase networking. For `/predict`, both layers of
authentication are required.
