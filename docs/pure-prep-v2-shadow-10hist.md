# CatBoost v2: 10-record shadow preview integration

The live alarm calculation remains unchanged. This integration works only in `alarm-suggest` (preview), and is **OFF by default**.

- `PURE_PREP_SHADOW_ENABLED=1`, plus exact `PURE_PREP_SHADOW_ALLOWED_USER_IDS` allowlist.
- Personal appointment only, no manual WAKE/PREPARE override; the existing pure-prep calculation must already be used.
- Consent (`profiles.ml_profile_consented_at`), **10 valid historical** `PREPARE_ALARM` → `LOCATION` completed intervals, and verified server-only age code/codebook required.
- Histories are read as the authenticated user with RLS. Future, duplicate, reversed, under-10-minute and over-240-minute records are excluded.
- `PURE_PREP_SHADOW_URL` must point to a secure authenticated HTTPS endpoint. `PURE_PREP_SHADOW_API_TOKEN` lives only in Edge secrets. An unavailable model leaves the alarm unchanged.
- Survey-proxy weights from the 2024 Time Use Survey are not actual prep-start labels. For research shadow mode only, set `PURE_PREP_SHADOW_ALLOW_SURVEY_PROXY=1` explicitly. Default rejects the survey target, never silently claiming actual-session training.
- Only `pure_prep_shadow` is added to the **authenticated preview response**; no server-side log of user features or training data and no commit/DB write.
- An eligible sample receives `status: PREDICTED`, `predicted_pure_minutes`, `history_baseline_minutes`, `training_target`, and `applied_to_alarm: false`.
- Under 10 valid records the preview gets `INSUFFICIENT_HISTORY`; no outbound model API request occurs.

The research sidecar Python files were imported from PR #549, with the **10-record** boundary preserved. Real-session training excludes `ROUTINE_STEP` and departures not labelled `LOCATION` because pre-preparation activity and planned/manual departure timestamps must not be used as ground truth. The training CSV requires both `prepare_started_source` and `departed_source`.

## Required before live experiment

1. Verify the trained model binary's SHA-256/manifest and deploy sidecar on an authenticated HTTPS endpoint, separate from the C1/W4 server.
2. Validate personal training consent for behavior records; legacy age consent alone does not grant secondary model-training usage.
3. Obtain at least 10 real complete sessions for an explicitly allowlisted research account. The demo account had zero when this patch was authored.
4. Independently re-train against real actual-start-to-departure targets, evaluate user-disjoint splits, late-risk and underestimation before **any** model-controlled scheduling.
5. Keep `PURE_PREP_SHADOW_ENABLED=0` in production until model hosting, auth, and E2E are complete.

No `supabase/migrations` are required. An unchanged existing alarm preview is the fail-closed behavior.

To test the deterministic logic locally:

```bash
node --experimental-strip-types --test supabase/functions/_shared/pure-prep-shadow.test.ts
```
