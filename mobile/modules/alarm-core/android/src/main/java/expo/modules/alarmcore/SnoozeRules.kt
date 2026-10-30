package expo.modules.alarmcore

import java.util.Calendar

// 미루기 규칙 (D3 기본안 A): 5 · 10 · 15분 중 고르기, 알람 한 개당 최대 3번 (한도는 RingPlan.snoozeLimit)
// 네이티브는 계획을 계산하지 않지만, 아래 판단은 "지금 시각"에 달려 있어 폰에서 해야 함. 식은 src/plan.ts의
// canSnooze · snoozeLateMinutes · isSnoozeLate · snoozeCountLabel · snoozeLimitNotice · snoozeButtonLabel · snoozeLateLine · wakeNowBanner와 같고, TS 쪽을 spec/cases.json이 고정함 (바꾸면 둘 다 바꿈)
internal object SnoozeRules {
  // 오래 저장된 알람(계획에 목록 칸이 없던 때)이나 값이 빠졌을 때만 쓰는 목록. 평소엔 TS가 계획에 실어 보냄
  val DEFAULT_OPTIONS: List<Int> = listOf(5, 10, 15)

  const val FALLBACK_LIMIT = 3
  // 늦게 되는 시간 칩 안에 들어가는 글자
  const val LATE_CHIP = "늦어요"

  /** 아직 더 미룰 수 있는지 — 이미 미룬 횟수가 한도에 닿으면 false */
  fun canSnooze(snoozeCount: Int, snoozeLimit: Int): Boolean = snoozeCount < snoozeLimit

  /** 이만큼 미루면 출발 시각(departAt)보다 몇 분 늦는지 — 다시 울릴 시각(지금 + 미룰 분) − 출발 시각을 분으로 올림. 안 늦거나 departAt이 없으면 0 */
  fun lateMinutes(nowMillis: Long, snoozeMinutes: Int, departAtMillis: Long?): Int {
    if (departAtMillis == null) return 0
    val overMillis = nowMillis + snoozeMinutes * 60_000L - departAtMillis
    return if (overMillis > 0) ((overMillis + 59_999L) / 60_000L).toInt() else 0
  }

  fun isLate(nowMillis: Long, snoozeMinutes: Int, departAtMillis: Long?): Boolean =
    lateMinutes(nowMillis, snoozeMinutes, departAtMillis) > 0

  /** 미루기 버튼 글자 — 고른 분이 늦으면 "15분 미루기 · 늦어요" (알림의 미루기 버튼도 같은 글자) */
  fun buttonLabel(snoozeMinutes: Int, late: Boolean): String =
    if (late) "${snoozeMinutes}분 미루기 · $LATE_CHIP" else "${snoozeMinutes}분 미루기"

  /** 미루기 버튼 바로 위 경고 한 줄 — "15분 미루면 9:00 출발보다 5분 늦어요" */
  fun lateLine(snoozeMinutes: Int, departAtMillis: Long, lateMinutes: Int): String =
    "${snoozeMinutes}분 미루면 ${clockLabel(departAtMillis)} 출발보다 ${lateMinutes}분 늦어요"

  /** 가장 짧은 미루기(5분)도 늦을 때 위쪽에 뜨는 경고 띠 */
  fun wakeNowBanner(departAtMillis: Long): String = "지금 일어나야 ${clockLabel(departAtMillis)} 출발에 맞아요"

  fun countLabel(snoozeCount: Int, snoozeLimit: Int): String = "미루기 $snoozeCount/${snoozeLimit}회"

  /** 한도에 닿았을 때의 안내. 출발 시각이 없으면 시각 없이 */
  fun limitNotice(departAtMillis: Long?): String =
    if (departAtMillis == null) "지금 바로 준비" else "지금 바로 준비 · ${timeLabel(departAtMillis)} 출발"

  /** 알림 · 알람 화면에서 쓰는 기본 미루기 분 (알림의 "미루기" 버튼). 계획의 기본 미루기 시간, 없으면 10분 */
  fun defaultMinutes(plan: RingPlan): Int =
    (plan.snoozeMillis / 60_000L).toInt().takeIf { it > 0 } ?: 10

  // "9:00" — 오전 · 오후 없는 시:분 (앱의 timeParts().hm과 같은 모양, 폰의 시간대 기준)
  fun clockLabel(millis: Long): String {
    val calendar = Calendar.getInstance().apply { timeInMillis = millis }
    val hour = calendar.get(Calendar.HOUR_OF_DAY)
    val hour12 = if (hour % 12 == 0) 12 else hour % 12
    return "$hour12:${calendar.get(Calendar.MINUTE).toString().padStart(2, '0')}"
  }

  // "오전 8:40" — 앱의 formatTime과 같은 모양, 폰의 시간대 기준
  fun timeLabel(millis: Long): String {
    val calendar = Calendar.getInstance().apply { timeInMillis = millis }
    val hour = calendar.get(Calendar.HOUR_OF_DAY)
    val minute = calendar.get(Calendar.MINUTE)
    val period = if (hour < 12) "오전" else "오후"
    val hour12 = if (hour % 12 == 0) 12 else hour % 12
    return "$period $hour12:${minute.toString().padStart(2, '0')}"
  }
}
