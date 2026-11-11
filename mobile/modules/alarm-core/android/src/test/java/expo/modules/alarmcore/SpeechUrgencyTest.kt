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
      val dangerAt = field(o, "dangerAtMs").let { if (it == "null") null else it.toLong() }
      val actual = SpeechUrgency.level(
        snoozeCount = field(o, "snoozeCount").toInt(),
        nowMillis = field(o, "nowMs").toLong(),
        dangerAt = dangerAt,
        urgentAt = urgentAt,
        maxLevel = field(o, "maxLevel").toInt(),
      )
      assertEquals(field(o, "name"), field(o, "expected").toInt(), actual)
    }
  }

  @Test
  fun ringingTimelineOnlyGoesUp() {
    // 끄지 않고 울리는 동안 1초씩: 여유 5분(dangerAt)에 3, 0분(urgentAt)에 4. 스누즈 0 · 1 · 2 · 5회 모두 내려가지 않음
    val dangerAt = 1_800_000_300_000L
    val urgentAt = 1_800_000_600_000L
    for (snooze in listOf(0, 1, 2, 5)) {
      var peak: Int? = null
      val started = mutableListOf<Int>()
      for (t in (dangerAt - 10_000L)..(urgentAt + 10_000L) step 1_000L) {
        val next = SpeechUrgency.level(snooze, t, dangerAt, urgentAt, 4)
        if (SpeechUrgency.shouldSwitch(next, peak)) {
          started += next
          peak = maxOf(peak ?: 0, next)
        }
      }
      val first = minOf(snooze + 1, 3)
      assertEquals("스누즈 $snooze", if (first == 3) listOf(3, 4) else listOf(first, 3, 4), started)
    }
  }

  @Test
  fun snoozeAloneNeverReachesFour() {
    for (snooze in 0..10) assertTrue("스누즈 $snooze", SpeechUrgency.level(snooze, 1_800_000_000_000L, null, null, 4) <= 3)
    // 시각 규칙이 있어도 아직 여유가 남아 있으면 스누즈 횟수와 상관없이 3이 상한
    for (snooze in 0..10) assertTrue("스누즈 $snooze", SpeechUrgency.level(snooze, 1_800_000_000_000L, 1_800_000_300_000L, 1_800_000_600_000L, 4) <= 3)
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
