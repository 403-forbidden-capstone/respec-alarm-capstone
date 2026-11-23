# Preparation-only CatBoost integration (experimental, default OFF)

## Three independent times
- Departure alarm: appointment - map route travel - arrival buffer (unchanged).
- Preparation alarm: departure - predicted **prepare-start -> departure** duration.
- Wake alarm: prepare alarm - prior-activity/lead period. Existing 20-minute default is **unchanged** in this PR.

The existing C1/W4 model predicts **wake -> departure**, including eating / chores /
leisure, and is **not** the preparation-only model. Never combine both models in
one calculation.

## What was integrated
- `prep-adjust.ts`: inspect actual app session rows from
  `appointment_participants.prepare_started_at` and `departed_at`,
  build a causal recent-30 baseline (>=10 valid completed records), call a
  separate authenticated `prep_start_ratio_v2` sidecar, validate response.
- `plan.ts`: optional feature flag + exact UUID allowlist + existing verified
  consent and age-code approval, fail closed. Does **not** use
  `daily_records.actual_prepare_minutes`: that is wake -> departure.
- `plan-core.ts`: convert predicted preparation-only duration into existing
  backward-compatible calculation units by adding the unchanged
  `beforePrepareMinutes`. Default 20-minute behavior is intact.
- `tools/prepare-adjust-sidecar/server.py`: separate API contract with SHA-256 provenance manifest.
- 2024 survey bootstrap artifact is available as a separately downloadable research bundle (the binary `.cbm` is not committed in this PR).
- `tools/prepare-adjust-sidecar/train.py`: future real-data training with
  strictly historical per-user features and user-group splits.
- Tests ensure no-ML fallback, manual override, old W4 precedence, and
  that late/missing records do not enter history.

## Bootstrap from the existing 2024 time-use survey
The pre-trained `prep_ratio_survey_proxy.cbm` is packaged together with a SHA-256 manifest and a local HTTP smoke-test server. For initial tests, set the server's `PREP_ADJUST_ALLOW_SURVEY_PROXY=1`, and on the Edge side opt in with `PREP_ADJUST_ALLOW_SURVEY_PROXY=1`. The model response explicitly includes `training_target: "survey_start_cluster_proxy"`. This is only acceptable on allowlisted **research accounts**. It MUST NOT be presented as validated actual preparation-duration prediction.

Once consented actual preparation-start/departure records accumulate, train the sidecar's `train.py` to produce an actual-duration `.cbm` and corresponding `.manifest.json` with `training_target: "actual_start_depart"`. The adapter accepts this target by default; no survey proxy opt-in is needed. Keep old C1/W4 disabled in this mode. **Do not change a manifest target manually** to force a survey model to be treated as a true-duration model.

## Current data restrictions
The 2024 time-use survey ratio model from the earlier prototype is trained
on `141+142` activity totals and **not** on user-confirmed preparation-start
-> departure. It has **not** been validated using self-reported onboarding
times or planned activity indicators. **DO NOT turn on PREP_ADJUST_ENABLED with
that model or ship a live model using those weights.**

`profiles.default_prepare_minutes` currently means wake -> departure in
main. It is deliberately **not** silently treated as a pure preparation
baseline. The new baseline initially uses the mean of recent valid real
preparation sessions. Onboarding semantics/UI must be migrated separately
before it can become the initial user baseline.

