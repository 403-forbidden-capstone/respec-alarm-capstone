package expo.modules.alarmcore

// 브리핑을 무엇으로 읽을지 정하는 순수 규칙 — 안드로이드 클래스를 안 써서 JVM 단위 시험으로 확인 (src/test/.../BriefingRulesTest.kt)
// 우선순위: 기본 알람음(늘, 이 규칙과 무관) > 개인화 브리핑(Android 오프라인 TTS) > Gemini 감정 음성. 어느 단계든 못 하면 알람음 · 진동만
object BriefingRules {
  // TextToSpeech.isLanguageAvailable · setLanguage 결과 값 (안드로이드 상수와 같은 수)
  const val LANG_AVAILABLE = 0
  const val LANG_MISSING_DATA = -1
  const val LANG_NOT_SUPPORTED = -2

  data class VoiceInfo(val name: String, val language: String, val networkRequired: Boolean)

  sealed class VoiceChoice {
    data class Use(val name: String) : VoiceChoice()
    // 엔진이 목소리 목록을 안 줌 — 한국어 확인은 통과했으니 엔진 기본 목소리로
    object EngineDefault : VoiceChoice()
    data class Skip(val reason: String) : VoiceChoice()
  }

  /** 인터넷 없이 읽을 수 있는 한국어 목소리만. 한국어 데이터가 없거나 인터넷이 필요한 목소리뿐이면 Skip(알람음만) */
  fun offlineVoice(langStatus: Int, voices: List<VoiceInfo>, index: Int): VoiceChoice {
    if (langStatus < LANG_AVAILABLE) return VoiceChoice.Skip(if (langStatus == LANG_MISSING_DATA) "한국어 TTS 데이터 없음" else "한국어 TTS 지원 안 함")
    val korean = voices.filter { it.language == "ko" }
    val offline = korean.filter { !it.networkRequired }.sortedBy { it.name }
    if (offline.isNotEmpty()) return VoiceChoice.Use(offline[index.mod(offline.size)].name)
    if (korean.isNotEmpty()) return VoiceChoice.Skip("인터넷이 필요한 한국어 목소리만 있음")
    return VoiceChoice.EngineDefault
  }

  /** 해제 전까지 같은 브리핑을 반복하는지 — 기상만. 출발은 알림음 · 진동 한 번 + 브리핑 한 번으로 끝 */
  fun repeatsBriefing(alarmType: String): Boolean = alarmType == "WAKE"

  /** 고른 단계의 문장이 없으면 그보다 낮은 단계 중 있는 것 */
  fun clipLevel(wanted: Int, available: Set<Int>): Int? = (wanted downTo 1).firstOrNull { it in available }

  /** Gemini 음성은 긴급(4단계) 문장이고 파일이 폰에 있을 때만 — 아니면 같은 문장을 Android TTS로 */
  fun useGemini(clipLevel: Int, wavExists: Boolean): Boolean = clipLevel == 4 && wavExists

  data class Fallback(val level: Int, val text: String, val pitch: Float, val rate: Float)

  // 서버 브리핑이 한 번도 안 왔을 때(인터넷 없음 등)의 높낮이 · 속도 — TS androidVoice의 보통 말투와 같은 값
  private val FALLBACK_VOICE = mapOf(1 to (1.0f to 1.0f), 2 to (1.05f to 1.1f), 3 to (1.1f to 1.2f))

  /**
   * 저장된 브리핑이 없을 때 읽을 것 — 기상은 꾸러미의 기상 문장(voiceText, 앱이 오프라인으로 만듦), 출발은 알림 줄(출발 · 도착 안내) + 제목
   * 미루기 횟수만으로 단계를 올림 (약속 · 이동 정보가 없어 지각 위험은 모름 → 긴급 4단계 없음). "미뤘다"는 미루기로 올라갔을 때만이라 사실
   */
  fun fallback(type: String, voiceText: String?, heading: String, title: String, snoozeCount: Int): Fallback? {
    val base = (if (type == "WAKE") voiceText?.takeIf { it.isNotBlank() } else null)
      ?: listOf(heading, title).filter { it.isNotBlank() }.joinToString(". ")
    if (base.isBlank()) return null
    val level = SpeechUrgency.level(snoozeCount, 0L, null, 3)
    val prefix = when (level) {
      2 -> "알람을 한 번 미뤘어요. 이제 일어나야 해요. "
      3 -> "알람을 여러 번 미뤘어요. 지금 바로 일어나세요! "
      else -> ""
    }
    val (pitch, rate) = FALLBACK_VOICE.getValue(level)
    return Fallback(level, prefix + base, pitch, rate)
  }
}
