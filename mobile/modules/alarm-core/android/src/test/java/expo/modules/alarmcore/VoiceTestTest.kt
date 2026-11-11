package expo.modules.alarmcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// 개발 화면 AI 음성 시험 규칙 — 운영 알람과 분리 · Gemini 캐시 빌려 오기 · 엔진 표시 · 출발 1회 / 기상 반복
class VoiceTestTest {
  private val testId = VoiceTest.ALARM_ID_PREFIX + "1234-5678"
  private val realId = "11111111-2222-3333-4444-555555555555"

  @Test
  fun onlyTestAlarmsCanTurnSoundOrVoiceOff() {
    assertEquals(VoiceTest.Options(sound = false, voice = true), VoiceTest.options(testId, false, null))
    assertEquals(VoiceTest.Options(sound = true, voice = false), VoiceTest.options(testId, null, false))
    // 운영 알람은 값이 섞여 들어와도 늘 소리 · 음성 켬
    assertEquals(VoiceTest.Options(), VoiceTest.options(realId, false, false))
  }

  @Test
  fun geminiSourceIsRealCachedClipOnly() {
    val candidates = listOf(
      VoiceTest.GeminiCandidate(testId, true, "aaaaaaaaaaaaaaaa", "시험"), // 시험 폴더는 안 봄
      VoiceTest.GeminiCandidate("b-real", false, "bbbbbbbbbbbbbbbb", "파일 없음"),
      VoiceTest.GeminiCandidate("c-real", true, null, "열쇠 없음"),
      VoiceTest.GeminiCandidate("d-real", true, "dddddddddddddddd", "야!!!! 지금 당장 일어나!!!!"),
    )
    assertEquals("d-real", VoiceTest.pickGeminiSource(candidates)?.alarmId)
    // 캐시가 없으면 null → 4단계도 Android TTS로 대체 (새 Gemini 호출 없음)
    assertNull(VoiceTest.pickGeminiSource(candidates.take(3)))
    assertNull(VoiceTest.pickGeminiSource(emptyList()))
  }

  @Test
  fun engineShownFromActualSpeech() {
    assertEquals("GEMINI", VoiceTest.engine(hasSpeech = true, hasWav = true))
    assertEquals("ANDROID", VoiceTest.engine(hasSpeech = true, hasWav = false))
    assertEquals("NONE", VoiceTest.engine(hasSpeech = false, hasWav = false)) // 알람음만 · 진동만
  }

  @Test
  fun wakeRepeatsDepartureSpeaksOnce() {
    assertTrue(BriefingRules.repeatsBriefing("WAKE"))
    assertFalse(BriefingRules.repeatsBriefing("DEPARTURE"))
    assertFalse(BriefingRules.repeatsBriefing("PREPARE"))
  }

  @Test
  fun forcedStagesUseRealUrgencyFormula() {
    // 시험 화면의 단계 재현: 1~3 = 미루기 0 · 1 · 2번, 4 = 긴급 시각이 지남 (SpeechUrgency 그대로)
    val now = 1_800_000_000_000L
    assertEquals(listOf(1, 2, 3), (0..2).map { SpeechUrgency.level(it, now, null, null, 4) })
    assertEquals(3, SpeechUrgency.level(0, now, now - 60_000L, now + 60_000L, 4)) // 여유 5분 경계 지난 상태
    assertEquals(4, SpeechUrgency.level(0, now, now - 5 * 60_000L, now - 60_000L, 4)) // 여유 0분 경계 지난 상태
  }

  @Test
  fun noVibrationMeansNoPattern() {
    assertNull(AlarmVibration.patternFor(AlarmVibration.NONE))
    assertTrue(AlarmVibration.patternFor(AlarmVibration.SHORT_REPEAT) != null)
  }
}
