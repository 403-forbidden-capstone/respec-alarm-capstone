# Alarm scheduling check

`android-native-check.md` checks whether the Kotlin code rings. This file checks whether it rings at the right time and for the right alarm. That covers the path from an appointment to a time calculation on the server, then a ring package, phone reservations, the ring log, and back to the server. In this path, each piece is usually right on its own, and the bug sits between two of them: the server and the phone disagree, a sync cancels too much, or a day boundary is read in UTC.

Rules come from `docs/alarm-core.md`. If the diff changes a rule there, the document changes in the same PR.

## When to run this

Run it when the diff touches any of these:

- `modules/alarm-core/src/**` or `modules/alarm-core/spec/**`
- `features/alarm/**`
- app code that calls `schedule`, `cancel`, `list`, `getPendingEvents`, or `markEventsUploaded`
- server code that builds ring packages or `alarms` rows (`_shared/plan*`, `_shared/commit*`, `_shared/ring-package*`, `_shared/calc/**`)
- a migration on `alarms`, `alarm_events`, or the MISSED batch

For Kotlin-only diffs, use `android-native-check.md` instead.

## How to check it

1. **One source of truth.** The server decides times and returns ring packages. The phone runs them as given. Check that the app does not recompute a time the server already decided. Where both sides compute, as in the mock and `_shared/calc`, the shared cases must still pass on both.
2. **Sync between server and phone.** When the app makes phone reservations match the server, it cancels only what the server cancelled (`canceled_alarm_ids`) or no longer has. A snoozed alarm is the same alarm in a new state, so it must not be removed. If the server call fails or the app is offline, existing reservations stay. The sync never cancels everything first and then fails before rescheduling. Schedule new reservations before cancelling old ones, or replace them in one step.
3. **Past and same-minute times.** A time in the past is rejected or skipped, the same way on both sides (the server returns 422). Check what happens at the boundaries: exactly now, one minute ago, after midnight, and when the app was closed while the time passed.
4. **Day boundaries.** Use `Asia/Seoul` explicitly, never the server's UTC or a guess about the device's timezone. "First appointment that day" compares appointment times, not alarm times. A wake time before midnight belongs to the next day's appointment.
5. **Repeats.** The phone never repeats an alarm by itself. The server keeps only the next occurrence. A new occurrence comes from DISMISSED or MISSED, or from the 03:00 batch. Check that no code on the phone assumes more than one occurrence.
6. **Ring log.** Every event carries a `clientEventId`, and uploads are deduplicated on it. `markEventsUploaded` runs only for IDs the server accepted. Events that were never uploaded survive an app restart, and the 1,000-line cap is not hit silently.
7. **Missed-alarm window.** The phone's `unansweredSpanMillis` / `RE_RING_GAP_MINUTES` and the server's MISSED rule use the same total. If either side changes it, `spec/cases.json` and the server or DB rule change in the same PR, or the PR says which one follows.
8. **Undecided fields.** Fields the document marks "stored only", such as vibration, snooze options, `snoozeLimit`, and `voiceText`, are not read yet. Code that starts reading one effectively makes a D-number decision. List it under 확인 필요 with the D-number from `docs/decisions.md`. Don't treat it as a bug.
9. **Web and permissions.** When `isAvailable` is false (web), the code takes the fallback path without throwing. When `canScheduleExactAlarms()` or `canUseFullScreenIntent()` is false, the user is told. An alarm is never dropped without a trace.
10. **Tests.** A change to a time rule has a case in `spec/cases.json` or the calc tests, covering 00:00, 23:59, past, and same-minute. Run `npm test` in `mobile/`. Steps that only show on a real phone go on the report's "웹에서 못 봄" line, not into findings.