Current `prepare_started_at` with `PREPARE_ALARM` source is written on
user alarm dismissal / one-tap (PR #490), not on alarm fire. This is a noisy
proxy for *actual* physical preparation start, so validate with a user study.
`departed_at` must represent actual departure (and not scheduled departure)
for the pair to count. Both timestamps must exist and be in order.
Records from **after** the requested appointment or prediction time are
excluded. There is no training sample at n<10.

## Explicit enable gates — ALL required

**Safety threshold:** the actual-session model requires 10 verified completed preparation-start → departure pairs before shadow inference. This does not retrain or validate the survey proxy model. The existing `main` PROFILE→HISTORY average fallback remains independently gated at 3 records until changed in a separate product decision.
1. A **new** service model trained and validated on `prepare_started_at ->
   departed_at` histories (NOT the survey proxy), with held-out user metrics.
2. `PREP_ADJUST_ENABLED=1` (default unset/off).
3. `PREPARE_ML_ENABLED` must **not** be 1, preventing two incompatible
   targets from applying at once.
4. User UUID is explicitly present in `PREP_ADJUST_ALLOWED_USER_IDS`.
5. Server-side `prepare_ml_verified_profiles` row has a valid consent,
   approval timestamp, verified age code, and matching
   `PREPARE_ML_CODEBOOK_VERSION` (legacy gate retained).
6. Valid history: >=10 user-attested preparation-start / departure pairs.
7. `PREP_ADJUST_URL` is HTTPS (or local-only loopback for development).
   `PREP_ADJUST_API_TOKEN` is stored only in Edge secrets and server env.
8. First/with-wake automatic appointment only; direct manual prepare or
   manual WAKE/PREPARE times take precedence.
9. FastAPI routing parity, preview/commit persistence and actual-device E2E
   must be verified before rollout.

No DB migration, deployment, or feature-flag changes are included here.

## Sidecar API
POST `/predict` JSON:

```json
{
  "model":"prep_start_ratio_v2",
  "features":{
    "weekday_code":"4",
    "평토일구분코드":"1",
    "휴일종류코드":"__MISSING__",
    "연령코드":"2",
    "baseline_observed":30
  },
  "history_count":10
}
```

Response `{"model":"prep_start_ratio_v2","prediction_type":"ratio","minutes":33,"ratio":1.1}`.
Feature schema is exact: old `141/142` observed-on-target-day ORACLE flags
are forbidden in this path, because they leak future observations.

For **local QA only**, after a new actual-session model is ready:

```bash
python -m pip install catboost pandas numpy
export PREP_ADJUST_MODEL_PATH="$PWD/reports/prepare-adjust-service/prep_ratio_actual_sessions.cbm"
export PREP_ADJUST_API_TOKEN="<32+random-character-local-test-secret>"
python tools/prepare-adjust-sidecar/server.py
```

Server binds loopback 127.0.0.1:8094 by default. For remote Edge calls
you must put it behind authenticated HTTPS; do not expose plain HTTP publicly.
Do not put the token inside the mobile app or repository.

## Future real-data training
Export *consented, minimum-necessary* user preparation records, including
`user_id`, `prepare_started_at`, `departed_at`,
`prepare_started_source` and the verified categorical features, to a secure
offline CSV. Avoid persisting an unconsented dataset.

```bash
python tools/prepare-adjust-sidecar/train.py \
  --sessions-csv /secure/path/consented-prep-sessions.csv \
  --out-dir reports/prepare-adjust-service \
  --min-train-users 100
```

The trainer requires >=11 valid sessions/user (10 past + 1 next target) and
>=100 eligible users by default. It trains a `log((target+10)/(baseline+10))`
CatBoost model; previous baseline = past **up to 30** actual prep durations.
User-disjoint train/valid/test, with causal ordering within each user.
Metrics compare actual time, direct baseline, and model. Model does not update
daily; incoming user history updates the baseline at every inference.

## Important blockers before deployment
- Validate meaning of physical preparation start (a dismissed alarm can be
  earlier/later than actual start), departure capture, reliability / missingness.
- Obtain enough consented real training data; current hosted `daily_records`
  have zero rows, and no proven real-duration CatBoost is yet available.
- Real app's H03/H05 first-entry preparation time is currently wake-to-depart;
  new default pure-prep input requires a migration/UX contract.
- The planned activity combination ("wash hair" etc.) is not yet a feature:
  no prospective labeled data currently exists. A later model version should
  use **pre-registered** activity flags, never diary-day ORACLE data.
- PR #546 contains a new activity-plan scheduler; merge conflicts and
  `planDay` integration must be handled before combining with this branch.
- Current FastAPI execution path is a separate repository; parity is not
  implemented or verified by this PR.
- Prepare-sidecar and app are NOT deployed. No production model is activated.
- The sample survey model uses one previous 2-day diary observation as baseline; a 10+ observation baseline in a real app is a different feature distribution and needs real user validation.

## Tests
```bash
node --experimental-strip-types --test \
  supabase/functions/_shared/prep-adjust.test.ts \
  supabase/functions/_shared/plan-core.test.ts \
  supabase/functions/_shared/prepare-ml.test.ts
```


## Preparation-start proxy v2 (2026-11-18)
The original survey ratio model predicted the **SUM** of 141/142 across the morning.
It is now superseded as a research candidate by a separately trained model:
- Target: last near-departure preparation cluster's **start time**, encoded as departure minus cluster-start minutes.
- Label extraction: ten-minute time-use slots; allow at most 10m non-141/142 gap within cluster, and last 141/142 activity must end within 20m of departure; maximum inferred interval 180m.
- Data: 30,198 eligible survey diary records; 21,850 labels (72.4%); 6,837 two-day persons; train=4,785 / valid=1,026 / test=1,026 persons.
- Ratio CatBoost test MAE=10.339m vs preceding-day baseline MAE=10.819m, underestimation rate=50.78%. Bootstrap ΔMAE=0.479m, 95% CI [0.117,0.827]m.
- Quantile (0.80) CatBoost separately trained: MAE=13.72m, underestimation rate=19.10% on the same test set.
- Sensitivity to proxy labeling thresholds is material, with some definitions showing inconclusive improvements.
- The **pretrained .cbm** is a downloadable standalone research artifact, not committed to GitHub. Its manifest identifies `survey_start_cluster_proxy` distinctly from `actual_start_depart`.
- Input features still do NOT include *advance-declared* preparation/activity combinations. In particular, the app's `beforePrepareMinutes` is a separate schedule rule and remains unchanged.
- No verified real preparation-start ground truth, onboarding self-report evaluation, >=10-session actual-history training, or cross-repo FastAPI parity exists. **Default OFF** remains required until these are addressed.
