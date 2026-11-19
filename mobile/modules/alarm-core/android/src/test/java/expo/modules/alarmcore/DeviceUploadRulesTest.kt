package expo.modules.alarmcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// 앱 번호 공식(docs/alarm-core.md "기록 번호 공식" 시험값 — 앱 lib/__tests__/uuid.test.ts와 같음)과 앱 없이 올리는 규칙
class DeviceUploadRulesTest {
  private val alarmId = "00000000-0000-4000-8000-0000000000b1"

  @Test
  fun stableUuidSameAsTypeScript() {
    assertEquals("4b7f478f-5a2a-542a-92dc-9be071c05742", StableUuid.of("wake-confirmed", alarmId, 1_747_897_200_000L))
    assertEquals("9070d2b1-d569-5c26-acb3-e2e41be9c886", StableUuid.of("wake-confirmed", alarmId, "2025-05-22"))
    assertEquals("8ed95bc9-8f44-5f3c-9235-fc997bb707cb", StableUuid.of("snooze-cancel-dismissed", alarmId, 1_747_897_200_000L))
  }

  @Test
  fun wakeConfirmedIdIsAlarmPlusDismissTime() {
    assertEquals("4b7f478f-5a2a-542a-92dc-9be071c05742", DeviceUploadRules.wakeConfirmedId(alarmId, 1_747_897_200_000L))
    // 해제 시각이 다르면 다른 번호 (다른 해제 = 다른 판정)
    assertFalse(DeviceUploadRules.wakeConfirmedId(alarmId, 1_747_897_200_001L) == DeviceUploadRules.wakeConfirmedId(alarmId, 1_747_897_200_000L))
  }

  @Test
  fun buttonsAndRingAlarmDismissUploadRightAway() {
    assertTrue(DeviceUploadRules.shouldUpload("PREPARE", "ACKNOWLEDGED")) // 예전 APK의 준비 시작 원탭
    assertTrue(DeviceUploadRules.shouldUpload("DEPARTURE", "ACKNOWLEDGED")) // 예전 APK의 출발했어요 원탭
    assertTrue(DeviceUploadRules.shouldUpload("ARRIVE", "ARRIVAL_CONFIRMED")) // 도착했어요
    assertTrue(DeviceUploadRules.shouldUpload("ROUTINE", "ACKNOWLEDGED")) // 루틴 했어요
    // 11/19: 기상 · 준비 · 출발 알람 해제 — 준비 해제 = 준비 시작, 출발 해제 = 출발 (서버가 DISMISSED로 시각을 채움)
    for (type in listOf("WAKE", "PREPARE", "DEPARTURE")) assertTrue(type, DeviceUploadRules.shouldUpload(type, "DISMISSED"))
    assertFalse(DeviceUploadRules.shouldUpload("ARRIVE", "DISMISSED"))
    assertFalse(DeviceUploadRules.shouldUpload("ROUTINE", "DISMISSED"))
  }

  @Test
  fun ringAndSnoozeUploadRightAwayForWakePrepareDepartureArrive() {
    // 서버 alarm-events-device가 받는 조합과 같음 — 친구에게 "알람 울리는 중" · 서버 놓침 계산 (G12)
    for (type in listOf("WAKE", "PREPARE", "DEPARTURE", "ARRIVE")) {
      assertTrue(type, DeviceUploadRules.shouldUpload(type, "TRIGGERED"))
      assertTrue(type, DeviceUploadRules.shouldUpload(type, "SNOOZED"))
    }
    // 루틴 알림의 울림은 앱이 열릴 때 올림
    assertFalse(DeviceUploadRules.shouldUpload("ROUTINE", "TRIGGERED"))
    assertFalse(DeviceUploadRules.shouldUpload("ROUTINE", "SNOOZED"))
    // 서버가 안 받는 종류는 안 올림
    assertFalse(DeviceUploadRules.shouldUpload("WAKE", "MISSED"))
    assertFalse(DeviceUploadRules.shouldUpload("WAKE", "WAKE_CONFIRMED")) // 확정은 WakeJudgeWorker가 따로 (USAGE)
  }

