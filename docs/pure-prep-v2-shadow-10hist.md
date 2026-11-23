# CatBoost v2: 10-record shadow preview integration

The live alarm calculation remains unchanged. This integration works only in `alarm-suggest` (preview), and is **OFF by default**.

- `PURE_PREP_SHADOW_ENABLED=1`, plus exact `PURE_PREP_SHADOW_ALLOWED_USER_IDS` allowlist.
- Personal appointment only, no manual WAKE/PREPARE override; the existing pure-prep calculation must already be used.
- Consent (`profiles.ml_profile_consented_at`), **10 valid historical** `PREPARE_ALARM` → `LOCATION` completed intervals, and verified server-only age code/codebook required.
- Histories are read as the authenticated user with RLS. Future, duplicate, reversed, under-10-minute and over-240-minute records are excluded.
- `PURE_PREP_SHADOW_URL` must point to a secure authenticated HTTPS endpoint. `PURE_PREP_SHADOW_API_TOKEN` lives only in Edge secrets. An unavailable model leaves the alarm unchanged.
- **Provenance:** `PREPARE_ALARM` is an alarm dismissal / one-tap event; `LOCATION` is a location-transition estimate. Neither directly verifies the physical start or exact departure. Retrained data uses `alarm_dismiss_location_proxy`, **not** `actual_start_depart`.
- A retrained dismissal proxy requires `PREP_ADJUST_ALLOW_DISMISS_PROXY=1` on the sidecar and `PURE_PREP_SHADOW_ALLOW_DISMISS_PROXY=1` on Edge, independently, for research Shadow Mode only.
- **Breaking protocol compatibility:** `baseline_observed` MUST be the causal arithmetic mean of the newest 10–30 valid completed preparation intervals (up to 30), computed identically in training and Edge inference. The exact definition is `mean_last_30_valid_prep_alarm_location_v1`. The model request, response, and the model's SHA-256 manifest all require that definition. No leakage of the current target.
- The existing 2024 survey CatBoost weights used the **previous-day diary value** as `baseline_observed`. They cannot be made compatible by renaming the manifest or flipping a flag. `survey_start_cluster_proxy` is **always rejected** by this sidecar/Edge path.
- Re-trained model export: `prep_ratio_dismiss_location_proxy.cbm` + matching `prep_ratio_dismiss_location_proxy.manifest.json`; manifest contains `baseline_definition`, `history_window: 30`, `minimum_history: 10`, `feature_names`, `training_target`, and SHA-256. If any mismatch occurs, the service fails to start or the request fails closed.
- Only a newly retrained model with this provenance can produce a compatible research shadow result; synthetic models are testing artifacts, NOT permitted for any live research interpretation or actual alarms.
- Only `pure_prep_shadow` is added to the **authenticated preview response**; no server-side log of user features or training data and no commit/DB write.
- An eligible sample receives `status: PREDICTED`, `predicted_pure_minutes`, `history_baseline_minutes`, `training_target`, and `applied_to_alarm: false`.
- Under 10 valid records the preview gets `INSUFFICIENT_HISTORY`; no outbound model API request occurs.

The research sidecar Python files were imported from PR #549, with the **10-record** boundary preserved. Proxy-session training excludes `ROUTINE_STEP` and departures not labelled `LOCATION`, and ignores durations outside 10–240 minutes. Neither the alarm dismissal nor the geofence estimate is independently verified ground truth. The training CSV requires both `prepare_started_source` and `departed_source`.

## Required before live experiment

1. Verify the trained model binary's SHA-256/manifest and deploy sidecar on an authenticated HTTPS endpoint, separate from the C1/W4 server.
2. Validate personal training consent for behavior records; legacy age consent alone does not grant secondary model-training usage.
3. Obtain at least 10 real complete sessions for an explicitly allowlisted research account. The demo account had zero when this patch was authored.
4. Retrain on appropriate consented app observations with the exact same 10–30-event baseline, then independently evaluate user-disjoint splits, underestimation, and late-risk before **any** model-controlled scheduling. The existing self-report tap is not verified physical ground truth.
5. Keep `PURE_PREP_SHADOW_ENABLED=0` in production until model hosting, auth, and E2E are complete.

No `supabase/migrations` are required. An unchanged existing alarm preview is the fail-closed behavior.

To test the deterministic logic locally:

```bash
node --experimental-strip-types --test supabase/functions/_shared/pure-prep-shadow.test.ts supabase/functions/_shared/pure-prep-shadow.synthetic.test.ts
python tools/prepare-adjust-sidecar/synthetic_protocol_test.py
```
