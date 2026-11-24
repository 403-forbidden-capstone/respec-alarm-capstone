# Original 2024 Survey CatBoost v2 — opt-in individual transfer pilot

## Reused research artifact
- Trained model: `prep_start_ratio_v2.cbm`, from `prep_start_v2_research_bundle.zip`.
- SHA-256: `90f559120f9be9745013d47e7ae3fac3e76b4c32835d3cb40918c8c4c748ee91` (checked against the original manifest).
- Training target: `survey_start_cluster_proxy`, derived from last 141/142 diary cluster before departure. **Not verified app preparation start.**
- Training baseline: **previous survey diary day's own proxy duration**, not onboarding value and not a mean of ten sessions.
- Research evaluation: proxy-label MAE 10.339 minutes; underprediction 50.78%. Transfer performance on app events is unmeasured.

## Separate, OFF-by-default pilot contract
The existing production path requires an app-trained model with `mean_last_30_valid_prep_alarm_location_v1`. It correctly rejects the survey model. The new `survey_previous_day_app_proxy_transfer_v1` contract is separate; it preserves the original survey training target and saves model attribution as `prep_start_ratio_v2_survey_pilot`.

The closest possible app input to the survey model's previous-day baseline is the *single completed, validated PREPARE_ALARM→LOCATION interval on the preceding local calendar day*. Ten valid post-preference-edit observations are only an eligibility threshold, not a new trained model feature. No preceding local day means **fallback**, not guessed input. This is cross-domain transfer and not scientifically validated.

## Required server-only settings (all OFF by default)
- `PURE_PREP_MODEL_LIVE_ENABLED=0` (existing app-trained model takes priority if enabled)
- `PURE_PREP_SURVEY_V2_PILOT_ENABLED=1`
- `PURE_PREP_SURVEY_V2_PILOT_ALLOW_ALARM=1` (explicit opt-in to unvalidated survey-proxy alarm predictions)
- `PURE_PREP_SURVEY_V2_PILOT_ALLOWED_USER_IDS`: exact UUID allowlist for a research/test account; empty means OFF
- `PURE_PREP_SURVEY_V2_PILOT_URL`: separate authenticated HTTPS model endpoint
- `PURE_PREP_SURVEY_V2_PILOT_API_TOKEN`: matching server-side API token
- `PREPARE_ML_CODEBOOK_VERSION`: matching verified age/consent record

Existing user consent, approved profile, 10 post-edit valid sessions, personal AUTO and no manual override remain mandatory. Groups are excluded. The network or model failing preserves PROFILE/HISTORY.

## Serve the original model in an isolated environment
Extract the original research ZIP locally and retain the verified .cbm and .manifest.json together. Never commit the token, model features or user data.

```bash
python3 -m pip install 'catboost>=1.2,<2' 'pandas>=2,<3'
export SURVEY_V2_PILOT_MODEL_PATH=/secure/models/prep_start_ratio_v2.cbm
export SURVEY_V2_PILOT_API_TOKEN='<load-from-secret-manager>'
python3 tools/prepare-adjust-sidecar/survey_v2_pilot.py
```

The service binds to localhost port 8095. An independently operated authenticated HTTPS reverse proxy is required for Edge access. This PR does **not** deploy a public sidecar or set Edge secrets.

## Tests and acceptance
```bash
node --experimental-strip-types --test supabase/functions/_shared/survey-v2-pilot.test.ts supabase/functions/_shared/plan.test.ts
python3 -m unittest discover -s tools/prepare-adjust-sidecar -p 'test_survey_v2_pilot.py' -v
```

Verify: (1) 9 vs 10 eligibility, (2) preceding *local day* completed event, (3) metadata and hash refusal, (4) no profile/ten-mean substitution, (5) preview/commit equality and distinct stored source/model, (6) manual/group exclusions, (7) offline fallback, (8) Android native alarm E2E. **Actual production model activation is not proved by CI**.

Do not expand beyond a specifically authorized research test account until prospective app ground-truth and underprediction calibration have been evaluated.