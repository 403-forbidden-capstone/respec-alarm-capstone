# Android native check

This skill's gating tables were written for web and React diffs, so an Android native diff matches almost none of their rows. Android code also has its own failure mode: the bug usually sits in an exit path, an OS-version branch, or an identity rule that the framework enforces silently. Each line can look fine while the alarm still doesn't ring.

Incident (2026-10-07, PR #62, ~1,000-line Kotlin alarm module): the first automatic review triggered only the generic line scan. It caught the snooze-vs-cancel ID bug and the unbounded wake lock. A later manual pass found four more:

- PendingIntent identity relied only on a hashed `requestCode`
- `setAlarmClock` with a past time fired immediately
- snooze stopped the sound before scheduling, so the snooze was silently lost when scheduling failed
- a failed sound resource ended the alarm in silence

This file is that manual pass, written down.

## When to run this

Run it when the diff touches `*.kt`, `*.java`, `AndroidManifest.xml`, `android/**`, `modules/**/android/**`, Gradle files, or an Expo config plugin that edits native files.

## How to check it

1. **PendingIntent identity.** Two PendingIntents are the same if they have the same `requestCode` *and* their Intents are equal under `filterEquals`, which compares action, data, type, class, and categories. Extras are *not* compared. If PendingIntents are created per item (per alarm, per notification) and only extras differ, check that the `requestCode` really is unique. A hash is not unique. Safer: put the item ID in `data`. With `FLAG_UPDATE_CURRENT`, a collision silently overwrites the other item. Also check that every PendingIntent uses `FLAG_IMMUTABLE` unless it must be mutable.
2. **Cancel must cover everything schedule created.** Cancelling uses the same identity as scheduling. Check derived schedules too: snoozes, retries, follow-up reminders, items under derived IDs. Each needs a cancel path, and each needs to be excluded from (or marked in) any list that other code reconciles against a server.
3. **AlarmManager semantics.**
   - **Exact-alarm permission by API level:** on 31–32, `SCHEDULE_EXACT_ALARM` can be revoked; on 33+, `USE_EXACT_ALARM` cannot. Check `canScheduleExactAlarms()` before scheduling, and handle the throw path.
   - **`setAlarmClock` vs `setExactAndAllowWhileIdle`:** `setAlarmClock` shows in the status bar and as the system "next alarm", so use it only for user-visible alarms.
   - **A trigger time in the past fires immediately.** Reject past times or decide explicitly.
   - **Rescheduling:** alarms are lost on reboot, force-stop, and time or timezone changes. Check for `BOOT_COMPLETED` / `TIME_SET` / `TIMEZONE_CHANGED` / exact-alarm-permission-changed handling, and `LOCKED_BOOT_COMPLETED` if alarms must survive a reboot before first unlock.
4. **Foreground services.**
   - `startForeground` runs promptly after `startForegroundService`.
   - `foregroundServiceType` is declared in the manifest, with the matching `FOREGROUND_SERVICE_<TYPE>` permission (34+).
   - The entry path is allowed to start a foreground service from the background (exact alarm and notification action are; most others aren't on 12+).
   - Every exit path (user stop, `stopSelf`, error callback, timeout, `stopService` from elsewhere) releases resources through one function.
   - Anything that runs until the user acts has a timeout.
5. **Wake locks, audio focus, volume.**
   - `acquire(timeout)`, never a bare `acquire()`.
   - Audio focus is abandoned on exit.
   - A changed stream volume is restored on *every* exit path, including a failure before playback started.
   - `MediaPlayer` has an error listener.
   - On critical paths, failure of the primary resource falls back to something audible (an alarm must not end silent).
6. **The user's experience on the failure branch.** `runCatching` around a call that can throw keeps the receiver from crashing. Then check what the user is left with: did the sound already stop, did the screen already close, is the action lost without a trace? Do the irreversible step (stopping the sound, closing the screen) *after* the step that can fail.
7. **Notification channels.** A channel's importance, sound, and vibration are fixed once the channel is created; changing them needs a new channel ID. Behavior that must vary per item (intensity-dependent vibration, for example) can't live in the channel. `POST_NOTIFICATIONS` is a runtime permission on 33+. Full-screen intents are limited on 34+ (`canUseFullScreenIntent()`). Notification action request codes must be distinct.
8. **Broadcast receivers.** They run on the main thread with a roughly 10-second limit: no network or heavy disk work without `goAsync()` or WorkManager. Check that exported receivers have a reason to be exported and that their intent filters are only as broad as needed.
9. **Activities over the lock screen.**
   - `setShowWhenLocked` / `setTurnScreenOn` on 27+, legacy window flags below.
   - The screen closes when the underlying state ends (ringing stopped from anywhere) and does not close while that state continues.
   - Handle the late-launch race: the activity can be created after the state already ended.
10. **Static and companion state.** It lives only as long as the process; process death resets it. Fields shared across threads need `@Volatile` or confinement to one thread.
11. **API-level guards.** Every call above `minSdk` must sit behind a `Build.VERSION` check for that exact level. Check the level, not just that a check exists.
12. **Persisted formats.** SharedPreferences and DataStore keys are a schema. If fields will grow (intensity, type, counters), prefer one serialized record per item plus a version, before real data exists on devices. Use `apply` for async writes; use `commit` only where the next line depends on the write.
13. **JS bridge (Expo modules).**
    - `Function` runs synchronously on the JS thread; `AsyncFunction` runs on a background queue and is required for async platform APIs on the other platform.
    - A missing `reactContext` must throw (`Exceptions.ReactContextLost()`), never return success.
    - Native exceptions become Promise rejections, so their messages should be useful to the screen.
    - The TS wrapper's types match the native return shape.
14. **Testability.** Pure logic (time calculation, ID derivation, retry and snooze rules) should be in plain Kotlin that a JVM unit test can reach without an emulator.

## Severity framing for the report

- Anything that can make an alarm or notification not fire, or fire silently, is at least medium, however rare. "It rang for nobody" is the failure users never forgive.
- Leaked wake locks, unrestored volume, and services that never stop are medium: they drain the battery or change user settings beyond the app's lifetime.
- An identity collision whose probability is negligible today is low, but say what makes it grow (more items, shorter IDs).
- Missing API-level guards are high if `minSdk` is below the API's level: that's a crash on real devices.
