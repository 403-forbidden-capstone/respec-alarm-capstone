# Prepare-start integration — phase 1 implementation / migration runbook

Status: **Draft, not deployed**. The existing alarm path continues to use `default_prepare_minutes` (wake→departure). Do not interpret phase 1 as an active ML rollout.

## Done (code in this branch)
- Nullable `profiles.default_outing_prep_minutes` (5–240 min) — explicitly user-entered *prepare start → physical departure*.
- Nullable appointment-level `outing_prep_minutes`, `outing_prep_source`, `outing_prep_model` to preserve independently the new duration/provenance.
- Existing legacy `profiles.default_prepare_minutes`, `appointment_participants.prepare_minutes`, `daily_records.actual_prepare_minutes` unchanged and not backfilled.
- Added separate inputs on onboarding and settings. Current users show “미설정” until intentionally confirmed; 30 minutes displayed is an example, not silently stored.
- `purePrepAlarmChain` converts pure prep and pre-prep wake lead to the existing chain calculator without modifying the existing 20-minute constant.
- Isolated Node test harness using matching calculator logic: 6/6 pass. **Not a substitute for full project CI/typecheck.**

## Core invariant
- `depart = appointment - travel - arrival_buffer`
- `prepare = depart - pure_prep_duration`
- `wake = prepare - pre_prep_tasks - fixed_lead_20` only when a WAKE alarm is intended.
- Afternoon/second appointments still have PREPARE and DEPARTURE; WAKE remains omitted.
- Explicit manually selected times retain precedence.
- Existing 20-minute rule remains untouched.

## Deployment ordering
1. Review schema migration and privacy implications. Run original project database test suite and Supabase security advisors.
2. Deploy migration `20261119103000_pure_outing_prep_semantics.sql` **before** any mobile/Edge release referencing the new columns. Confirm `profiles.default_outing_prep_minutes` remains NULL for all existing users (no backfill).
3. Ship mobile UI and verify real onboarding and settings save. For an existing account, display `미설정` and require user confirmation before use.
4. Follow-up integration PR: fix `createCommitBody`/`existingBody` auto-vs-manual ambiguity, preserve snapshots in preview/commit, and propagate pure prep inference to all `computePlan` callers (`roll.ts`, `edit-run.ts`, schedule/AI flows).
5. Follow-up model PR (#549): rebase onto phase 1, use versioned model protocol and confirmed history. `survey_start_cluster_proxy` is research-only, `actual_start_depart` only after real-user verification.
6. Shadow logging (restricted UUID allowlist) and device E2E; only then switch actual alarms and retire legacy C1/W4.

## Important unresolved items
- New UI **collects** pure prep, but phase 1 intentionally does NOT change server alarm computation. A user entering 35 minutes still has legacy alarms until phase 2.
- Existing `prepare_minutes` in H05/H03 gets sent as if manually overridden. Recalculation would currently be bypassed. Must preserve AUTO vs MANUAL and compatible snapshot behavior.
- Existing `PREPARE` alarm dismissal is not necessarily physical start; `departed_at` LOCATION may be delayed. Verify label quality and consent before training on app records.
- A user with only onboarding self-report was not represented in survey CatBoost training. Until validated, use self-report baseline unmodified or shadow predictions only.
- Stage 1 has no live DB changes, Edge function redeploy, model service swap, or merge to `main`.

## QA matrix
| Case | Expected |
|---|---|
| 10:00 appointment, ETA30, arrival buffer10, pure prep35, lead20 | DEPART 09:20, PREPARE 08:45, WAKE 08:25 |
| Add 30m breakfast before prep | PREPARE 08:45, WAKE 07:55 |
| Pure prep +15m | PREPARE 08:30, WAKE 08:10 |
| 17:00 afternoon with WAKE absent, ETA20, buffer5, prep35 | DEPART 16:35, PREPARE 16:00 |
| Existing user old 60min default | `default_outing_prep_minutes=NULL`; never auto-convert |
| Explicit manual PREPARE | Manual time wins, automatic value retained |
| Existing C1/W4 and P80 | Same behavior until versioned, validated model gate is enabled |
