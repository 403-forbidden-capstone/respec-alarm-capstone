package expo.modules.alarmcore

// 울리는 도중에도 휴대폰 현재 시간과 저장된 여유 0분 시각을 비교함. 서버(_shared/briefing.ts levelAt)와 같은 규칙.
// 말소리 시작 단계(약 1 · 중 2 · 강 3, manifest rule.startLevel) + 미루기 횟수, 상한 3 → 남은 여유 0분 이하면 4.
// 4단계는 미루기 횟수만으로 발생하지 않음. 인터넷 호출 없음.
object SpeechUrgency {
  fun level(snoozeCount: Int, nowMillis: Long, urgentAt: Long?, maxLevel: Int, startLevel: Int = 1): Int {
    val level = if (urgentAt != null && nowMillis >= urgentAt) 4 else minOf(startLevel.coerceIn(1, 3) + maxOf(0, snoozeCount), 3)
    return minOf(level, maxLevel).coerceAtLeast(1)
  }

  /** 말소리(alarms.voice_tone) → 시작 단계. 모르는 값 · 없음은 null (서버 _shared/briefing.ts START_LEVEL과 같은 표) */
  fun startLevelOf(voiceTone: String?): Int? = when (voiceTone) {
    "CALM" -> 1
    "NEUTRAL" -> 2
    "DIRECT" -> 3
    else -> null
  }

  /** 이번 울림의 시작 단계 — 예약 꾸러미의 말소리(최신 설정)가 먼저, 없으면 저장된 브리핑 값(briefed, 브리핑이 없으면 1) */
  fun startLevel(voiceTone: String?, briefed: Int): Int = startLevelOf(voiceTone) ?: briefed

  /** 울리는 중 음성 교체 — 이번 울림에서 이미 시작한 가장 높은 단계(peak)보다 높을 때만. 브리핑이 새로 저장돼 단계가 낮게 나와도 내리지 않음 */
  fun shouldSwitch(next: Int, peak: Int?): Boolean = peak == null || next > peak
}
