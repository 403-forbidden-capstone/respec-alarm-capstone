package expo.modules.alarmcore

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

// 기상 알람 AI 음성 브리핑 — 앱이 미리 받아 둔 단계별 음성(WAV)을 알람별로 저장하고, 울릴 때 단계를 골라 파일을 줌
// 저장 위치: 앱 전용 폴더 filesDir/alarm_voice/<알람 id>/ (다른 앱 · 다른 사용자가 못 읽음). 알람이 지워지면(AlarmStorage.remove) 같이 지움
//   로그아웃은 cancelAll → 모든 알람 remove → 다음 계정에 앞 계정 브리핑이 남지 않음
// 단계 판단은 공통 TS(_shared/briefing.ts urgencyLevel)와 같은 식 — 고치면 둘 다 (briefing.test.ts가 TS 쪽 경계를 고정)
internal object VoiceBriefing {
  private const val DIR = "alarm_voice"
  private const val MANIFEST = "manifest.json"
  private val ID = Regex("^[0-9A-Za-z_-]{1,64}$")
  private val HASH = Regex("^[0-9a-f]{16}$")

  // _shared/briefing.ts SPARE_* 와 같은 값
  private const val SPARE_CALM_MIN = 20.0
  private const val SPARE_PRESS_MIN = 10.0
  private const val SPARE_EMERGENCY_MIN = 5.0

  data class Rule(val prepMinutes: Int, val lateBump: Boolean, val allow4: Boolean, val maxLevel: Int)

  /** 울릴 때의 발화 긴급도 1~4 — urgencyLevel(TS)과 같은 식 */
  fun level(rule: Rule, snoozeCount: Int, nowMillis: Long, departAt: Long?): Int {
    if (rule.maxLevel <= 1) return 1
    val spare = departAt?.let { (it - nowMillis) / 60_000.0 - rule.prepMinutes }
    var level = when {
      spare == null || spare >= SPARE_CALM_MIN -> 1
      spare >= SPARE_PRESS_MIN -> 2
      else -> 3
    }
    if ((snoozeCount >= 2 || (rule.lateBump && snoozeCount >= 1)) && level < 2) level = 2
    if (rule.allow4 && snoozeCount >= 2 && spare != null && spare < SPARE_EMERGENCY_MIN) level = 4
    return minOf(level, rule.maxLevel)
  }

  // 알람 id는 폴더 이름이 되므로 경로 문자를 막음 (../ 등)
  private fun dir(context: Context, alarmId: String): File? =
    if (ID.matches(alarmId)) File(File(context.filesDir, DIR), alarmId) else null

  private fun readManifest(dir: File): JSONObject? =
    runCatching { JSONObject(File(dir, MANIFEST).readText()) }.getOrNull()

  /**
   * 앱이 받은 결과 저장. json = { rule, clips: [{level, hash, text}], audio: [{level, hash, data(base64)}] }
   * 단계마다: 새 음성이 오면 씀, 안 왔으면 열쇠가 같은 예전 파일만 남김(내용이 바뀌었는데 생성이 실패하면 낡은 음성을 지워 기본 알람음으로)
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
      val hash = clip.getString("hash")
      if (!HASH.matches(hash)) continue
      keepLevels.add(level)
      val file = File(folder, "L$level.wav")
      val fresh = (0 until audio.length()).map { audio.getJSONObject(it) }.firstOrNull { it.optString("hash") == hash }
      if (fresh != null) {
        val tmp = File(folder, "L$level.tmp")
        tmp.writeBytes(Base64.decode(fresh.getString("data"), Base64.DEFAULT))
        if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
        files.put(level, hash)
      } else if (old.optString(level) == hash && file.exists()) {
        files.put(level, hash)
      } else {
        file.delete()
      }
    }
    folder.listFiles()?.forEach { f ->
      val lv = Regex("^L(\\d)\\.wav$").find(f.name)?.groupValues?.get(1)
      if (lv != null && lv !in keepLevels) f.delete()
    }
    val manifest = JSONObject()
      .put("rule", input.optJSONObject("rule") ?: JSONObject())
      .put("clips", clips)
      .put("files", files)
    File(folder, MANIFEST).writeText(manifest.toString())
  }

  /** 폰에 있는 음성의 열쇠 — 앱이 서버에 have로 보내 같은 음성을 다시 만들지 않게 */
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

  data class Pick(val file: File, val level: Int, val text: String?)

  /** 지금 울림에 틀 음성 — 고른 단계 파일, 없으면 그보다 낮은 단계 중 있는 것. 하나도 없으면 null(기본 알람음만) */
  @Synchronized
  fun pick(context: Context, alarm: StoredAlarm, nowMillis: Long): Pick? {
    val folder = dir(context, alarm.alarmId) ?: return null
    val manifest = readManifest(folder) ?: return null
    val r = manifest.optJSONObject("rule") ?: JSONObject()
    val rule = Rule(r.optInt("prepMinutes", 0), r.optBoolean("lateBump", false), r.optBoolean("allow4", false), r.optInt("maxLevel", 1))
    val wanted = level(rule, alarm.snoozeCount, nowMillis, alarm.departAt)
    val clips = manifest.optJSONArray("clips") ?: JSONArray()
    for (lv in wanted downTo 1) {
      val file = File(folder, "L$lv.wav")
      if (!file.exists()) continue
      val text = (0 until clips.length()).map { clips.getJSONObject(it) }.firstOrNull { it.optInt("level") == lv }?.optString("text")
      return Pick(file, lv, text)
    }
    return null
  }

  /** 화면에 보여 줄 문장 (음성이 없거나 실패해도 일정 안내는 화면에) — 고른 단계 문장 */
  fun textFor(context: Context, alarm: StoredAlarm, nowMillis: Long): String? = runCatching {
    pick(context, alarm, nowMillis)?.text ?: run {
      val folder = dir(context, alarm.alarmId) ?: return@run null
      val clips = readManifest(folder)?.optJSONArray("clips") ?: return@run null
      if (clips.length() > 0) clips.getJSONObject(0).optString("text").takeIf { it.isNotEmpty() } else null
    }
  }.getOrNull()
}
