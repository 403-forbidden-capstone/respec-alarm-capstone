package expo.modules.alarmcore

import org.junit.Assert.assertEquals
import org.junit.Test

// 판정 예약 저장 — 저장된 값에서 쓸 수 있는 것만 읽음 (취소 · 재부팅 복원이 같은 목록을 씀)
class WakeJudgeStoreTest {
  @Test
  fun keepsPositiveLongEntries() {
    val raw = mapOf<String, Any?>("a1" to 1_747_897_200_000L, "a2" to 5L)
    assertEquals(listOf("a1" to 1_747_897_200_000L, "a2" to 5L), WakeJudgeStore.entriesOf(raw))
  }

  @Test
  fun dropsBrokenValues() {
    val raw = mapOf<String, Any?>("zero" to 0L, "neg" to -1L, "text" to "abc", "int" to 7, "null" to null, "ok" to 9L)
    assertEquals(listOf("ok" to 9L), WakeJudgeStore.entriesOf(raw))
  }
}
