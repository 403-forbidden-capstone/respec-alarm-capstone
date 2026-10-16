package expo.modules.alarmcore

import android.content.Context
import org.json.JSONArray

// 폰에 쌓이는 울림 기록 — 앱이 켜지면 읽어서 alarm_events로 올리고(markEventsUploaded) 지움
// 앱을 끄거나 재부팅해도 남도록 commit()으로 바로 씀
// 서버로 올리는 일(WorkManager)은 로그인 토큰이 필요해 여기서 하지 않음 (docs/alarm-core.md)
object AlarmEventLog {
  private const val PREFS = "capstone_alarm_core_events"
  private const val KEY = "events"

  // 오래 못 올려도 저장소가 끝없이 커지지 않게 — 넘치면 가장 오래된 것부터 버림
  private const val MAX_EVENTS = 1000

  // 앱이 켜져 있을 때만 모듈이 붙임 (JS 이벤트 전달용). 꺼져 있으면 null이고 기록은 저장소에만 쌓임
  @Volatile
  var listener: ((AlarmEventRecord) -> Unit)? = null

  private fun preferences(context: Context) =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun append(
    context: Context,
    alarmId: String,
    alarmType: String,
    eventType: String,
    sequenceNo: Int,
    snoozeMinutes: Int? = null,
  ) {
    val record = AlarmEventRecord(
      clientEventId = java.util.UUID.randomUUID().toString(),
      alarmId = alarmId,
      alarmType = alarmType,
      eventType = eventType,
      at = System.currentTimeMillis(),
      snoozeMinutes = snoozeMinutes,
      sequenceNo = sequenceNo,
      inputSource = "BUTTON",
    )
    store(context, record)
    runCatching { listener?.invoke(record) }
  }

  // 오래된 순
  @Synchronized
  fun pending(context: Context): List<AlarmEventRecord> = readAll(context)

  // 서버에 올린 기록을 지움 (없는 번호는 무시)
  @Synchronized
  fun acknowledge(context: Context, clientEventIds: Collection<String>) {
    if (clientEventIds.isEmpty()) return
    val done = clientEventIds.toSet()
    writeAll(context, readAll(context).filter { it.clientEventId !in done })
  }

  @Synchronized
  private fun store(context: Context, record: AlarmEventRecord) {
    val events = readAll(context) + record
    writeAll(context, if (events.size > MAX_EVENTS) events.takeLast(MAX_EVENTS) else events)
  }

  private fun readAll(context: Context): List<AlarmEventRecord> {
    val raw = preferences(context).getString(KEY, null) ?: return emptyList()
    val array = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
    val events = mutableListOf<AlarmEventRecord>()
    for (index in 0 until array.length()) {
      val record = runCatching { AlarmEventRecord.fromJson(array.getJSONObject(index)) }.getOrNull()
      if (record != null) events.add(record)
    }
    return events
  }

  private fun writeAll(context: Context, events: List<AlarmEventRecord>) {
    val array = JSONArray()
    events.forEach { array.put(it.toJson()) }
    preferences(context).edit().putString(KEY, array.toString()).commit()
  }
}
