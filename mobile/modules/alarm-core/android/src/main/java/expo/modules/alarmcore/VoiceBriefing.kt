package expo.modules.alarmcore

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

// 알람 음성 브리핑 저장소 — 앱이 미리 받아 둔 단계별 문장(Android TTS용) · 3 · 4단계 Gemini 음성(L3/L4.wav)을 알람별로 두고, 울릴 때 읽을 것을 고름
// 저장 위치: 앱 전용 폴더 filesDir/alarm_voice/<알람 id>/ (다른 앱 · 다른 사용자가 못 읽음). 알람이 지워지면(AlarmStorage.remove) 같이 지움
//   로그아웃은 cancelAll → clearAll → 다음 계정에 앞 계정 브리핑이 남지 않음
// 단계 판단은 SpeechUrgency (TS levelAt과 같은 식). 3 · 4단계: 그 단계 개인화 캐시 > 앱에 든 그 단계 예비 WAV(기상만) > Android TTS로 같은 단계 문장 (BriefingRules)
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
   * 앱 맞추기(prepareBriefings)와 백그라운드 갱신(BriefingRefreshWorker, #515)이 같이 씀 — 받은 값을 먼저 다 풀어 본 뒤에 파일을 바꿈
   *   (JSON · base64가 깨졌으면 던지고 예전 브리핑은 그대로). manifest는 임시 파일에 쓴 뒤 바꿔 넣음
   */
  @Synchronized
  fun save(context: Context, alarmId: String, json: String) {
    val folder = dir(context, alarmId) ?: throw IllegalArgumentException("알람 id가 이상해요")
    val input = JSONObject(json)
    val old = readManifest(folder)?.optJSONObject("files") ?: JSONObject()
    val audio = input.optJSONArray("audio") ?: JSONArray()
    val clips = input.optJSONArray("clips") ?: JSONArray()
    val decoded = (0 until audio.length()).map { audio.getJSONObject(it) }.associate { it.optString("hash") to Base64.decode(it.getString("data"), Base64.DEFAULT) }
    for (i in 0 until clips.length()) clips.getJSONObject(i).getInt("level") // 단계 번호가 없으면 여기서 던짐 (아무것도 안 바꿈)
    folder.mkdirs()
    val files = JSONObject()
    val keepLevels = mutableSetOf<String>()
    for (i in 0 until clips.length()) {
      val clip = clips.getJSONObject(i)
      val level = clip.getInt("level").toString()
      val hash = clip.optString("hash")
      if (!HASH.matches(hash)) continue
      val file = File(folder, "L$level.wav")
      val fresh = decoded[hash]
      if (fresh != null) {
        val tmp = File(folder, "L$level.tmp")
        tmp.writeBytes(fresh)
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
    val tmpManifest = File(folder, "$MANIFEST.tmp")
    tmpManifest.writeText(manifest.toString())
    if (!tmpManifest.renameTo(File(folder, MANIFEST))) {
      File(folder, MANIFEST).delete()
      tmpManifest.renameTo(File(folder, MANIFEST))
    }
  }

  /** 폰에 있는 Gemini 음성의 열쇠 — 앱이 서버에 have로 보내 같은 음성을 다시 안 만들게 */
  @Synchronized
  fun hashes(context: Context, alarmId: String): List<String> {
    val folder = dir(context, alarmId) ?: return emptyList()
    val files = readManifest(folder)?.optJSONObject("files") ?: return emptyList()
    return files.keys().asSequence().filter { File(folder, "L$it.wav").exists() }.map { files.getString(it) }.toList()
  }

  /**
   * 개발 화면 전용 — 시험 알람 폴더를 새로 씀. json = { rule, clips, test: {sound, voice, gemini} } (앱이 서버 브리핑 규칙으로 만든 샘플 문장)
   * 3 · 4단계 출처 모의(VoiceTest.geminiMode): CACHE면 실제 알람이 미리 받아 둔 그 단계 Gemini 음성을 복사(원본은 안 건드림, 문장도 그 음성의 실제 문장으로),
   *   BROKEN이면 깨진 파일을 둠, FALLBACK · ANDROID면 캐시를 안 둠 (→ speechFor가 예비 WAV 또는 Android TTS를 고름)
   * 돌려주는 값 = 음성을 빌려 온 알람 id (없으면 null). 새 Gemini 호출은 없음
   */
  @Synchronized
  fun saveForTest(context: Context, alarmId: String, json: String): String? {
    require(VoiceTest.isTestAlarm(alarmId)) { "시험 알람 id가 아니에요" }
    val folder = dir(context, alarmId) ?: throw IllegalArgumentException("알람 id가 이상해요")
    folder.deleteRecursively()
    folder.mkdirs()
    val input = JSONObject(json)
    val clips = input.optJSONArray("clips") ?: JSONArray()
    val files = JSONObject()
    var source: String? = null
    val mode = VoiceTest.geminiMode(input.optJSONObject("test")?.optStringOrNull("gemini"))
    val root = File(context.filesDir, DIR)
    for (level in 3..4) {
      val clip = (0 until clips.length()).map { clips.getJSONObject(it) }.firstOrNull { it.optInt("level") == level } ?: continue
      val target = File(folder, "L$level.wav")
      if (mode == "BROKEN") {
        target.writeText("깨진 캐시 시험") // WAV가 아님 → MediaPlayer가 못 열어 예비 WAV로 넘어가야 함
        files.put(level.toString(), clip.optString("hash"))
      }
      if (mode != "CACHE") continue
      val candidates = root.listFiles().orEmpty().filter { it.isDirectory }.map { d ->
        val manifest = readManifest(d)
        val arr = manifest?.optJSONArray("clips")
        val c = arr?.let { a -> (0 until a.length()).map { a.getJSONObject(it) }.firstOrNull { it.optInt("level") == level } }
        VoiceTest.GeminiCandidate(d.name, File(d, "L$level.wav").exists(), manifest?.optJSONObject("files")?.optStringOrNull(level.toString()), c?.optStringOrNull("text"))
      }
      VoiceTest.pickGeminiSource(candidates)?.let { picked ->
        // 복사가 실패하면 캐시 없이(→ 예비 WAV · Android TTS) — 화면이 출처를 그대로 보여 줌
        runCatching { File(File(root, picked.alarmId), "L$level.wav").copyTo(target, overwrite = true) }.onSuccess {
          clip.put("text", picked.text).put("hash", picked.hash)
          files.put(level.toString(), picked.hash)
          source = source ?: picked.alarmId
        }
      }
    }
    val manifest = JSONObject()
      .put("rule", input.optJSONObject("rule") ?: JSONObject())
      .put("clips", clips)
      .put("files", files)
      .put("test", input.optJSONObject("test") ?: JSONObject())
    File(folder, MANIFEST).writeText(manifest.toString())
    return source
  }

  /** 시험 알람의 소리 · 음성 켜기 (개발 화면이 끈 것만). 운영 알람은 폴더를 안 읽고 늘 켬 */
  @Synchronized
  fun testOptions(context: Context, alarmId: String): VoiceTest.Options {
    if (!VoiceTest.isTestAlarm(alarmId)) return VoiceTest.Options()
    val test = dir(context, alarmId)?.let { readManifest(it) }?.optJSONObject("test")
    return VoiceTest.options(alarmId, test?.optBoolean("sound", true), test?.optBoolean("voice", true))
  }

  @Synchronized
  fun clear(context: Context, alarmId: String) {
    dir(context, alarmId)?.deleteRecursively()
  }

  @Synchronized
  fun clearAll(context: Context) {
    File(context.filesDir, DIR).deleteRecursively()
  }

  /**
   * 한 울림에 읽을 것 — 앞에서부터 시도: wav(개인화 캐시) → bundled(앱에 든 그 단계 예비 WAV 리소스) → text를 Android TTS로 (pitch · rate · voiceIndex)
   * speed = WAV 재생 속도 (BriefingRules.wavSpeed)
   */
  data class Speech(
    val level: Int,
    val text: String,
    val pitch: Float,
    val rate: Float,
    val voiceIndex: Int,
    val wav: File?,
    val bundled: Int? = null,
    val speed: Float = 1f,
  ) {
    val source: String get() = BriefingRules.source(level, wav != null, bundled != null)
  }

  // 단계 번호 → 예비 WAV 리소스 (파일명은 예전 이름 그대로, TS GEMINI_FALLBACK_FILE과 같음). 3단계 = 엄마 Gacrux, 4단계 = 긴급 Kore
  private fun bundledRes(level: Int?): Int? = when (level) {
    3 -> R.raw.gemini_stage4_fallback
    4 -> R.raw.gemini_urgent_sample
    else -> null
  }

  /**
   * 지금 울림에 읽을 브리핑. 저장된 브리핑이 없으면(못 받음 · 네트워크 없음) 꾸러미의 기상 문장(voiceText) 또는 "머리글. 제목"을 Android TTS로 —
   * 캐시가 없어도 음성 안내는 나옴. 문장이 하나도 없으면 null(알람음만)
   */
  @Synchronized
  fun speechFor(context: Context, alarm: StoredAlarm, nowMillis: Long): Speech? = runCatching {
    if (!testOptions(context, alarm.alarmId).voice) return@runCatching null // 개발 화면 "알람음만 · 진동만" 시험
    val folder = dir(context, alarm.alarmId)
    val manifest = folder?.let { readManifest(it) }
    // 개발 화면 시험 값 — 시험 알람만 (운영 알람은 저장된 값이 있어도 무시)
    val test = manifest?.optJSONObject("test")?.takeIf { VoiceTest.isTestAlarm(alarm.alarmId) }
    val forceAndroid = VoiceTest.geminiMode(test?.optStringOrNull("gemini")) == "ANDROID"
    val bundledFor = { lv: Int -> if (forceAndroid) null else bundledRes(BriefingRules.fallbackWavLevel(alarm.type, lv)) }
    val rule = manifest?.optJSONObject("rule") ?: JSONObject()
    val dangerAt = if (rule.has("dangerAtMs") && !rule.isNull("dangerAtMs")) rule.getDouble("dangerAtMs").toLong() else null
    val urgentAt = if (rule.has("urgentAtMs") && !rule.isNull("urgentAtMs")) rule.getDouble("urgentAtMs").toLong() else null
    val level = SpeechUrgency.level(alarm.snoozeCount, nowMillis, dangerAt, urgentAt, rule.optInt("maxLevel", 1))
    val clips = manifest?.optJSONArray("clips") ?: JSONArray()
    val byLevel = (0 until clips.length()).map { clips.getJSONObject(it) }.associateBy { it.optInt("level") }
    val clipLevel = BriefingRules.clipLevel(level, byLevel.keys)
    if (clipLevel == null) {
      // 서버 브리핑을 한 번도 못 받음(인터넷 없음 등) — 꾸러미 문장으로, 미루기만큼 단계를 올려 읽음
      //   미루기로 3단계가 되면 기상은 3단계 예비 WAV가 먼저 (그것도 못 틀면 이 문장을 Android TTS로)
      val f = BriefingRules.fallback(alarm.type, alarm.voiceText, alarm.plan.heading, alarm.title, alarm.snoozeCount) ?: return@runCatching null
      return@runCatching Speech(f.level, f.text, f.pitch, f.rate, 0, null, bundledFor(f.level), BriefingRules.wavSpeed(f.level))
    }
    val clip = byLevel.getValue(clipLevel)
    // 그 단계 파일만 봄 (3단계에 4단계 파일을 틀지 않음)
    val wavFile = folder?.let { File(it, "L$clipLevel.wav") }
    val wav = wavFile?.takeIf { !forceAndroid && BriefingRules.useGemini(clipLevel, it.exists()) }
    Speech(
      level = clipLevel,
      text = clip.optString("text"),
      pitch = clip.optDouble("pitch", 1.0).toFloat(),
      rate = clip.optDouble("rate", 1.0).toFloat(),
      voiceIndex = clip.optInt("voiceIndex", 0),
      wav = wav,
      bundled = bundledFor(clipLevel),
      speed = BriefingRules.wavSpeed(clipLevel),
    )
  }.getOrNull()
}
