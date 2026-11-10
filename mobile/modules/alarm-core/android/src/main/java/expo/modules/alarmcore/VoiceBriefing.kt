package expo.modules.alarmcore

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

// 알람 음성 브리핑 저장소 — 앱이 미리 받아 둔 단계별 문장(Android TTS용) · 긴급 Gemini 음성(WAV)을 알람별로 두고, 울릴 때 읽을 것을 고름
// 저장 위치: 앱 전용 폴더 filesDir/alarm_voice/<알람 id>/ (다른 앱 · 다른 사용자가 못 읽음). 알람이 지워지면(AlarmStorage.remove) 같이 지움
//   로그아웃은 cancelAll → clearAll → 다음 계정에 앞 계정 브리핑이 남지 않음
// 단계 판단은 SpeechUrgency (TS levelAt과 같은 식). 엔진: 4단계이고 Gemini 파일이 있을 때만 Gemini, 아니면 Android TTS로 같은 단계 문장 전체 (한 울림에 한 엔진)
internal object VoiceBriefing {
  private const val DIR = "alarm_voice"
  private const val MANIFEST = "manifest.json"
  private val ID = Regex("^[0-9A-Za-z_-]{1,64}$")
  private val HASH = Regex("^[0-9a-f]{16}$")

  // 알람 id는 폴더 이름이 되므로 경로 문자를 막음 (../ 등)
  private fun dir(context: Context, alarmId: String): File? =
    if (ID.matches(alarmId)) File(File(context.filesDir, DIR), alarmId) else null

  private fun readManifest(dir: File): JSONObject? =
    runCatching { JSONObject(File(dir, MANIFEST).readText()) }.getOrNull()

  /**
   * 앱이 받은 결과 저장. json = { rule: {urgentAtMs, maxLevel}, clips: [{level, hash, text, pitch, rate, voiceIndex}], audio: [{level, hash, data(base64)}] }
   * 단계마다: 새 Gemini 음성이 오면 씀, 안 왔으면 열쇠가 같은 예전 파일만 남김 (내용이 바뀌었는데 못 만들었으면 낡은 음성을 지움 → Android TTS로)
   */
  @Synchronized
  fun save(context: Context, alarmId: String, json: String) {
    val folder = dir(context, alarmId) ?: throw IllegalArgumentException("알람 id가 이상해요")
    val input = JSONObject(json)
    val old = readManifest(folder)?.optJSONObject("files") ?: JSONObject()
    folder.mkdirs()
    val audio = input.optJSONArray("audio") ?: JSONArray()
    val clips = input.optJSONArray("clips") ?: JSONArray()
    val files = JSONObject()
    val keepLevels = mutableSetOf<String>()
    for (i in 0 until clips.length()) {
      val clip = clips.getJSONObject(i)
      val level = clip.getInt("level").toString()
      val hash = clip.optString("hash")
      if (!HASH.matches(hash)) continue
      val file = File(folder, "L$level.wav")
      val fresh = (0 until audio.length()).map { audio.getJSONObject(it) }.firstOrNull { it.optString("hash") == hash }
      if (fresh != null) {
        val tmp = File(folder, "L$level.tmp")
        tmp.writeBytes(Base64.decode(fresh.getString("data"), Base64.DEFAULT))
        if (!tmp.renameTo(file)) {
          file.delete()
          tmp.renameTo(file)
        }
        files.put(level, hash)
        keepLevels.add(level)
      } else if (old.optString(level) == hash && file.exists()) {
        files.put(level, hash)
        keepLevels.add(level)
      }
    }
    folder.listFiles()?.forEach { f ->
      val lv = Regex("^L(\\d)\\.(wav|tmp)$").find(f.name)?.groupValues?.get(1)
      if (lv != null && lv !in keepLevels) f.delete()
    }
    val manifest = JSONObject()
      .put("rule", input.optJSONObject("rule") ?: JSONObject())
      .put("clips", clips)
      .put("files", files)
    File(folder, MANIFEST).writeText(manifest.toString())
  }

  /** 폰에 있는 Gemini 음성의 열쇠 — 앱이 서버에 have로 보내 같은 음성을 다시 안 만들게 */
  @Synchronized
  fun hashes(context: Context, alarmId: String): List<String> {
    val folder = dir(context, alarmId) ?: return emptyList()
    val files = readManifest(folder)?.optJSONObject("files") ?: return emptyList()
    return files.keys().asSequence().filter { File(folder, "L$it.wav").exists() }.map { files.getString(it) }.toList()
  }

  @Synchronized
  fun clear(context: Context, alarmId: String) {
    dir(context, alarmId)?.deleteRecursively()
  }

  @Synchronized
  fun clearAll(context: Context) {
    File(context.filesDir, DIR).deleteRecursively()
  }

  /** 한 울림에 읽을 것 — wav가 있으면 Gemini 음성, 없으면 text를 Android TTS로 (pitch · rate · voiceIndex) */
  data class Speech(val level: Int, val text: String, val pitch: Float, val rate: Float, val voiceIndex: Int, val wav: File?)

  /**
   * 지금 울림에 읽을 브리핑. 저장된 브리핑이 없으면(못 받음 · 네트워크 없음) 꾸러미의 기상 문장(voiceText) 또는 "머리글. 제목"을 Android TTS로 —
   * 캐시가 없어도 음성 안내는 나옴. 문장이 하나도 없으면 null(알람음만)
   */
  @Synchronized
  fun speechFor(context: Context, alarm: StoredAlarm, nowMillis: Long): Speech? = runCatching {
    val folder = dir(context, alarm.alarmId)
    val manifest = folder?.let { readManifest(it) }
    val rule = manifest?.optJSONObject("rule") ?: JSONObject()
    val urgentAt = if (rule.has("urgentAtMs") && !rule.isNull("urgentAtMs")) rule.getDouble("urgentAtMs").toLong() else null
    val level = SpeechUrgency.level(alarm.snoozeCount, nowMillis, urgentAt, rule.optInt("maxLevel", 1))
    val clips = manifest?.optJSONArray("clips") ?: JSONArray()
    val byLevel = (0 until clips.length()).map { clips.getJSONObject(it) }.associateBy { it.optInt("level") }
    val clipLevel = BriefingRules.clipLevel(level, byLevel.keys)
    if (clipLevel == null) {
      // 서버 브리핑을 한 번도 못 받음(인터넷 없음 등) — 꾸러미 문장으로, 미루기만큼 단계를 올려 읽음
      val f = BriefingRules.fallback(alarm.type, alarm.voiceText, alarm.plan.heading, alarm.title, alarm.snoozeCount) ?: return@runCatching null
      return@runCatching Speech(f.level, f.text, f.pitch, f.rate, 0, null)
    }
    val clip = byLevel.getValue(clipLevel)
    val wavFile = folder?.let { File(it, "L4.wav") }
    val wav = wavFile?.takeIf { BriefingRules.useGemini(clipLevel, it.exists()) }
    Speech(
      level = clipLevel,
      text = clip.optString("text"),
      pitch = clip.optDouble("pitch", 1.0).toFloat(),
      rate = clip.optDouble("rate", 1.0).toFloat(),
      voiceIndex = clip.optInt("voiceIndex", 0),
      wav = wav,
    )
  }.getOrNull()
}
