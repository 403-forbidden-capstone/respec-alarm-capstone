# Existing prepare-ml container: optional original survey v2 model

The existing service preserves C1/W4 and adds the **original** 2024 survey
`prep_start_ratio_v2` protocol to the same authenticated `POST /predict`.
No new container or public port is required.

## Model file transfer (never commit .cbm into Git)

Use the existing read-only model mount at
`/srv/respec/models/v4_age_only` on the team EC2, which maps to
`/app/models/v4_age_only` inside the existing container.

Transfer **both** `prep_start_ratio_v2.cbm` and
`prep_start_ratio_v2.manifest.json` without changing existing
`c1_mae.cbm` and `w4_mae.cbm`.
The expected SHA-256 is:
`90f559120f9be9745013d47e7ae3fac3e76b4c32835d3cb40918c8c4c748ee91`.
The original research ZIP is `prep_start_v2_research_bundle.zip` (private user asset).

The new model is loaded when present and passes SHA, provenance, training
target, 5-feature schema, and categorical column checks. If missing,
the existing C1/W4 service remains healthy and unchanged.

## Request / response

```json
{
  "model": "prep_start_ratio_v2",
  "baseline_definition": "survey_previous_day_app_proxy_transfer_v1",
  "history_count": 10,
  "features": {
    "weekday_code": "2",
    "평토일구분코드": "1",
    "휴일종류코드": "__MISSING__",
    "연령코드": "2",
    "baseline_observed": 30
  }
}
```

The response includes `training_target=survey_start_cluster_proxy`,
`prediction_type=ratio`, `minutes`, and `ratio`.
The **ten valid sessions is an eligibility gate**, *not* a trained 10-day
input. The previous local day's completed app record is an unvalidated proxy
for the survey diary previous day. These weights were NOT trained from
verified actual app preparation start times. Survey-test underprediction was
50.78%; no live rollout without a single-user consent/allowlist and
prospective calibration.

## Deployment scope and remaining work

This repo publishes the ARM64 `respec-prepare-ml` GHCR image. The separate
`respec-server` repo pins that image in `deploy/versions.env` and handles
the team EC2 deployment. **This PR does not change the pinned image, deploy to
EC2, set tokens or switch production alarms.**

The serving code alone cannot change user alarm calculations. The actual
FastAPI planner in `respec-server/api/app/shared/plan.py` still uses
legacy wake-to-departure C1/W4. Its pure-preparation calculation and
persistence must be ported and tested before switching actual app alarms.
