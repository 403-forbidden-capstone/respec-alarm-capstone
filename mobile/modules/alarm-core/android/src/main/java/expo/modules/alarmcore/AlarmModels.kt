package expo.modules.alarmcore

import org.json.JSONArray
import org.json.JSONObject

// JSON 값이 없거나 null이면 null (org.json의 optString은 null 값을 "null" 글자로 돌려주므로 따로 확인함)
internal fun JSONObject.optStringOrNull(name: String): String? =
  if (has(name) && !isNull(name)) getString(name) else null

internal fun JSONObject.optLongOrNull(name: String): Long? =
  if (has(name) && !isNull(name)) getLong(name) else null

internal fun JSONObject.optDoubleOrNull(name: String): Double? =
  if (has(name) && !isNull(name)) getDouble(name) else null

/**
 * 공통(TS)이 계산해 넘긴 울림 계획. 네이티브는 판단하지 않고 이 값대로만 실행함
 * 칸은 src/plan.ts의 RingPlan과 같음
 */
data class RingPlan(
  val sound: Boolean,
  val volumePercent: Int,
  val soundKey: String,
  val maxRingMillis: Long,
  // 첫 울림 시작으로부터의 거리 (ms). 비어 있으면 다시 울림 없음
  val reRingOffsetsMillis: List<Long>,
  val snoozeMillis: Long,
  val heading: String,
  val oneTapLabel: String?,
  val oneTapEventType: String?,
) {
  fun toJson(): JSONObject = JSONObject().apply {
    put("sound", sound)
    put("volumePercent", volumePercent)
    put("soundKey", soundKey)
    put("maxRingMillis", maxRingMillis)
    put("reRingOffsetsMillis", JSONArray().also { array -> reRingOffsetsMillis.forEach { array.put(it) } })
    put("snoozeMillis", snoozeMillis)
    put("heading", heading)
    put("oneTapLabel", oneTapLabel ?: JSONObject.NULL)
    put("oneTapEventType", oneTapEventType ?: JSONObject.NULL)
  }

  companion object {
    fun fromJson(json: JSONObject): RingPlan {
      val offsets = json.optJSONArray("reRingOffsetsMillis")
      val offsetList = mutableListOf<Long>()
      if (offsets != null) {
        for (index in 0 until offsets.length()) offsetList.add(offsets.getLong(index))
      }
      return RingPlan(
        sound = json.optBoolean("sound", false),
        volumePercent = json.optInt("volumePercent", 0),
        soundKey = json.optStringOrNull("soundKey") ?: "default",
        maxRingMillis = json.optLong("maxRingMillis", 0L),
        reRingOffsetsMillis = offsetList,
        snoozeMillis = json.optLong("snoozeMillis", 0L),
        heading = json.optStringOrNull("heading") ?: "",
        oneTapLabel = json.optStringOrNull("oneTapLabel"),
        oneTapEventType = json.optStringOrNull("oneTapEventType"),
      )
    }
  }
}

/**
 * 폰에 걸려 있는 알람 한 개 — 예약 꾸러미(RingPackage) + 울림 계획 + 지금 상태
 * 상태 칸은 JS가 넘기는 JSON에는 없고(기본값), 울림 · 미루기 · 다시 울림 때 네이티브가 바꿈
 * snoozeLimit · voiceText · departAt은 저장만 하고 아직 읽지 않음 (D3 · D8)
 */
