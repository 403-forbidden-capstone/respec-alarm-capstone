package expo.modules.alarmcore

// 울리는 도중에도 휴대폰 현재 시간과 저장된 두 시각을 비교함. 서버(_shared/briefing.ts levelAt)와 같은 규칙.
// 처음 1 → 스누즈 1회 2 → 스누즈 2회 이상 또는 남은 여유 5분 이하 3 → 남은 여유 0분 이하 4.
// 4단계는 스누즈 횟수만으로 발생하지 않음. 인터넷 호출 없음.
object SpeechUrgency {
  fun level(snoozeCount: Int, nowMillis: Long, dangerAt: Long?, urgentAt: Long?, maxLevel: Int): Int {
    val snoozeLevel = minOf(maxOf(0, snoozeCount) + 1, 3)
    val level = when {
      urgentAt != null && nowMillis >= urgentAt -> 4
      dangerAt != null && nowMillis >= dangerAt -> maxOf(3, snoozeLevel)
      else -> snoozeLevel
    }
    return minOf(level, maxLevel).coerceAtLeast(1)
  }
}
