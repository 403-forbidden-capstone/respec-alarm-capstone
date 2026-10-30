package expo.modules.alarmcore

import java.util.Calendar

// 미루기 규칙 (D3 A, 10/29): 5 · 10 · 15분 중 고르기, 알람 한 개당 최대 3번 (한도는 RingPlan.snoozeLimit)
// 네이티브는 계획을 계산하지 않지만, 아래 판단은 "지금 시각"에 달려 있어 폰에서 해야 함. 식은 src/plan.ts의
// canSnooze · isSnoozeLate · snoozeCountLabel · snoozeLimitNotice와 같고, TS 쪽을 spec/cases.json이 고정함 (바꾸면 둘 다 바꿈)
internal object SnoozeRules {
  // 오래 저장된 알람(계획에 목록 칸이 없던 때)이나 값이 빠졌을 때만 쓰는 목록. 평소엔 TS가 계획에 실어 보냄
  val DEFAULT_OPTIONS: List<Int> = listOf(5, 10, 15)

  const val FALLBACK_LIMIT = 3
  const val LATE_LABEL = "이만큼 미루면 늦어요"

  /** 아직 더 미룰 수 있는지 — 이미 미룬 횟수가 한도에 닿으면 false */
  fun canSnooze(snoozeCount: Int, snoozeLimit: Int): Boolean = snoozeCount < snoozeLimit

  /** 다시 울릴 시각(지금 + 미룰 분)이 출발 시각(departAt)을 넘으면 늦음. departAt이 없으면 판단하지 않음(false) */
  fun isLate(nowMillis: Long, snoozeMinutes: Int, departAtMillis: Long?): Boolean =
    departAtMillis != null && nowMillis + snoozeMinutes * 60_000L > departAtMillis

  fun countLabel(snoozeCount: Int, snoozeLimit: Int): String = "미루기 $snoozeCount/${snoozeLimit}회"

  /** 한도에 닿았을 때의 안내. 출발 시각이 없으면 시각 없이 */
  fun limitNotice(departAtMillis: Long?): String =
    if (departAtMillis == null) "지금 바로 준비" else "지금 바로 준비 · ${timeLabel(departAtMillis)} 출발"

  /** 알림 · 알람 화면에서 쓰는 기본 미루기 분 (알림의 "미루기" 버튼). 계획의 기본 미루기 시간, 없으면 10분 */
  fun defaultMinutes(plan: RingPlan): Int =
    (plan.snoozeMillis / 60_000L).toInt().takeIf { it > 0 } ?: 10

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
