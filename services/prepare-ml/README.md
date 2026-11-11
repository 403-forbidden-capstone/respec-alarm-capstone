# C1/W4 CatBoost service — model artifacts separate from image

The FastAPI server accepts only two age-only CatBoost models:
- `c1_mae`: calendar + verified age code
- `w4_mae`: same + *immediately preceding local date* preparation minutes

The `.cbm` artifacts are **never** committed or copied into Docker images. Both
model binaries must be provisioned separately and mounted read-only into
`/app/models/v4_age_only`. The image and its Python dependencies may be
built on GitHub Actions, GHCR, or an EC2 host without access to model files.

## Verified artifacts (2026-11-11, user's local Mac)

These hashes identify the currently tested version; compare again after
transferring and update them **if the models are retrained**. They do not
measure model accuracy.

| file | SHA-256 |
|---|---|
| `c1_mae.cbm` | `e8def4a0753a4a5d90472c638ccbe85a3838aa366134c1a279fd1a7f850da7e8` |
| `w4_mae.cbm` | `16cc8bd739c17caa363ab8b5976fc155b9ce43c92cd1ffd6848999a95c8f77b7` |

## Local Python (already smoke-tested)

```bash
cd services/prepare-ml
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
CATBOOST_MODEL_DIR="$HOME/catboost_261027/models/v4_age_only" \
CATBOOST_API_TOKEN=local-test-only uvicorn app:app --host 127.0.0.1 --port 8092
```

## Docker smoke test (arm64-capable, no model binaries in image)

From the repository root on the machine with model files:

```bash
docker build -t respec-prepare-ml:local services/prepare-ml

docker run -d --name respec-prepare-ml-check --rm \
  -p 127.0.0.1:8093:8091 \
  --mount "type=bind,src=$HOME/catboost_261027/models/v4_age_only,dst=/app/models/v4_age_only,readonly" \
  -e CATBOOST_API_TOKEN=local-test-only \
  respec-prepare-ml:local

# The model load may take time; do not interpret docker run -d alone as readiness.
docker inspect -f '{{.State.Health.Status}}' respec-prepare-ml-check
curl -fsS http://127.0.0.1:8093/health
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8093/models  # 401
curl -fsS -H 'x-api-key: local-test-only' http://127.0.0.1:8093/models

docker stop respec-prepare-ml-check
```

A successful health check requires `ok=true` and both model names.
The image may be built without the models, but the service should not be
considered ready without the read-only bind mount. Without both artifacts,
`GET /health` returns HTTP 503 with `ok=false`.

## EC2 handoff (#471 / #472)

The legacy Cloud Run deployment helper is disabled and exits before
creating resources because its source-build design cannot load mounted models.
The local tunnel helper mounts its model source read-only and checks `ok=true`.

The standalone illustration is
`deploy/prepare-ml.compose.example.yml`. The #471 owner must integrate its
`prepare-ml` service definition into the single production Compose/nginx setup.
Avoid publishing port 8091 on all network interfaces.

1. Provision the two CBM files at an absolute server-side directory, e.g.
   `/opt/respec/models/v4_age_only`. Transfer them over an authenticated
   channel (e.g. `scp`) and verify both SHA-256 checksums **on EC2**.
   The source model files remain in the user's local directory.
2. Create `deploy/ml.env` **on EC2**, restricted to the deployment user,
   with `CATBOOST_API_TOKEN=<random-long-secret>` and mode `600`.
   Do not paste the token into chats, commits, logs, or frontend variables.
   Use a separately generated token from the local `local-test-only` token.
3. Export `PREPARE_ML_MODELS_DIR=/opt/respec/models/v4_age_only` and use
   `docker compose -f deploy/prepare-ml.compose.example.yml up -d --build`
   as an isolated smoke test. Only port `127.0.0.1:8093` is published.
   Production Compose should use the integration owned by #471.
4. Verify `docker compose ... ps` is `healthy`, `GET /health` returns
   `ok=true`, `POST /predict` with token returns 200, and without token
   returns 401. Configure nginx so external `/ml/health` and
   `/ml/predict` work over HTTPS, but `/ml/models` is not exposed
   (404). Nginx path rewriting must preserve FastAPI's `/health` and
   `/predict` paths.
5. Once stable and reachable from hosted Supabase, configure the secret
   values `PREPARE_ML_URL=https://api.<domain>/ml` and
   `PREPARE_ML_API_TOKEN` **on Supabase Edge**, not in mobile.
   **Keep `PREPARE_ML_ENABLED=0`**.

Note: the legacy `scripts/deploy-prepare-ml-cloud-run.sh` assumed
the former image-embedded-model design. Do not use that helper with this
EC2 volume-based Dockerfile without adapting its artifact mounting.

## Operating safety and limitations

- A previous one-off Cloudflare tunnel/Edge test with *synthetic*
  profile codes is not evidence that the current EC2 endpoint is deployed.
- The official 2024 Time Use Survey codebook mapping and consent/verified
  profile approval path remain incomplete. Do not mark profiles verified
  or turn on global inference based on this deployment alone.
- Production `alarm-suggest` and `alarm-commit` Edge deployments must
  be checked against GitHub `main` before any authorized test-user E2E.
- Before accepting an E2E result, verify actual saved alarm and participant
  records in Supabase and compare UTC timestamps; local Docker health only
  confirms infrastructure readiness.
