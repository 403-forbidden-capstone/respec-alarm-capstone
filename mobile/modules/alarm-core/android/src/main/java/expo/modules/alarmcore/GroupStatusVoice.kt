package expo.modules.alarmcore

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

// 기상 알람 그룹 상태 안내 — 울림마다 한 번 서버(group-status-device)에서 그룹원 상태 문장(3 · 4단계면 그 단계 Gemini 음성도)을 받음
//   상태 판정 · 공유 범위는 서버가 그룹 화면과 같은 규칙으로 (폰은 판단하지 않음). 기기 키 · 주소는 백그라운드 브리핑 갱신과 같은 것(BriefingCredential)
//   메인 스레드에서 부르지 않음. 키 없음 · 연결 실패 · 시간 초과 · 오류 응답 · 안내할 그룹원 없음은 모두 null → 알람은 개인화 음성만
//   한 번 부르면 한 번 보냄 — 다시 시도 · 폴링 없음. 몇 번 부를지는 GroupStatusRing이 정함 (회차마다 조회 1번 · 단계마다 음성 1번)
internal object GroupStatusVoice {
  private const val CONNECT_TIMEOUT_MS = 5_000
  // 서버가 Gemini 음성을 10초 안에 못 만들면 글만 줌 — 그보다 조금 길게
  private const val READ_TIMEOUT_MS = 15_000

  /** token = 서버가 그 문장에 단 서명(단계가 바뀌면 문장 + 서명을 보내 음성만 받음). wav = 요청한 단계의 Gemini 음성 (없으면 Android TTS로) */
  class Result(val text: String, val token: String?, val wav: ByteArray?)

  /** text · token이 없으면 조회(+ 3 · 4단계면 그 단계 음성), 있으면 그 문장의 음성만 (서버가 DB를 안 읽음) */
  fun fetch(context: Context, level: Int, text: String? = null, token: String? = null): Result? {
    val credential = BriefingCredential.load(context) ?: return null
    val url = DeviceUploadRules.groupStatusUrl(credential.url) ?: return null
    val conn = (URL(url).openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = CONNECT_TIMEOUT_MS
      readTimeout = READ_TIMEOUT_MS
      doOutput = true
      setRequestProperty("content-type", "application/json")
      setRequestProperty("authorization", "Bearer ${credential.token}")
      if (credential.apikey.isNotEmpty()) setRequestProperty("apikey", credential.apikey)
    }
    try {
      val request = JSONObject().put("level", level)
      if (text != null) request.put("text", text).put("token", token)
      conn.outputStream.use { it.write(request.toString().toByteArray(Charsets.UTF_8)) }
      if (conn.responseCode !in 200..299) return null
      val body = JSONObject(conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() })
      if (body.isNull("text")) return null
      val said = body.optString("text").takeIf { it.isNotBlank() } ?: return null
      val wav = body.optJSONObject("audio")?.optString("data")?.takeIf { it.isNotEmpty() }?.let { Base64.decode(it, Base64.DEFAULT) }
      return Result(said, if (body.isNull("token")) null else body.optString("token"), wav)
    } finally {
      conn.disconnect()
    }
  }

  /** 그 단계 Gemini 음성을 앱 전용 캐시 파일로 (단계마다 따로, 울림마다 덮어씀 — 한 번에 한 울림만 있음). 못 쓰면 null → Android TTS */
  fun writeWav(context: Context, generation: Int, level: Int, bytes: ByteArray): File? =
    runCatching { File(context.cacheDir, "group_status_G${generation}_L$level.wav").apply { writeBytes(bytes) } }.getOrNull()
}