  @Test
  fun departureDismissAlsoAcknowledgesOnlyWithoutLocationDetection() {
    // 위치로 출발을 판단하지 않는 약속(감지 꺼짐)의 출발 알람 해제 = 출발 → 출발 확인(ACKNOWLEDGED)도 남김
    assertTrue(DeviceUploadRules.dismissAlsoAcknowledges("DEPARTURE", departByLocation = false))
    // 위치로 판단하는 약속은 해제만 (실제 출발 = 집 이탈 감지)
    assertFalse(DeviceUploadRules.dismissAlsoAcknowledges("DEPARTURE", departByLocation = true))
    // 준비 · 기상 · 도착은 해당 없음 (준비 해제는 DISMISSED 자체가 준비 시작)
    for (type in listOf("WAKE", "PREPARE", "ARRIVE", "ROUTINE")) {
      assertFalse(type, DeviceUploadRules.dismissAlsoAcknowledges(type, departByLocation = false))
    }
    // 보내는 기록은 둘 다 바로 올림
    assertTrue(DeviceUploadRules.shouldUpload("DEPARTURE", "DISMISSED"))
    assertTrue(DeviceUploadRules.shouldUpload("DEPARTURE", "ACKNOWLEDGED"))
  }

  @Test
  fun ringAlarmTypesAreWakePrepareDeparture() {
    assertEquals(setOf("WAKE", "PREPARE", "DEPARTURE"), RING_ALARM_TYPES)
    assertTrue(isRingAlarmType("PREPARE"))
    assertFalse(isRingAlarmType("ARRIVE"))
    assertFalse(isRingAlarmType("ROUTINE"))
  }

  @Test
  fun onlyWakeDismissStartsJudging() {
    assertTrue(DeviceUploadRules.shouldJudgeWake("WAKE", "DISMISSED"))
    assertFalse(DeviceUploadRules.shouldJudgeWake("WAKE", "SNOOZED"))
    assertFalse(DeviceUploadRules.shouldJudgeWake("PREPARE", "DISMISSED"))
    assertFalse(DeviceUploadRules.shouldJudgeWake("DEPARTURE", "ACKNOWLEDGED"))
  }

  @Test
  fun eventsUrlFollowsBriefingUrl() {
    assertEquals("https://x.supabase.co/functions/v1/alarm-events-device", DeviceUploadRules.eventsUrl("https://x.supabase.co/functions/v1/alarm-briefing-device"))
    assertEquals("http://10.0.2.2:8787/functions/v1/alarm-events-device", DeviceUploadRules.eventsUrl("http://10.0.2.2:8787/functions/v1/alarm-briefing-device/"))
    assertNull(DeviceUploadRules.eventsUrl("https://x.supabase.co/functions/v1/other"))
  }

  @Test
  fun retryOnlyForTransientFailuresWithinLimit() {
    assertFalse(DeviceUploadRules.shouldRetry(200, 0))
    for (status in listOf(400, 401, 403, 404)) assertFalse("$status", DeviceUploadRules.shouldRetry(status, 0)) // 키 만료 · 남의 알람 — 앱이 열릴 때 올림
    for (status in listOf(null, 408, 429, 500, 503)) assertTrue("$status", DeviceUploadRules.shouldRetry(status, 0))
    assertTrue(DeviceUploadRules.shouldRetry(null, DeviceUploadRules.MAX_ATTEMPTS - 2))
    assertFalse(DeviceUploadRules.shouldRetry(null, DeviceUploadRules.MAX_ATTEMPTS - 1))
  }

