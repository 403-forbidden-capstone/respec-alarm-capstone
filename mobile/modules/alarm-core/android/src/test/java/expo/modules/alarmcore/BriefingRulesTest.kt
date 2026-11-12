package expo.modules.alarmcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// 브리핑 엔진 선택 · 오프라인 대체 규칙 — 인터넷 없음 · 한국어 TTS 미설치 · 캐시 없음에서도 알람음은 늘 울리고 브리핑만 빠지거나 바뀜
class BriefingRulesTest {
  private val ko = { name: String, net: Boolean -> BriefingRules.VoiceInfo(name, "ko", net) }

  @Test
  fun offlineKoreanVoiceOnly() {
    val voices = listOf(ko("ko-kr-x-kob-network", true), ko("ko-kr-x-kod-local", false), ko("ko-kr-x-koc-local", false), BriefingRules.VoiceInfo("en-us", "en", false))
    // 오프라인 한국어 목소리만, 이름순 번호로 (목소리가 달라짐)
    assertEquals(BriefingRules.VoiceChoice.Use("ko-kr-x-koc-local"), BriefingRules.offlineVoice(0, voices, 0))
    assertEquals(BriefingRules.VoiceChoice.Use("ko-kr-x-kod-local"), BriefingRules.offlineVoice(0, voices, 1))
    assertEquals(BriefingRules.VoiceChoice.Use("ko-kr-x-koc-local"), BriefingRules.offlineVoice(0, voices, 2))
  }

  @Test
  fun koreanDataMissingOrNetworkOnlySkips() {
    assertTrue(BriefingRules.offlineVoice(BriefingRules.LANG_MISSING_DATA, listOf(ko("a", false)), 0) is BriefingRules.VoiceChoice.Skip)
    assertTrue(BriefingRules.offlineVoice(BriefingRules.LANG_NOT_SUPPORTED, emptyList(), 0) is BriefingRules.VoiceChoice.Skip)
    assertTrue(BriefingRules.offlineVoice(0, listOf(ko("net-only", true)), 0) is BriefingRules.VoiceChoice.Skip)
    // 목록을 안 주는 엔진 — 한국어 확인은 통과했으니 엔진 기본 목소리
    assertEquals(BriefingRules.VoiceChoice.EngineDefault, BriefingRules.offlineVoice(1, emptyList(), 0))
  }

  @Test
  fun geminiForStage3And4WithFile() {
    assertTrue(BriefingRules.useGemini(3, true))
    assertTrue(BriefingRules.useGemini(4, true))
    assertFalse(BriefingRules.useGemini(4, false)) // 캐시 없음 → 예비 WAV 또는 Android TTS
    for (level in 1..2) assertFalse(BriefingRules.useGemini(level, true))
  }

  @Test
  fun bundledFallbackIsSameStageWakeOnly() {
    assertEquals(3, BriefingRules.fallbackWavLevel("WAKE", 3))
    assertEquals(4, BriefingRules.fallbackWavLevel("WAKE", 4))
    for (level in 1..2) assertNull(BriefingRules.fallbackWavLevel("WAKE", level))
    // 출발 알람은 기상용 예비 음성을 안 씀 → Android TTS로 출발 문장
    for (level in 1..4) assertNull(BriefingRules.fallbackWavLevel("DEPARTURE", level))
  }

  @Test
  fun wavSpeedFixedStage3NormalStage4Faster() {
    assertEquals(1f, BriefingRules.wavSpeed(3), 0f)
    assertEquals(1.2f, BriefingRules.wavSpeed(4), 0f)
  }

  @Test
  fun sourcePriorityCacheThenBundledThenAndroid() {
    assertEquals("GEMINI_CACHE", BriefingRules.source(4, cache = true, bundled = true))
    assertEquals("GEMINI_FALLBACK", BriefingRules.source(3, cache = false, bundled = true))
    assertEquals("ANDROID_FALLBACK", BriefingRules.source(3, cache = false, bundled = false))
    assertEquals("ANDROID", BriefingRules.source(2, cache = false, bundled = false))
  }

  @Test
  fun clipLevelFallsBackDown() {
    assertEquals(4, BriefingRules.clipLevel(4, setOf(1, 2, 3, 4)))
    assertEquals(3, BriefingRules.clipLevel(4, setOf(1, 2, 3))) // 상한 3으로 받은 브리핑
    assertEquals(1, BriefingRules.clipLevel(2, setOf(1)))
    assertNull(BriefingRules.clipLevel(3, emptySet()))
  }

  @Test
  fun noCacheWakeStillEscalatesWithSnooze() {
    val text = "좋은 아침이에요. 오늘 첫 일정은 오전 10시 수업이에요."
    val f0 = BriefingRules.fallback("WAKE", text, "일어날 시간이에요", "수업", 0)!!
    val f1 = BriefingRules.fallback("WAKE", text, "일어날 시간이에요", "수업", 1)!!
    val f2 = BriefingRules.fallback("WAKE", text, "일어날 시간이에요", "수업", 2)!!
    assertEquals(listOf(1, 2, 3), listOf(f0.level, f1.level, f2.level))
    assertEquals(text, f0.text)
    assertTrue(f1.text.startsWith("알람을 한 번 미뤘어요.") && f1.text.endsWith(text))
    assertTrue(f2.text.startsWith("알람을 여러 번 미뤘어요."))
    // TS androidVoice와 같은 단계 고정값: 1단계 1.0/1.0, 2단계 이상 1.7/1.5
    assertEquals(listOf(1.0f, 1.7f, 1.7f), listOf(f0.pitch, f1.pitch, f2.pitch))
    assertEquals(listOf(1.0f, 1.5f, 1.5f), listOf(f0.rate, f1.rate, f2.rate))
  }

  @Test
  fun noCacheDepartureReadsNoticeAndTitle() {
    val f = BriefingRules.fallback("DEPARTURE", null, "지금 나가면 오전 9:50 도착 · 여유 10분", "면접", 0)!!
    assertEquals("지금 나가면 오전 9:50 도착 · 여유 10분. 면접", f.text)
    // 문장이 하나도 없으면 읽지 않음(알람음만)
    assertNull(BriefingRules.fallback("WAKE", "", "", "", 0))
  }
}
