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
   * 바로 올릴 기록인지 (서버 alarm-events-device가 받는 조합과 같음, 11/19 서버 PR 약속)
   *   · 알림 버튼 원탭(도착했어요 · 루틴 했어요) · 예전 준비 시작 · 출발했어요 원탭(ACKNOWLEDGED)
   *   · 해제(DISMISSED) — 기상 · 준비 · 출발 알람. 준비 해제 = 준비 시작, 출발 해제 = 출발이라 서버가 그 시각을 채움
   *   · 울림(TRIGGERED) · 미루기(SNOOZED) — 기상 · 준비 · 출발 · 도착. 친구에게 "알람 울리는 중"을 보이고 서버 놓침 계산을 미룸 (G12)
   * 루틴 알림의 울림은 앱이 열릴 때 올림
   */
  fun shouldUpload(alarmType: String, eventType: String): Boolean = when (eventType) {
    "ACKNOWLEDGED", "ARRIVAL_CONFIRMED" -> true
    "DISMISSED" -> isRingAlarmType(alarmType)
    "TRIGGERED", "SNOOZED" -> isRingAlarmType(alarmType) || alarmType == "ARRIVE"
    else -> false
  }

  /**
   * 이 알람을 해제할 때 출발 확인(ACKNOWLEDGED, BUTTON)도 같이 남길지 — 출발 알람이고 위치로 출발을 판단하지 않는 약속(권한 없음 · 집 위치 없음 등)일 때만.
   * 위치로 판단하는 약속은 해제가 출발이 아니라(DISMISSED만) 실제 출발은 집 이탈 감지 시각. 서버는 ACKNOWLEDGED(DEPARTURE)로 departed_at을 채움
   */
  fun dismissAlsoAcknowledges(alarmType: String, departByLocation: Boolean): Boolean = alarmType == "DEPARTURE" && !departByLocation

  /** 재부팅 · 시간 변경 뒤 저장해 둔 판정 예약을 어떻게 할지 (G7) — 12시간이 지났으면 버림(DROP), 판정 시각이 이미 지났으면 바로 한 번(RUN_NOW), 아직이면 다시 검(RESCHEDULE) */
  enum class JudgeRestore { DROP, RUN_NOW, RESCHEDULE }

  fun judgeRestoreAction(dismissedAtMillis: Long, nowMillis: Long): JudgeRestore = when {
    nowMillis - dismissedAtMillis >= CONFIRMED_WINDOW_MILLIS -> JudgeRestore.DROP
    judgeAtMillis(dismissedAtMillis) <= nowMillis -> JudgeRestore.RUN_NOW
    else -> JudgeRestore.RESCHEDULE
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

  /** 관찰이 끝나는 시각 = 해제 + 10분 */
  fun observeEndMillis(dismissedAtMillis: Long): Long = dismissedAtMillis + (WakeJudge.OBSERVE_MINUTES * 60_000).toLong()

  /** 판정을 거는 시각 = 해제 + 10분 2초 (끝나는 시각 경계를 넘기려고 조금 뒤) */
  fun judgeAtMillis(dismissedAtMillis: Long): Long = observeEndMillis(dismissedAtMillis) + DELAY_MARGIN_MILLIS

  /** 판정을 걸 때까지 기다릴 시간 (이미 지났으면 바로) — 정확 알람을 못 걸 때 쓰는 지연 작업용 */
  fun judgeDelayMillis(dismissedAtMillis: Long, nowMillis: Long): Long = maxOf(0L, judgeAtMillis(dismissedAtMillis) - nowMillis)

  /** 기록 하나 올리는 작업이 부를 주소 — 기록이 없으면(앱이 이미 올리고 지움) · 기기 키가 없으면 · 주소가 이상하면 null = 할 일 없음 */
  fun eventTarget(recordExists: Boolean, credentialUrl: String?): String? =
    if (!recordExists || credentialUrl == null) null else eventsUrl(credentialUrl)

  /** 기상 판정 작업이 부를 주소 — 알람 id · 해제 시각이 없거나 기기 키가 없으면 null = 할 일 없음 */
  fun judgeTarget(alarmId: String?, dismissedAtMillis: Long, credentialUrl: String?): String? =
    if (alarmId.isNullOrEmpty() || dismissedAtMillis <= 0 || credentialUrl == null) null else eventsUrl(credentialUrl)

  /** UsageSpans.read 결과(시작 · 끝 epoch ms를 숫자로 담은 맵) → 구간 목록 */
  fun usageToMillis(raw: List<Map<String, Any>>): List<Pair<Long, Long>> =
    raw.map { (it["startMillis"] as Number).toLong() to (it["endMillis"] as Number).toLong() }

  /** 확정 표시를 이 시간 안에 남겼으면 이미 확정된 것 — 같은 알람이 반복돼도 어제 표시에 안 걸리게 (앱 findRecentDismissedWake와 같은 12시간) */
  const val CONFIRMED_WINDOW_MILLIS = 12 * 60 * 60 * 1000L

  fun isWakeConfirmedRecently(confirmedAtMillis: Long?, nowMillis: Long): Boolean =
    confirmedAtMillis != null && nowMillis - confirmedAtMillis in 0 until CONFIRMED_WINDOW_MILLIS

  /** 해제 10분 뒤 "지금 일어나셨나요?" 알림을 띄울지 — 자동으로 못 정한 경우(PROMPT: 사용 정보 못 읽음 · 사용 적음)만, 이미 확정됐으면 안 띄움. AUTO는 서버로 올리는 작업이 처리 */
  fun shouldPromptWake(result: WakeJudge.Result, alreadyConfirmed: Boolean): Boolean =
    !alreadyConfirmed && result.phase == WakeJudge.Phase.PROMPT

  /** 서버에 보낼 기상 확정 값 */
  data class WakeConfirmation(val alarmId: String, val eventId: String, val confirmedAtIso: String, val recordDate: String, val reportedAtIso: String)

  /** 판정이 AUTO가 아니면 null (아무것도 안 보냄) */
  fun wakeConfirmation(alarmId: String, dismissedAtMillis: Long, result: WakeJudge.Result): WakeConfirmation? {
    val reachedAt = result.reachedAtMillis
    if (result.phase != WakeJudge.Phase.AUTO || reachedAt == null) return null
    return WakeConfirmation(alarmId, wakeConfirmedId(alarmId, dismissedAtMillis), isoUtc(reachedAt), kstDay(reachedAt), isoUtc(dismissedAtMillis))
  }

  /** 기상 확정 기록 번호 — 앱 realWake.ts confirmEventId와 같음: 알람 id + 마지막 해제 시각(ms) */
  fun wakeConfirmedId(alarmId: String, dismissedAtMillis: Long): String = StableUuid.of("wake-confirmed", alarmId, dismissedAtMillis)

  /** 서버 시각 글자 (ISO 8601 UTC, 밀리초까지) */
  fun isoUtc(millis: Long): String =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(millis)

  /** 그날 기록의 날짜 — 앱 lib/format.ts dayKey와 같은 한국 시간 */
  fun kstDay(millis: Long): String =
    SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone("Asia/Seoul") }.format(millis)
}