  @Test
  fun judgeWaitsUntilObserveEnd() {
    val dismissed = 1_795_000_000_000L
    assertEquals(10 * 60_000L + 2_000L, DeviceUploadRules.judgeDelayMillis(dismissed, dismissed))
    assertEquals(2_000L, DeviceUploadRules.judgeDelayMillis(dismissed, dismissed + 600_000L))
    assertEquals(0L, DeviceUploadRules.judgeDelayMillis(dismissed, dismissed + 3_600_000L)) // 폰이 꺼져 있다 켜진 뒤 등 — 바로
  }

  @Test
  fun serverTimeStringsMatchApp() {
    // 2026-11-19 07:25:00 KST = 2026-11-18T22:25:00Z — 앱 dayKey는 한국 시간
    val at = 1_795_040_700_000L
    assertEquals("2026-11-18T22:25:00.000Z", DeviceUploadRules.isoUtc(at))
    assertEquals("2026-11-19", DeviceUploadRules.kstDay(at))
    assertEquals("2026-11-18", DeviceUploadRules.kstDay(at - 8 * 3_600_000L)) // 한국 시간 전날 밤
  }

  private val url = "https://x.supabase.co/functions/v1/alarm-briefing-device"

  @Test
  fun eventWorkerDoesNothingWithoutRecordOrKey() {
    assertEquals("https://x.supabase.co/functions/v1/alarm-events-device", DeviceUploadRules.eventTarget(true, url))
    assertNull(DeviceUploadRules.eventTarget(false, url)) // 앱이 이미 올리고 지움
    assertNull(DeviceUploadRules.eventTarget(true, null)) // 기기 키 없음(로그아웃 · 아직 발급 전)
    assertNull(DeviceUploadRules.eventTarget(true, "https://x.supabase.co/functions/v1/other"))
  }

  @Test
  fun judgeWorkerDoesNothingWithoutInputOrKey() {
    val target = "https://x.supabase.co/functions/v1/alarm-events-device"
    assertEquals(target, DeviceUploadRules.judgeTarget(alarmId, 1_795_000_000_000L, url))
    assertNull(DeviceUploadRules.judgeTarget(null, 1_795_000_000_000L, url))
    assertNull(DeviceUploadRules.judgeTarget("", 1_795_000_000_000L, url))
    assertNull(DeviceUploadRules.judgeTarget(alarmId, 0L, url))
    assertNull(DeviceUploadRules.judgeTarget(alarmId, 1_795_000_000_000L, null))
  }

  @Test
  fun unauthorizedStopsWithoutRetry() {
    // 401(키 만료 · 폐기)은 다시 해도 같음 → 작업 끝 (앱이 열릴 때 올림), 서버 오류는 한도까지 다시
    assertFalse(DeviceUploadRules.shouldRetry(401, 0))
    assertTrue(DeviceUploadRules.shouldRetry(503, 0))
    assertFalse(DeviceUploadRules.shouldRetry(503, DeviceUploadRules.MAX_ATTEMPTS - 1))
  }

  @Test
  fun usageMapsBecomeMillisPairs() {
    // UsageSpans.read는 시작 · 끝을 Double로 담음 (JS 브리지용)
    val raw = listOf<Map<String, Any>>(
      mapOf("startMillis" to 1_795_000_030_000.0, "endMillis" to 1_795_000_090_000.0),
      mapOf("startMillis" to 1_795_000_360_000L, "endMillis" to 1_795_000_420_000L),
    )
    assertEquals(listOf(1_795_000_030_000L to 1_795_000_090_000L, 1_795_000_360_000L to 1_795_000_420_000L), DeviceUploadRules.usageToMillis(raw))
    assertEquals(emptyList<Pair<Long, Long>>(), DeviceUploadRules.usageToMillis(emptyList()))
  }

