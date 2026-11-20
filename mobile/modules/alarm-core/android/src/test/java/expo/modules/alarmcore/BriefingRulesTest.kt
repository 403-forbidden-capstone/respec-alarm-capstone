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
  fun noBriefingStartsFromSpeechTone() {
    // 브리핑을 한 번도 못 받아도 예약의 말소리로 시작: 약 1 → 2 → 3 → 3 · 중 2 → 3 → 3 → 3 · 강 3 → 3 → 3 → 3
    val text = "좋은 아침이에요. 오늘 첫 일정은 오전 10시 수업이에요."
    val levels = { start: Int -> (0..3).map { BriefingRules.fallback("WAKE", text, "일어날 시간이에요", "수업", it, start)!!.level } }
    assertEquals(listOf(1, 2, 3, 3), levels(1))
    assertEquals(listOf(2, 3, 3, 3), levels(2))
    assertEquals(listOf(3, 3, 3, 3), levels(3))
    // 미루지 않았으면 단계가 2 · 3이어도 "미뤘어요"를 안 붙임
    for (start in 1..3) assertEquals(text, BriefingRules.fallback("WAKE", text, "일어날 시간이에요", "수업", 0, start)!!.text)
    assertTrue(BriefingRules.fallback("WAKE", text, "일어날 시간이에요", "수업", 1, 3)!!.text.startsWith("알람을 한 번 미뤘어요."))
    // 3단계 기상은 앱에 든 3단계 예비 WAV가 먼저 (그다음 Android TTS)
    assertEquals(3, BriefingRules.fallbackWavLevel("WAKE", BriefingRules.fallback("WAKE", text, "", "", 0, 3)!!.level))
    // 중 2단계는 Android TTS 높낮이 · 속도 1.7 · 1.5
    val f = BriefingRules.fallback("WAKE", text, "", "", 0, 2)!!
    assertEquals(1.7f, f.pitch)
    assertEquals(1.5f, f.rate)
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
  fun androidTextDropsExclamationMarks() {
    // 서버 briefing.ts noExclaim과 같은 결과 — 반각 · 전각 · 연속 느낌표, ?! 조합, 붙은 글자 띄우기, 숫자 속 마침표는 그대로
    assertEquals("야. 너 일어나.", BriefingRules.androidText("야!!!!너 일어나!"))
    assertEquals("해? 빨리.", BriefingRules.androidText("해?! 빨리!"))
    assertEquals("일어나. 빨리.", BriefingRules.androidText("일어나！！ 빨리!"))
    assertEquals("1.5배.", BriefingRules.androidText("1.5배!"))
    assertEquals("좋은 아침이야.", BriefingRules.androidText("좋은 아침이야."))
    // 저장된 브리핑이 없을 때의 3단계 문장도 느낌표 없이 읽힘
    val f = BriefingRules.fallback("WAKE", "좋은 아침", "", "", 2)!!
    assertTrue('!' !in BriefingRules.androidText(f.text))
  }

  @Test
  fun noCacheDepartureReadsNoticeAndTitle() {
    val f = BriefingRules.fallback("DEPARTURE", null, "지금 나가면 오전 9:50 도착 · 여유 10분", "면접", 0)!!
    assertEquals("지금 나가면 오전 9:50 도착 · 여유 10분. 면접", f.text)
    // 문장이 하나도 없으면 읽지 않음(알람음만)
    assertNull(BriefingRules.fallback("WAKE", "", "", "", 0))
  }

  @Test
  fun prepareAndDepartureReadFixedSentenceWithoutStages() {
    // 준비 시작 · 출발 = Android TTS 고정 문장, 1단계 높낮이 · 속도. 미루기 · 지각 위험 인자가 없어 단계가 바뀔 수 없음
    assertEquals(BriefingRules.Fallback(1, "이제 준비를 시작할 시간이에요.", 1.0f, 1.0f), BriefingRules.simple("PREPARE"))
    assertEquals(BriefingRules.Fallback(1, "지금 출발해야 해요.", 1.0f, 1.0f), BriefingRules.simple("DEPARTURE"))
    // Gemini · 예비 WAV · 반복 없음 (예비 WAV는 기상만, 반복은 기상만)
    for (type in listOf("PREPARE", "DEPARTURE")) {
      assertFalse(BriefingRules.repeatsBriefing(type))
      for (level in 1..4) assertNull(BriefingRules.fallbackWavLevel(type, level))
    }
    // 기상 · 도착은 기존 규칙 그대로 (기상 1~4단계)
    assertNull(BriefingRules.simple("WAKE"))
    assertNull(BriefingRules.simple("ARRIVE"))
    assertTrue(BriefingRules.repeatsBriefing("WAKE"))
  }

  @Test
  fun prepareAndDepartureNoticeStartsSpeechServiceOnlyWithoutAlarmSound() {
    // AlarmController.fire: 알람음 없는 알림 뒤 음성 안내 서비스 — 예전 APK가 걸어 둔 준비 시작 · 출발 알림만
    assertTrue(BriefingRules.speaksOnNotice("PREPARE"))
    assertTrue(BriefingRules.speaksOnNotice("DEPARTURE"))
    for (type in listOf("WAKE", "ARRIVE", "ROUTINE")) assertFalse(BriefingRules.speaksOnNotice(type))
    // 11/19: 준비 · 출발이 알람음이 있는 알람(plan.sound)이면 알람 서비스가 같은 문장을 읽으므로 음성 서비스를 또 띄우지 않음 (두 번 겹쳐 읽지 않게)
    for (type in listOf("PREPARE", "DEPARTURE")) assertFalse(BriefingRules.speaksOnNotice(type, plansSound = true))
  }

  // --- 백그라운드 브리핑 갱신 (#515) ---
  private val min = 60_000L
  // 2026-11-14 00:00 KST = 2026-11-13 15:00 UTC
  private val day14 = 1_794_582_000_000L
  private fun kst(h: Int, m: Int = 0, day: Long = day14) = day + h * 60 * min + m * min

  @Test
  fun refreshSlotIs0410KstOnAlarmDayUnlessWakeBefore0415() {
    assertEquals(kst(4, 10), BriefingRules.refreshSlot(kst(7, 30)))
    assertEquals(kst(4, 10), BriefingRules.refreshSlot(kst(23, 0)))
    // 새벽 4시 전 · 4:15 전 기상 — 갱신 없이 기존 브리핑
    assertNull(BriefingRules.refreshSlot(kst(3, 30)))
    assertNull(BriefingRules.refreshSlot(kst(4, 15)))
    assertEquals(kst(4, 10), BriefingRules.refreshSlot(kst(4, 16)))
    assertEquals(kst(7, 30) - 5 * min, BriefingRules.refreshDeadline(kst(7, 30)))
  }

  @Test
  fun pickRefreshTakesEarliestFutureBeforeDeadline() {
    val deadline = kst(7, 25)
    val now = kst(4, 0)
    // 4:10 슬롯과 서버 refresh_at 4:40 → 4:10 먼저 (그 뒤 작업이 서버 refresh_at을 다시 걺)
    assertEquals(kst(4, 10), BriefingRules.pickRefresh(listOf(kst(4, 40), null, kst(4, 10)), now, deadline))
    // 4:10이 지났으면 refresh_at
    assertEquals(kst(4, 40), BriefingRules.pickRefresh(listOf(kst(4, 40), kst(4, 10)), kst(4, 12), deadline))
    // 마감(기상 5분 전) 뒤 · 지난 시각뿐이면 null → 갱신 예약을 지움
    assertNull(BriefingRules.pickRefresh(listOf(kst(7, 26), kst(3, 0), null), now, deadline))
    assertNull(BriefingRules.pickRefresh(emptyList(), now, deadline))
  }

  @Test
  fun refreshOnlyForQuietWakeAlarmBeforeDeadline() {
    val ring = kst(7, 30)
    assertTrue(BriefingRules.canRefresh("WAKE", false, 0, 0, ring, kst(4, 10)))
    assertFalse(BriefingRules.canRefresh("DEPARTURE", false, 0, 0, ring, kst(4, 10)))
    assertFalse(BriefingRules.canRefresh("WAKE", true, 0, 0, ring, kst(4, 10))) // 울리는 중
    assertFalse(BriefingRules.canRefresh("WAKE", false, 1, 0, ring, kst(4, 10))) // 미룬 중
    assertFalse(BriefingRules.canRefresh("WAKE", false, 0, 0, ring, kst(7, 25))) // 마감
  }

  @Test
  fun refreshOutcomeSavesOnlyOnSuccessAndRetriesOnlyTransientFailures() {
    assertEquals(BriefingRules.RefreshOutcome.SAVE, BriefingRules.refreshOutcome(200))
    for (s in listOf(400, 401, 403, 404)) assertEquals(BriefingRules.RefreshOutcome.STOP, BriefingRules.refreshOutcome(s))
    for (s in listOf(null, 408, 429, 500, 503)) assertEquals(BriefingRules.RefreshOutcome.RETRY, BriefingRules.refreshOutcome(s))
    val deadline = kst(7, 25)
    assertTrue(BriefingRules.shouldRetry(0, kst(4, 10), 30_000L, deadline))
    assertFalse(BriefingRules.shouldRetry(0, kst(7, 24), 2 * min, deadline)) // 다음 시도가 마감 뒤
    assertFalse(BriefingRules.shouldRetry(BriefingRules.REFRESH_MAX_ATTEMPTS - 1, kst(4, 10), 30_000L, deadline))
  }

  // 그룹 상태 안내를 끼울 문장 경계 — 문장 가운데서 나누지 않고, 느낌표는 마침표로 바뀐 뒤 나눔
  @Test
  fun sentencesSplitAtSentenceEnds() {
    assertEquals(listOf("좋은 아침이야.", "오늘 오전 10시에 발표가 있어.", "일어날 시간이야?"), BriefingRules.sentences("좋은 아침이야. 오늘 오전 10시에 발표가 있어! 일어날 시간이야?"))
    assertEquals(listOf("야.", "빨리 일어나."), BriefingRules.sentences("야!빨리 일어나!!"))
    assertEquals(listOf("마침표 없는 한 문장"), BriefingRules.sentences("마침표 없는 한 문장"))
    assertEquals(emptyList<String>(), BriefingRules.sentences("  "))
  }
}
