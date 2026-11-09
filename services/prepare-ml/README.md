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
