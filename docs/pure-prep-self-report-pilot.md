# Research pilot: user-confirmed preparation-start tap

Optional and **OFF by default**, independently of PR #587.

An alarm dismissal does not necessarily mean the person physically started
preparing. This pilot collects a separate self-report timestamp for comparison,
without replacing `prepare_started_at` or adjusting existing alarms.

- `EXPO_PUBLIC_PREP_START_SELF_REPORT_PILOT=1` in a dedicated test build.
- On H03 (alarm settings) of a private appointment, a single demo account can
  tap "지금 실제 준비 시작했어요", meaning "I started preparing now".
- Timestamp is created by the server RPC's `now()`, never supplied by the
  client. Existing reports are idempotent. No historical backfill.
- Eligibility is checked by the DB: authenticated `auth.uid()`, exact demo
  allowlist, own private appointment, enabled PREPARE alarm, not departed,
  three hours before to one hour after appointment. SECURITY INVOKER relies
  on own-row RLS; EXECUTE limited to authenticated role.
- Keep the automatic `PREPARE_ALARM` proxy in its original column.
  `self_reported_prep_started_at` is a separate nullable field.
- This is a *self-report*, not an independently verified ground truth and not
  consent to ML training. No model inference uses it yet.

For later study, compare alarm dismissal to the self-report and LOCATION
departure for the same completed sessions. Exclude suspect/duplicate cases
and verify a separate consent basis before model training.

Rollout order: review migration → database migration → authenticated E2E /
RLS tests → enable only the pilot web/mobile build. No production rollout.