  @Test
  fun confirmationOnlyWhenAuto() {
    val dismissed = 1_747_897_200_000L
    val spans = WakeJudge.toSpans(dismissed, listOf((dismissed + 30_000) to (dismissed + 90_000), (dismissed + 360_000) to (dismissed + 420_000)))
    val auto = WakeJudge.evaluate(dismissed, dismissed + 11 * 60_000L, spans)
    val c = DeviceUploadRules.wakeConfirmation(alarmId, dismissed, auto)!!
    assertEquals("4b7f478f-5a2a-542a-92dc-9be071c05742", c.eventId) // 앱 번호와 같음
    assertEquals(DeviceUploadRules.isoUtc(dismissed + 90_000), c.confirmedAtIso)
    assertEquals(DeviceUploadRules.isoUtc(dismissed), c.reportedAtIso)
    assertEquals(DeviceUploadRules.kstDay(dismissed + 90_000), c.recordDate)
    // 관찰 중 · 조건 미달 · 사용 정보 없음은 아무것도 안 보냄
    assertNull(DeviceUploadRules.wakeConfirmation(alarmId, dismissed, WakeJudge.evaluate(dismissed, dismissed + 6 * 60_000L, spans)))
    assertNull(DeviceUploadRules.wakeConfirmation(alarmId, dismissed, WakeJudge.evaluate(dismissed, dismissed + 11 * 60_000L, emptyList())))
    assertNull(DeviceUploadRules.wakeConfirmation(alarmId, dismissed, WakeJudge.evaluate(dismissed, dismissed + 11 * 60_000L, null)))
  }

  @Test
  fun judgeIsScheduledTenMinutesTwoSecondsAfterDismiss() {
    val dismissed = 1_795_000_000_000L
    assertEquals(dismissed + 600_000L, DeviceUploadRules.observeEndMillis(dismissed))
    assertEquals(dismissed + 602_000L, DeviceUploadRules.judgeAtMillis(dismissed))
  }

  @Test
  fun wakePromptOnlyWhenAutoCannotDecideAndNotConfirmed() {
    val dismissed = 1_795_000_000_000L
    val at11 = dismissed + 11 * 60_000L
    val spans = WakeJudge.toSpans(dismissed, listOf((dismissed + 30_000) to (dismissed + 90_000), (dismissed + 360_000) to (dismissed + 420_000)))
    // 사용 정보를 못 읽음(권한 없음) · 사용 적음 → 알림
    assertTrue(DeviceUploadRules.shouldPromptWake(WakeJudge.evaluate(dismissed, at11, null), false))
    assertTrue(DeviceUploadRules.shouldPromptWake(WakeJudge.evaluate(dismissed, at11, emptyList()), false))
    // 자동 확정(AUTO)은 알림 없이 서버로 · 관찰 중도 아직 아님
    assertFalse(DeviceUploadRules.shouldPromptWake(WakeJudge.evaluate(dismissed, at11, spans), false))
    assertFalse(DeviceUploadRules.shouldPromptWake(WakeJudge.evaluate(dismissed, dismissed + 6 * 60_000L, emptyList()), false))
    // 이미 확정(먼저 깼어요 · 앱에서 확정)이면 PROMPT여도 안 띄움
    assertFalse(DeviceUploadRules.shouldPromptWake(WakeJudge.evaluate(dismissed, at11, null), true))
  }

  @Test
  fun confirmedMarkCountsOnlyWithinTwelveHours() {
    val now = 1_795_000_000_000L
    assertFalse(DeviceUploadRules.isWakeConfirmedRecently(null, now))
    assertTrue(DeviceUploadRules.isWakeConfirmedRecently(now - 60_000L, now))
    assertTrue(DeviceUploadRules.isWakeConfirmedRecently(now - 11 * 3_600_000L, now))
    assertFalse(DeviceUploadRules.isWakeConfirmedRecently(now - 12 * 3_600_000L, now)) // 어제 같은 알람의 표시에는 안 걸림
    assertFalse(DeviceUploadRules.isWakeConfirmedRecently(now + 1_000L, now))
  }
}
