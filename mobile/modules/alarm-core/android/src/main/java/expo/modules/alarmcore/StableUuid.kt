package expo.modules.alarmcore

// 앱 lib/uuid.ts stableUuid와 같은 고정 UUID — 같은 입력이면 같은 번호라, 폰이 올린 기록과 앱이 나중에 올리는 같은 기록이 한 줄로 합쳐짐 (docs/alarm-core.md "기록 번호 공식")
// 공식을 바꾸면 이미 올라간 기록과 번호가 달라지므로 바꾸지 않음 — DeviceUploadRulesTest(stableUuidSameAsTypeScript)가 문서의 시험값을 고정
object StableUuid {
  private val SEEDS = intArrayOf(0x811c9dc5.toInt(), 0x9e3779b1.toInt(), 0x85ebca77.toInt(), 0xc2b2ae3d.toInt())

  // FNV-1a 뒤에 마무리 섞기(murmur3 finalizer). 글자는 UTF-16 코드 단위마다 (JS charCodeAt과 같음 — Kotlin Char도 UTF-16 단위)
  private fun hash32(text: String, seed: Int): Int {
    var hash = seed
    for (ch in text) {
      hash = hash xor ch.code
      hash *= 0x01000193
    }
    hash = hash xor (hash ushr 16)
    hash *= 0x85ebca6b.toInt()
    hash = hash xor (hash ushr 13)
    hash *= 0xc2b2ae35.toInt()
    hash = hash xor (hash ushr 16)
    return hash
  }

  // 조각 배열의 JSON (JS JSON.stringify와 같게): 글자는 큰따옴표 + 이스케이프, 숫자(정수)는 그대로
  private fun json(parts: List<Any>): String = parts.joinToString(",", "[", "]") { part ->
    when (part) {
      is String -> quote(part)
      is Int, is Long -> part.toString()
      else -> throw IllegalArgumentException("글자 · 정수만 됨: $part")
    }
  }

  private fun quote(text: String): String = buildString {
    append('"')
    for (ch in text) {
      when {
        ch == '"' -> append("\\\"")
        ch == '\\' -> append("\\\\")
        ch == '\n' -> append("\\n")
        ch == '\r' -> append("\\r")
        ch == '\t' -> append("\\t")
        ch == '\b' -> append("\\b")
        ch.code == 0x0c -> append("\\f")
        ch.code < 0x20 -> append("\\u%04x".format(ch.code))
        else -> append(ch)
      }
    }
    append('"')
  }

  fun of(vararg parts: Any): String {
    val text = json(parts.toList())
    val hex = SEEDS.joinToString("") { Integer.toHexString(hash32(text, it)).padStart(8, '0') }
    val variant = Integer.toHexString((hex[16].digitToInt(16) and 0x3) or 0x8)
    return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-5${hex.substring(13, 16)}-$variant${hex.substring(17, 20)}-${hex.substring(20, 32)}"
  }
}
