package expo.modules.alarmcore

import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

// 폰이 앱을 열지 않고 서버로 바로 올리는 기록의 규칙 — 안드로이드 API 없이 JVM 단위 시험으로 돎 (DeviceUploadRulesTest)
object DeviceUploadRules {
  const val MAX_ATTEMPTS = 5 // 연결 실패 · 서버 오류 때 다시 시도하는 한도 — 넘으면 포기하고 앱이 열릴 때 올림
  private const val BRIEFING_FUNCTION = "/alarm-briefing-device"
  private const val EVENTS_FUNCTION = "/alarm-events-device"
  private const val DELAY_MARGIN_MILLIS = 2_000L // 관찰이 끝난 직후가 아니라 조금 뒤에 판정 (끝나는 시각 경계)

  /**
   * 바로 올릴 기록인지 — 알림 버튼(원탭: 준비 시작 · 출발했어요 · 도착했어요 · 루틴 했어요) · 기상 알람 해제
   * 울림(TRIGGERED) · 미루기(SNOOZED) · 다른 알람의 해제는 앱이 열릴 때 올림
   */
  fun shouldUpload(alarmType: String, eventType: String): Boolean = when (eventType) {
    "ACKNOWLEDGED", "ARRIVAL_CONFIRMED" -> true
    "DISMISSED" -> alarmType == "WAKE"
    else -> false
  }

  /** 기상 알람 해제 기록이면 해제 + 10분 판정 작업을 검 */
  fun shouldJudgeWake(alarmType: String, eventType: String): Boolean = alarmType == "WAKE" && eventType == "DISMISSED"

  /**
   * 기기 키에 담긴 함수 주소(alarm-briefing-device) → 기록 올리는 함수 주소. 같은 서버 · 같은 키를 씀
   * 주소가 예상한 모양이 아니면 null (아무것도 안 함)
   */
  fun eventsUrl(briefingUrl: String): String? {
    val trimmed = briefingUrl.trimEnd('/')
    return if (trimmed.endsWith(BRIEFING_FUNCTION)) trimmed.removeSuffix(BRIEFING_FUNCTION) + EVENTS_FUNCTION else null
  }

  /** 응답 상태 → 다시 시도할지. 2xx 끝 · 401(키 만료) · 403 · 404 · 400은 다시 해도 같음 → 그만 (앱이 열릴 때 올림) · 408 · 429 · 5xx · 연결 실패(null)는 한도까지 다시 */
  fun shouldRetry(status: Int?, attempt: Int): Boolean =
    BriefingRules.refreshOutcome(status) == BriefingRules.RefreshOutcome.RETRY && attempt + 1 < MAX_ATTEMPTS

  /** 해제 + 10분 판정을 걸 때까지 기다릴 시간 (이미 지났으면 바로) */
  fun judgeDelayMillis(dismissedAtMillis: Long, nowMillis: Long): Long =
    maxOf(0L, dismissedAtMillis + (WakeJudge.OBSERVE_MINUTES * 60_000).toLong() + DELAY_MARGIN_MILLIS - nowMillis)

  /** 기상 확정 기록 번호 — 앱 realWake.ts confirmEventId와 같음: 알람 id + 마지막 해제 시각(ms) */
  fun wakeConfirmedId(alarmId: String, dismissedAtMillis: Long): String = StableUuid.of("wake-confirmed", alarmId, dismissedAtMillis)

  /** 서버 시각 글자 (ISO 8601 UTC, 밀리초까지) */
  fun isoUtc(millis: Long): String =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(millis)

  /** 그날 기록의 날짜 — 앱 lib/format.ts dayKey와 같은 한국 시간 */
  fun kstDay(millis: Long): String =
    SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone("Asia/Seoul") }.format(millis)
}
