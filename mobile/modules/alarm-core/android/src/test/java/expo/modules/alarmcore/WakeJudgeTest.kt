package expo.modules.alarmcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// 폰이 해제 10분 뒤 스스로 하는 기상 판정(WakeJudge)이 앱 evaluateWake와 같은 결과인지 — 앱 wake.test.ts가 같은 표(spec/wake-cases.json)를 읽음. 안드로이드 빌드 검사가 돌림
class WakeJudgeTest {
  // 모듈 android 폴더에서 돌므로 ../spec. 다른 곳에서 돌려도 위로 올라가며 찾음
  private fun casesFile(): File {
    var dir: File? = File(System.getProperty("user.dir")).absoluteFile
    while (dir != null) {
      val f = File(dir, "spec/wake-cases.json")
      if (f.exists()) return f
      val nested = File(dir, "modules/alarm-core/spec/wake-cases.json")
      if (nested.exists()) return nested
      dir = dir.parentFile
    }
    error("spec/wake-cases.json을 못 찾음")
  }

  // org.json은 단위 시험에서 가짜(android.jar)라 쓰지 않고 평평한 객체만 정규식으로 읽음
  private fun field(obj: String, name: String): String =
    Regex("\"$name\"\\s*:\\s*(null|-?[\\d.]+|\"[^\"]*\")").find(obj)?.groupValues?.get(1) ?: error("$name 없음: $obj")

  private fun text(obj: String, name: String) = field(obj, name).trim('"')

  // "0.5-1.5,2.5-3.3" · 음수 시작("-3-1.2") 도 읽음. "null" = 사용 정보 없음, 빈 글자 = 사용 없음
  private fun spans(raw: String): List<WakeJudge.Span>? {
    if (raw == "null") return null
    if (raw.isEmpty()) return emptyList()
    return raw.split(',').map { part ->
      val m = Regex("^(-?[\\d.]+)-(-?[\\d.]+)$").find(part) ?: error("구간 모양: $part")
      WakeJudge.Span(m.groupValues[1].toDouble(), m.groupValues[2].toDouble())
    }
  }

  @Test
  fun sameAsTypeScript() {
    val base = 1_795_000_000_000L // 해제 시각 (값은 상관없음 — 표는 해제 뒤 분)
    val objects = Regex("\\{[^{}]*\\}").findAll(casesFile().readText()).map { it.value }.toList()
    assertTrue("시험 줄이 비었음", objects.size >= 10)
    for (obj in objects) {
      val name = text(obj, "name")
      val now = base + (field(obj, "nowMin").toDouble() * 60_000).toLong()
      val result = WakeJudge.evaluate(base, now, spans(text(obj, "spans")), field(obj, "theta").toDouble())
      assertEquals(name, text(obj, "phase").uppercase(), result.phase.name)
      // 확인 알림 규칙: 표에서 prompt인 줄(사용 정보 못 읽음 포함)만 알림, 이미 확정이면 어느 줄이든 안 띄움
      assertEquals("$name 알림", text(obj, "phase") == "prompt", DeviceUploadRules.shouldPromptWake(result, false))
      assertFalse("$name 확정됨", DeviceUploadRules.shouldPromptWake(result, true))
      assertEquals("$name 누적", field(obj, "usage").toDouble(), result.usage, 0.0)
      assertEquals("$name 최근", field(obj, "recent").toDouble(), result.recent, 0.0)
      val expected = field(obj, "reachedMs")
      if (expected == "null") assertNull(name, result.reachedAtMillis)
      else assertEquals("$name 확정 시각", base + expected.toLong(), result.reachedAtMillis)
    }
  }

  @Test
  fun millisSpansBecomeMinutesAfterDismiss() {
    val base = 1_795_000_000_000L
    val converted = WakeJudge.toSpans(base, listOf((base + 30_000) to (base + 90_000), (base + 360_000) to (base + 420_000)))
    assertEquals(listOf(WakeJudge.Span(0.5, 1.5), WakeJudge.Span(6.0, 7.0)), converted)
    // 실제 읽기 흐름: 구간 → 분 → 판정 (앱 readSpans → evaluateWake와 같은 길)
    val result = WakeJudge.evaluate(base, base + 11 * 60_000L, converted)
    assertEquals(WakeJudge.Phase.AUTO, result.phase)
    assertEquals(base + 90_000, result.reachedAtMillis)
  }
}
