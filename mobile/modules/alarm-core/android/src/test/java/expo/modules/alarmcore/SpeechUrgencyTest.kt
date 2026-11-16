package expo.modules.alarmcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// TS(_shared/briefing.test.ts)와 같은 표(spec/urgency-cases.json)로 네이티브 단계 판단이 같은지 확인 — 안드로이드 빌드 검사가 돌림
class SpeechUrgencyTest {
  // 모듈 android 폴더에서 돌므로 ../spec. 다른 곳에서 돌려도 위로 올라가며 찾음
  private fun casesFile(): File {
    var dir: File? = File(System.getProperty("user.dir")).absoluteFile
    while (dir != null) {
      val f = File(dir, "spec/urgency-cases.json")
      if (f.exists()) return f
      val nested = File(dir, "modules/alarm-core/spec/urgency-cases.json")
      if (nested.exists()) return nested
      dir = dir.parentFile
    }
    error("spec/urgency-cases.json을 못 찾음")
  }

  // org.json은 단위 시험에서 가짜(android.jar)라 쓰지 않고 평평한 객체만 정규식으로 읽음
  private fun field(obj: String, name: String): String =
    Regex("\"$name\"\\s*:\\s*(null|-?\\d+|\"[^\"]*\")").find(obj)?.groupValues?.get(1) ?: error("$name 없음: $obj")

  @Test
  fun sameAsTypeScript() {
    val objects = Regex("\\{[^{}]*\\}").findAll(casesFile().readText()).map { it.value }.toList()
    assertTrue("시험 줄이 비었음", objects.size >= 10)
    for (o in objects) {
      val urgentAt = field(o, "urgentAtMs").let { if (it == "null") null else it.toLong() }
      val actual = SpeechUrgency.level(
        snoozeCount = field(o, "snoozeCount").toInt(),
        nowMillis = field(o, "nowMs").toLong(),
        urgentAt = urgentAt,
        maxLevel = field(o, "maxLevel").toInt(),
        startLevel = field(o, "startLevel").toInt(),
      )
      assertEquals(field(o, "name"), field(o, "expected").toInt(), actual)
    }
  }

  @Test
  fun ringingTimelineOnlyGoesUp() {
    // 끄지 않고 울리는 동안 1초씩(서비스는 2초마다 확인): 여유 0분(urgentAt)이 되기 전까지 시작 단계 + 미루기, 그때 4. 내려가지 않음
    val urgentAt = 1_800_000_600_000L
    for (start in 1..3) for (snooze in listOf(0, 1, 2, 5)) {
      var peak: Int? = null
      val started = mutableListOf<Int>()
      for (t in (urgentAt - 10_000L)..(urgentAt + 10_000L) step 1_000L) {
        val next = SpeechUrgency.level(snooze, t, urgentAt, 4, start)
        if (SpeechUrgency.shouldSwitch(next, peak)) {
          started += next
          peak = maxOf(peak ?: 0, next)
        }
      }
      assertEquals("시작 $start · 미루기 $snooze", listOf(minOf(start + snooze, 3), 4), started)
    }
  }

  @Test
  fun startLevelBySpeechTone() {
    // 약 1 → 2 → 3 → 3, 중 2 → 3 → 3 → 3, 강 3 → 3 → 3 → 3 (여유가 남아 있으면)
    val now = 1_800_000_000_000L
    val urgentAt = 1_800_000_600_000L
    assertEquals(listOf(1, 2, 3, 3), (0..3).map { SpeechUrgency.level(it, now, urgentAt, 4, 1) })
    assertEquals(listOf(2, 3, 3, 3), (0..3).map { SpeechUrgency.level(it, now, urgentAt, 4, 2) })
    assertEquals(listOf(3, 3, 3, 3), (0..3).map { SpeechUrgency.level(it, now, urgentAt, 4, 3) })
  }

  @Test
  fun startLevelFromReservationFirstThenBriefing() {
    // 예약 꾸러미의 말소리(최신 설정)가 저장된 브리핑의 시작 단계보다 먼저 — 브리핑을 받았든(1 · 2 · 3) 못 받았든(1)
    for (briefed in listOf(1, 2, 3)) {
      assertEquals(1, SpeechUrgency.startLevel("CALM", briefed))
      assertEquals(2, SpeechUrgency.startLevel("NEUTRAL", briefed))
      assertEquals(3, SpeechUrgency.startLevel("DIRECT", briefed))
    }
    // 예약에 말소리가 없음(예전 서버 · 예전 예약) → 저장된 브리핑 값, 브리핑도 없으면 1
    assertEquals(3, SpeechUrgency.startLevel(null, 3))
    assertEquals(1, SpeechUrgency.startLevel(null, 1))
    assertEquals(2, SpeechUrgency.startLevel("이상한 값", 2))
  }

  @Test
  fun snoozeAloneNeverReachesFour() {
    for (start in 1..3) for (snooze in 0..10) {
      assertTrue("시작 $start · 미루기 $snooze", SpeechUrgency.level(snooze, 1_800_000_000_000L, null, 4, start) <= 3)
      // 여유 0분 시각이 있어도 아직 안 왔으면 3이 상한
      assertTrue("시작 $start · 미루기 $snooze", SpeechUrgency.level(snooze, 1_800_000_000_000L, 1_800_000_600_000L, 4, start) <= 3)
    }
  }

  @Test
  fun neverSwitchDownOrRestartSameLevel() {
    assertTrue(SpeechUrgency.shouldSwitch(1, null))
    assertTrue(SpeechUrgency.shouldSwitch(3, 1))
    assertTrue(SpeechUrgency.shouldSwitch(4, 3))
    assertEquals(false, SpeechUrgency.shouldSwitch(3, 3)) // 같은 단계(실패했던 단계 포함)는 다시 시작 안 함
    assertEquals(false, SpeechUrgency.shouldSwitch(2, 4)) // 브리핑이 새로 저장돼 낮게 나와도 내리지 않음
  }
}
