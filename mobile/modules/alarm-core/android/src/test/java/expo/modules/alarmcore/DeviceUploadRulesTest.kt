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
  fun buttonsAndWakeDismissUploadRightAway() {
    assertTrue(DeviceUploadRules.shouldUpload("PREPARE", "ACKNOWLEDGED")) // 준비 시작
    assertTrue(DeviceUploadRules.shouldUpload("DEPARTURE", "ACKNOWLEDGED")) // 출발했어요
    assertTrue(DeviceUploadRules.shouldUpload("ARRIVE", "ARRIVAL_CONFIRMED")) // 도착했어요
    assertTrue(DeviceUploadRules.shouldUpload("ROUTINE", "ACKNOWLEDGED")) // 루틴 했어요
    assertTrue(DeviceUploadRules.shouldUpload("WAKE", "DISMISSED"))
    assertFalse(DeviceUploadRules.shouldUpload("PREPARE", "DISMISSED"))
    assertFalse(DeviceUploadRules.shouldUpload("WAKE", "TRIGGERED"))
    assertFalse(DeviceUploadRules.shouldUpload("WAKE", "SNOOZED"))
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
}
