package expo.modules.alarmcore

// 알람 강도를 축별로 나눈 값: 진동 패턴 3개 · 배경음 파일 3개 (결정 D1 A, #312)
// 볼륨 · 다시 울림은 여기가 아니라 울림 계획(RingPlan.volumePercent · reRingOffsetsMillis)이 정함 — TS가 intensity로 계산해 넘김
// 말소리(TTS)는 이번 범위 밖 (D8). 안드로이드 클래스를 안 써서 JVM 단위 시험으로 확인하기 쉬움

/** 진동 3종 — 앱이 넘기는 `vibration` 글자와 같은 이름 */
object AlarmVibration {
  const val NONE = "NONE"
  const val SHORT_REPEAT = "SHORT_REPEAT"
  const val STRONG_CONTINUOUS = "STRONG_CONTINUOUS"

  // 켜짐 · 꺼짐 ms 반복 (앞의 0은 바로 시작). 서비스가 처음부터 무한 반복(repeat = 0)으로 틂
  // 짧게 반복: 0.2초 울리고 0.3초 쉼 / 강하게 연속: 0.8초 울리고 0.1초만 쉼(거의 끊기지 않음)
  private val SHORT_REPEAT_PATTERN = longArrayOf(0, 200, 300)
  private val STRONG_CONTINUOUS_PATTERN = longArrayOf(0, 800, 100)

  private val KNOWN = setOf(NONE, SHORT_REPEAT, STRONG_CONTINUOUS)

  /** 강도에서 정하는 기본 진동 (칸이 없는 예전 저장 알람 · 모르는 값): SOFT → 없음, NORMAL → 짧게 반복, STRONG → 강하게 연속 */
  fun defaultFor(intensity: String): String = when (intensity) {
    "SOFT" -> NONE
    "STRONG" -> STRONG_CONTINUOUS
    else -> SHORT_REPEAT
  }

  /** 받은 값이 3종 중 하나면 그대로, 없거나 모르는 값이면 강도에서 */
  // L6 안건후보: 모르는 vibration 값 처리 기본안 = 강도 기본값으로 바꿔 저장(진동이 예기치 않게 꺼지지 않게). 예: 나중에 TS가 새 값을 더했는데 옛 APK가 받는 경우
  fun normalize(value: String?, intensity: String): String =
    if (value != null && value in KNOWN) value else defaultFor(intensity)

  /** 진동 패턴. 진동 없음이면 null (서비스가 진동을 건너뜀) */
  fun patternFor(vibration: String): LongArray? = when (vibration) {
    NONE -> null
    STRONG_CONTINUOUS -> STRONG_CONTINUOUS_PATTERN.copyOf()
    else -> SHORT_REPEAT_PATTERN.copyOf()
  }
}

/** 배경음 소리 키 — 앱이 넘기는 `soundKey` 글자와 같은 이름. 파일은 res/raw/<키>.wav (mobile/scripts/make-alarm-sounds.mjs가 합성) */
object AlarmSoundKeys {
  // 기본 키: 폰 기본 알람음을 먼저 틀고 앱 파일(alarm_siren)은 예비. 모르는 키도 이 길
  const val DEFAULT = "default"
  const val CALM = "theme_calm"
  const val NORMAL = "theme_default"
  const val URGENT = "theme_urgent"

  /** 강도에서 정하는 기본 소리 키 (계획에도 소리 키가 없을 때): SOFT → 약, STRONG → 강, 그 밖 → 보통 */
  fun defaultFor(intensity: String): String = when (intensity) {
    "SOFT" -> CALM
    "STRONG" -> URGENT
    else -> NORMAL
  }

  /**
   * 앱 파일을 먼저 틀 키인지 — 파일이 있는 키 중 약(`theme_calm`) · 강(`theme_urgent`)만.
   * 기본 키(`default`) · 보통(`theme_default`) · 모르는 키는 폰 기본 알람음이 먼저이고 앱 파일은 예비
   * (지형님 10/30 — 10/18 "안드로이드 기본 알람 정도는" 결정: 보통 알람은 폰 기본 알람음)
   */
  fun playsOwnFileFirst(soundKey: String, hasOwnFile: Boolean): Boolean = hasOwnFile && soundKey != DEFAULT && soundKey != NORMAL
}
