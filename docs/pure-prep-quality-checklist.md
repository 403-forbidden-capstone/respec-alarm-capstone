# Read-only preparation signal QA

After migration 20261123050000, execute the SQL in supabase/tests/prep-signal-quality.sql.
It returns aggregates only: no raw user IDs, times, or sensitive records.

Different signals must remain separate:
- PREPARE_ALARM is alarm dismissal, not physical preparation start.
- LOCATION is inferred departure, not independently verified departure.
- self_reported_prep_started_at is a user tap, not independently verified physical activity.

The CatBoost v2 preview path is OFF by default. Only 10 valid completed historical
PREPARE_ALARM→LOCATION intervals allow a shadow request under explicit consent,
verified age, an exact user allowlist, authenticated HTTPS model and target-provenance flags.
The returned model value never schedules or persists an alarm.

Do not enable a model to control alarm times based on survey proxy labels.
Do not fabricate completed sessions to reach the 10-record gate.
Behavioral ML training requires independently verified consent.

To interpret the audit, examine reported-vs-dismissal gaps and incomplete/implausible
intervals only after genuine user events occur. Same-user, same-KST-day duplicates
are review candidates, not automatic deletions (multiple outings can be legitimate).

An actual client login + button tap must still be tested separately; the demo account
had no eligible upcoming appointments when the previous pilot was deployed.