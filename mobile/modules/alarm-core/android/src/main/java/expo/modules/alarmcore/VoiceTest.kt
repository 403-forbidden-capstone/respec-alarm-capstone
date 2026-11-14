package expo.modules.alarmcore

// 개발 화면(dev/alarm-test) AI 음성 시험 전용 규칙 — 시험 알람 id 앞머리로만 구분해서 운영 알람에는 적용되지 않음
//   안드로이드 클래스를 안 써서 JVM 단위 시험으로 확인 (src/test/.../VoiceTestTest.kt)
object VoiceTest {
  // 앱 lib/alarmSync/devAlarm.ts DEV_ALARM_ID_PREFIX와 같은 값 — 고치면 둘 다
  const val ALARM_ID_PREFIX = "de70a1a0-"

  fun isTestAlarm(alarmId: String): Boolean = alarmId.startsWith(ALARM_ID_PREFIX)

  // AI 음성 시험 알람만 — 개발 알람 중 앞머리가 더 긴 것. [즉시 정지]가 "1분 뒤 울리기" 같은 개발 예약 알람을 지우지 않게 (앱 devAlarm.ts와 같은 값)
  const val VOICE_ID_PREFIX = "de70a1a0-a1ce-"

  fun isVoiceTestAlarm(alarmId: String): Boolean = alarmId.startsWith(VOICE_ID_PREFIX)

  /**
   * 3 · 4단계 음성 출처 모의 — 새 Gemini 호출은 어느 것도 없음
   *   CACHE: 실제 알람이 받아 둔 개인화 캐시를 빌려 옴(없으면 그 단계 예비 WAV)
   *   FALLBACK: 캐시 없음 = 한도 초과 · 네트워크 실패 · 비행기 모드와 같은 상태 → 그 단계 예비 WAV
   *   BROKEN: 깨진 캐시 파일 → 재생 실패 후 예비 WAV로 넘어가는지
   *   ANDROID: 예비 WAV까지 못 쓰는 상태 → Android TTS 대체
   */
  fun geminiMode(value: String?): String = when (value) {
    "FALLBACK", "BROKEN", "ANDROID" -> value
    else -> "CACHE"
  }

  /** 시험에서 끌 수 있는 것 — 알람음(크기만 0, 재생 경로 · 포커스 · 진동 · 음성은 그대로) · AI 음성 */
  data class Options(val sound: Boolean = true, val voice: Boolean = true)

  /** 운영 알람은 저장된 값이 있어도 늘 켬 (시험 값이 운영 알람을 조용하게 만들지 못하게) */
  fun options(alarmId: String, sound: Boolean?, voice: Boolean?): Options =
    if (isTestAlarm(alarmId)) Options(sound ?: true, voice ?: true) else Options()

  data class GeminiCandidate(val alarmId: String, val hasWav: Boolean, val hash: String?, val text: String?)

  /** 4단계 시험에 빌려 올 Gemini 음성 — 실제 알람이 미리 받아 둔 것 중 파일 · 열쇠 · 문장이 다 있는 첫 것. 시험 알람 폴더는 안 봄. 없으면 null(→ Android TTS 대체) */
  fun pickGeminiSource(candidates: List<GeminiCandidate>): GeminiCandidate? =
    candidates.sortedBy { it.alarmId }.firstOrNull { !isTestAlarm(it.alarmId) && it.hasWav && !it.hash.isNullOrEmpty() && !it.text.isNullOrBlank() }

  /** 화면에 보일 엔진 — 이번 울림이 실제로 고른 Speech 기준 (hasWav = 개인화 캐시 또는 예비 WAV) */
  fun engine(hasSpeech: Boolean, hasWav: Boolean): String = when {
    !hasSpeech -> "NONE"
    hasWav -> "GEMINI"
    else -> "ANDROID"
  }
}
