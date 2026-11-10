package expo.modules.alarmcore

// 울릴 때의 음성 단계 1~4 — 공통 TS(_shared/briefing.ts levelAt)와 같은 식. 고치면 둘 다 고치고 spec/urgency-cases.json으로 확인
//   서버가 "긴급이 되는 시각"(urgentAt: 남은 여유가 5분 이하가 되는 순간, 준비 · 이동을 모르면 null)을 미리 계산해 줌 → 폰은 비교만 (네트워크 없음)
//   실제 긴급이면 4(미루기 없이도), 아니면 미루기로 1 · 2 · 3 (미루기만으로는 4가 안 됨). 사용자 상한(maxLevel)을 넘지 않음
// 안드로이드 클래스를 안 써서 JVM 단위 시험으로 확인 (src/test/.../SpeechUrgencyTest.kt)
object SpeechUrgency {
  fun level(snoozeCount: Int, nowMillis: Long, urgentAt: Long?, maxLevel: Int): Int {
    val level = if (urgentAt != null && nowMillis > urgentAt) 4 else minOf(maxOf(0, snoozeCount) + 1, 3)
    return minOf(level, maxLevel).coerceAtLeast(1)
  }
}
