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
      )
      assertEquals(field(o, "name"), field(o, "expected").toInt(), actual)
    }
  }
}
