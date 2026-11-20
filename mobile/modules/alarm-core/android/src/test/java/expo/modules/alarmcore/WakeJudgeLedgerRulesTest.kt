package expo.modules.alarmcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// 판정 예약 장부 — 줄 모양 · 같은 알람 덮어쓰기 · 하루 넘은 줄 버리기
class WakeJudgeLedgerRulesTest {
  private val now = 1_747_897_200_000L

  @Test
  fun entryRoundTripsAlarmId() {
    assertEquals("a1", WakeJudgeLedgerRules.alarmIdOf(WakeJudgeLedgerRules.encode("a1", now)))
    assertNull(WakeJudgeLedgerRules.alarmIdOf("깨진줄"))
    assertNull(WakeJudgeLedgerRules.alarmIdOf("|123"))
  }

  @Test
  fun sameAlarmReplacesEarlierEntry() {
    val first = WakeJudgeLedgerRules.add(emptySet(), "a1", now - 1_000, now)
    val second = WakeJudgeLedgerRules.add(first, "a1", now, now)
    assertEquals(setOf(WakeJudgeLedgerRules.encode("a1", now)), second)
  }

  @Test
  fun differentAlarmsAreKept() {
    val set = WakeJudgeLedgerRules.add(WakeJudgeLedgerRules.add(emptySet(), "a1", now - 1_000, now), "a2", now, now)
    assertEquals(setOf(WakeJudgeLedgerRules.encode("a1", now - 1_000), WakeJudgeLedgerRules.encode("a2", now)), set)
  }

  @Test
  fun entriesOlderThanADayAndBrokenOnesAreDropped() {
    val old = WakeJudgeLedgerRules.encode("old", now - WakeJudgeLedgerRules.KEEP_MILLIS - 1)
    val set = WakeJudgeLedgerRules.add(setOf(old, "깨진줄", "x|abc"), "a1", now, now)
    assertEquals(setOf(WakeJudgeLedgerRules.encode("a1", now)), set)
  }
}