data class StoredAlarm(
  val alarmId: String,
  val type: String,
  // 처음 예약한 시각 (서버 scheduled_at)
  val atMillis: Long,
  val title: String,
  val subtitle: String?,
  val intensity: String,
  val snoozeLimit: Int,
  val voiceText: String?,
  val soundKey: String?,
  val volumeAdjust: Double?,
  val departAt: Long?,
  val plan: RingPlan,
  // --- 상태 ---
  // 미룬 횟수 (미루기만 셈, 다시 울림은 안 셈)
  val snoozeCount: Int = 0,
  // 다음에 실제로 울릴 시각 — 미뤘거나 다시 울림을 기다리면 atMillis와 다름
  val nextRingAt: Long = atMillis,
  // 지금까지 울린 횟수 (미루기 · 다시 울림 포함) → 기록의 sequenceNo
  val ringCount: Int = 0,
  // 다음에 울릴 것이 한 번의 "울림 묶음"에서 몇 번째인지. 0 = 새 묶음(처음 울림 또는 미루고 난 뒤)
  val seriesIndex: Int = 0,
  // 이번 묶음의 첫 울림이 시작된 시각 — 다시 울림 시각을 여기서부터의 거리로 계산함
  val seriesStartAt: Long = 0L,
  val ringing: Boolean = false,
) {
  // 이번에 울린 것이 묶음의 마지막 울림(더 걸어 둔 다시 울림이 없음)인지
  val isLastRingOfSeries: Boolean
    get() = seriesIndex > plan.reRingOffsetsMillis.size

  fun toJson(): JSONObject = JSONObject().apply {
    put("alarmId", alarmId)
    put("type", type)
    put("atMillis", atMillis)
    put("title", title)
    put("subtitle", subtitle ?: JSONObject.NULL)
    put("intensity", intensity)
    put("snoozeLimit", snoozeLimit)
    put("voiceText", voiceText ?: JSONObject.NULL)
    put("soundKey", soundKey ?: JSONObject.NULL)
    put("volumeAdjust", volumeAdjust ?: JSONObject.NULL)
    put("departAt", departAt ?: JSONObject.NULL)
    put("plan", plan.toJson())
    put("snoozeCount", snoozeCount)
    put("nextRingAt", nextRingAt)
    put("ringCount", ringCount)
    put("seriesIndex", seriesIndex)
    put("seriesStartAt", seriesStartAt)
    put("ringing", ringing)
  }

  companion object {
    fun fromJson(json: JSONObject): StoredAlarm {
      val atMillis = json.getLong("atMillis")
      return StoredAlarm(
        alarmId = json.getString("alarmId"),
        type = json.getString("type"),
        atMillis = atMillis,
        title = json.optStringOrNull("title") ?: "알람",
        subtitle = json.optStringOrNull("subtitle"),
        intensity = json.optStringOrNull("intensity") ?: "NORMAL",
        snoozeLimit = json.optInt("snoozeLimit", 3),
        voiceText = json.optStringOrNull("voiceText"),
        soundKey = json.optStringOrNull("soundKey"),
        volumeAdjust = json.optDoubleOrNull("volumeAdjust"),
        departAt = json.optLongOrNull("departAt"),
        plan = RingPlan.fromJson(json.getJSONObject("plan")),
        snoozeCount = json.optInt("snoozeCount", 0),
        nextRingAt = json.optLongOrNull("nextRingAt") ?: atMillis,
        ringCount = json.optInt("ringCount", 0),
        seriesIndex = json.optInt("seriesIndex", 0),
        seriesStartAt = json.optLong("seriesStartAt", 0L),
        ringing = json.optBoolean("ringing", false),
      )
    }
  }
}

/**
 * 폰에 쌓이는 울림 기록 한 줄 — 앱이 alarm_events로 올린 뒤 지움
 * clientEventId는 폰이 만든 UUID (DB 중복 방지 칸에 그대로 들어감)
 */
data class AlarmEventRecord(
  val clientEventId: String,
  val alarmId: String,
  val alarmType: String,
  // TRIGGERED · SNOOZED · DISMISSED · ACKNOWLEDGED · ARRIVAL_CONFIRMED
  val eventType: String,
  val at: Long,
  val snoozeMinutes: Int?,
  val sequenceNo: Int,
  val inputSource: String,
) {
  fun toJson(): JSONObject = JSONObject().apply {
    put("clientEventId", clientEventId)
    put("alarmId", alarmId)
    put("alarmType", alarmType)
    put("eventType", eventType)
    put("at", at)
    put("snoozeMinutes", snoozeMinutes ?: JSONObject.NULL)
    put("sequenceNo", sequenceNo)
    put("inputSource", inputSource)
  }

  // JS로 보내는 모양 (숫자는 Double, 없는 칸은 빠짐)
  fun toMap(): Map<String, Any> {
    val map = mutableMapOf<String, Any>(
      "clientEventId" to clientEventId,
      "alarmId" to alarmId,
      "alarmType" to alarmType,
      "eventType" to eventType,
      "at" to at.toDouble(),
      "sequenceNo" to sequenceNo,
      "inputSource" to inputSource,
    )
    if (snoozeMinutes != null) map["snoozeMinutes"] = snoozeMinutes
    return map
  }

  companion object {
    fun fromJson(json: JSONObject): AlarmEventRecord = AlarmEventRecord(
      clientEventId = json.getString("clientEventId"),
      alarmId = json.getString("alarmId"),
      alarmType = json.getString("alarmType"),
      eventType = json.getString("eventType"),
      at = json.getLong("at"),
      snoozeMinutes = if (json.has("snoozeMinutes") && !json.isNull("snoozeMinutes")) json.getInt("snoozeMinutes") else null,
      sequenceNo = json.optInt("sequenceNo", 1),
      inputSource = json.optStringOrNull("inputSource") ?: "BUTTON",
    )
  }
}
