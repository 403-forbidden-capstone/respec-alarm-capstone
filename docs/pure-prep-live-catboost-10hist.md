# CatBoost v2 — live personal AUTO alarm after 10 records

## Calculation contract

- Onboarding and Settings collect ONLY **pure preparation time** (PREPARE START → DEPARTURE). Never request wake→departure as a user answer.
- With 0–9 eligible post-edit completed records, the live personal AUTO schedule keeps the currently selected PROFILE/HISTORY pure preparation baseline.
- Once **10 valid post-edit** intervals exist, a personal AUTO appointment with no manual WAKE/PREPARE/preparation override requests `prep_start_ratio_v2` inference. The prediction is passed into `buildPlan` as `{source:'MODEL',minutes,model:'prep_start_ratio_v2'}` for BOTH alarm-suggest preview and alarm-commit saving, and is recorded on the participant as `outing_prep_source=MODEL`, `outing_prep_model=prep_start_ratio_v2`.
- Actual alarms use the **pure minutes only**; existing independent before-preparation activities, travel, departure and buffer calculations stay unchanged. A group attendee uses their self-reported pure minutes and does not automatically use CatBoost.
- When model service, identity, consent, verified age/codebook, source provenance, 10-record threshold, or expected API response fails, calculation falls back to existing PROFILE/HISTORY. No synthetic weight or C1/W4 (wake→departure target) is accepted as v2.
- Existing saved alarms are NOT silently rescheduled when the user's tenth record arrives. Their AUTO values are recalculated when the user creates another appointment or explicitly triggers an existing alarm's recalculation.

## Eligibility and provenance

- The records must have `prepare_started_source=PREPARE_ALARM` and `departed_source=LOCATION`, completion BEFORE prediction, unique non-reversed timestamps, duration 10–240 minutes. The latest 10–30 *after the most recent user preference edit* are used.
- `PREPARE_ALARM` dismissal and `LOCATION` transition are **proxy timestamps**, not verified real physical start/end. Never label them independent ground truth.
- Profile consent `ml_profile_consented_at` and a server-owned, version-matching verified age/profile row are mandatory. Only the logged-in user's own RLS-filtered records are read.
- The Python sidecar requires an existing, real-data-trained CatBoost `.cbm` with a matching SHA-256 manifest declaring `prep_start_ratio_v2`, `mean_last_30_valid_prep_alarm_location_v1`, `minimum_history=10`, `history_window=30`, the exact feature list, and its true training target.
- **Ten observations are a per-user inference threshold, not a sufficient training dataset.** Current trainer enforces >=100 training users with >=11 sessions each by default. CI's *synthetic* CatBoost training artifacts are not eligible for production.

## Runtime settings (Supabase Edge secrets; never expose API tokens in an app)

- `PURE_PREP_MODEL_LIVE_ENABLED=1` must be explicitly set to enable live inference. Unset, `0`, or any other value means OFF.
- `PURE_PREP_MODEL_LIVE_URL`: required deployed authenticated HTTPS v2 model sidecar. No fallback to a Shadow endpoint.
- `PURE_PREP_MODEL_LIVE_API_TOKEN`: required matching server-side key; no fallback to Shadow credentials. Never put this value in mobile code.
- `PURE_PREP_MODEL_LIVE_ALLOWED_USER_IDS`: required exact UUID allowlist. Missing/empty list means no user qualifies.
- `PURE_PREP_MODEL_LIVE_ALLOW_PROXY=1` must be explicitly set to accept dismissal→location proxy models (default OFF). This is not actual physical preparation ground truth; the sidecar additionally requires `PREP_ADJUST_ALLOW_DISMISS_PROXY=1`.
- `PREPARE_ML_CODEBOOK_VERSION`: must match the server-approved verified user row. Shadow Mode's own flags and result remain separate.
- Model HTTP request times out and validates model, ratio, baseline definition, training target and 5–240 minute bounds before returning an applied prediction.

## Deployment / verification

1. Deploy a **real, consented data-trained** v2 model and manifest to an authenticated HTTPS endpoint. Do not point this endpoint at the older survey C1/W4 predictor or a synthetic CI artifact.
2. Configure server secrets on the Supabase project and ensure the sidecar accepts the proper model provenance. If no compatible real model is running, the server continues with PROFILE/HISTORY even after 10 events.
3. Deploy all affected Edge entrypoints (`alarm-suggest`, `alarm-commit`, `appointment-edit`, `alarm-roll`) with the same `plan.ts` and shared model modules; keep existing JWT settings.
4. Run Node planner tests for 9/10, outage and manual/group exceptions; Deno check all Edge entrypoints. Then, using a consented isolated demo user, create/verify **real** completed sessions and test authenticated preview → commit → participant's persisted `MODEL` attribution → Android's native scheduled alarm list.
5. Do not claim production activation just because CI passed; check actual model endpoint, secrets and authenticated mobile E2E.

## Technical learning points

- **Train/serve skew:** the same `baseline_observed` definition must be used in training and live inference; the old previous-day survey model is incompatible with this v2 request.
- **Causal features:** only prior completed sessions can construct the prediction for the next appointment. Never leak the target day's departure.
- **Target semantics:** a wake→departure duration and a preparation-start→departure duration are different labels; never substitute one as the other.
- **Graceful degradation:** prediction failures preserve the existing known user preference/history-based alarm rather than preventing scheduling.

### Integration invariants

- `loadPurePrepCandidate` is shared by `alarm-suggest`, `alarm-commit`, appointment edit/restore/replan, and recurring `alarm-roll`. This preserves MODEL provenance across automatic recalculation paths.
- The live model uses distinct HTTPS endpoint/token, explicit enable/allowlist and separate explicit proxy approval; Shadow settings cannot silently activate production alarms.
