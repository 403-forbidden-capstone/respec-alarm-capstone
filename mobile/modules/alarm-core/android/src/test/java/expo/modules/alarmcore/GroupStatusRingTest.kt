package expo.modules.alarmcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// 그룹 상태 안내 호출 한도 — 울림 회차마다 조회 1번, 단계마다 음성 생성 1번, 실패면 다시 안 부름 (GroupStatusRing)
class GroupStatusRingTest {
  private val text = "캡스톤 그룹에서 수연님은 취침 중이에요. 스터디 그룹에서 민지님은 준비 중이에요."

  @Test
  fun queryOncePerRing() {
    val ring = GroupStatusRing("a#1")
    assertTrue(ring.startQuery(1))
    // 개인화 음성 반복 · 서비스 중복 콜백 · 재생 상태 변경으로 다시 불려도 조회 안 함
    repeat(5) { assertFalse(ring.startQuery(1)) }
    ring.onQuery(text, "t", 1, null)
    assertTrue(ring.ready(1))
    assertFalse(ring.startAudio(1)) // 1 · 2단계는 서버 음성 생성 없음
    assertFalse(ring.startAudio(2))
  }

  @Test
  fun failedOrTimedOutQueryMeansNoRetryAndNoTts() {
    val ring = GroupStatusRing("a#1")
    assertTrue(ring.startQuery(3))
    ring.onQuery(null, null, 3, null) // 실패 · 시간 초과 · 네트워크 오류
    assertFalse(ring.startQuery(3))
    for (level in 1..4) {
      assertFalse(ring.startAudio(level))
      assertFalse(ring.ready(level))
    }
  }

  @Test
  fun sameRingSameLevelGeneratesAtMostOnce() {
    val ring = GroupStatusRing("a#1")
    assertTrue(ring.startQuery(3)) // 첫 조회가 3단계 음성 생성도 함께
    assertFalse(ring.ready(3)) // 결과 전에는 기다림
    ring.onQuery(text, "t", 3, "/c/L3.wav")
    repeat(3) { assertFalse(ring.startAudio(3)) }
    assertTrue(ring.ready(3))
    assertEquals("/c/L3.wav", ring.audioFor(3))
  }

  @Test
  fun levelChangeGeneratesNewLevelOnceWithoutRequery() {
    val ring = GroupStatusRing("a#1")
    ring.startQuery(3)
    ring.onQuery(text, "t", 3, "/c/L3.wav")
    // 읽기 전에 4단계로 — 조회는 다시 안 하고 4단계 음성만 한 번
    assertFalse(ring.startQuery(4))
    assertTrue(ring.startAudio(4))
    assertFalse(ring.startAudio(4))
    assertFalse(ring.ready(4))
    assertNull(ring.audioFor(4)) // 3단계 음성을 4단계에 틀지 않음
    ring.onAudio(4, "/c/L4.wav")
    assertTrue(ring.ready(4))
    assertEquals("/c/L4.wav", ring.audioFor(4))
    // 3단계로 돌아가도 다시 안 만듦
    assertFalse(ring.startAudio(3))
  }

  @Test
  fun geminiFailureFallsBackWithoutAnotherCall() {
    val ring = GroupStatusRing("a#1")
    ring.startQuery(1)
    ring.onQuery(text, "t", 1, null)
    assertTrue(ring.startAudio(3))
    ring.onAudio(3, null) // Gemini 실패 · 시간 초과 · 한도
    assertFalse(ring.startAudio(3))
    assertTrue(ring.ready(3)) // Android TTS로 읽음
    assertNull(ring.audioFor(3))
  }

  @Test
  fun playedOnceThenNoMoreCalls() {
    val ring = GroupStatusRing("a#1")
    ring.startQuery(2)
    ring.onQuery(text, "t", 2, null)
    ring.markPlayed()
    assertFalse(ring.ready(2)) // 같은 회차에 다시 읽지 않음
    assertFalse(ring.startAudio(3)) // 읽은 뒤 단계가 올라도 음성 생성 안 함
    assertFalse(ring.startQuery(3))
  }

  @Test
  fun snoozeRingIsNewRecord() {
    val first = GroupStatusRing("a#1")
    first.startQuery(1)
    first.onQuery(text, "t", 1, null)
    first.markPlayed()
    val next = GroupStatusRing("a#2") // 미루기 뒤 다시 울림 — 새 조회 1번
    assertTrue(next.startQuery(2))
    assertFalse(next.startQuery(2))
  }
}
