package expo.modules.alarmcore

import android.content.Context
import org.json.JSONObject

// 폰에 걸린 알람 저장소 (SharedPreferences). 알람 하나 = JSON 글자 하나 (StoredAlarm)
// 앱이 꺼져 있어도 · 재부팅해도 남아야 하므로 commit()으로 바로 씀
// 예전(#26) 저장소(capstone_alarm_core)와 이름을 달리해 새로 시작함 — 개발용이라 옮기지 않음
object AlarmStorage {
  private const val PREFS = "capstone_alarm_core_v2"
  private const val IDS = "alarm_ids"

  private fun preferences(context: Context) =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun key(id: String) = "alarm_$id"

  @Synchronized
  fun save(context: Context, alarm: StoredAlarm) {
    val prefs = preferences(context)
    val ids = prefs.getStringSet(IDS, emptySet()).orEmpty().toMutableSet()
    ids.add(alarm.alarmId)
    prefs.edit()
      .putStringSet(IDS, ids)
      .putString(key(alarm.alarmId), alarm.toJson().toString())
      .commit()
  }

  @Synchronized
  fun get(context: Context, id: String): StoredAlarm? {
    val raw = preferences(context).getString(key(id), null) ?: return null
    return runCatching { StoredAlarm.fromJson(JSONObject(raw)) }.getOrNull()
  }

  @Synchronized
  fun all(context: Context): List<StoredAlarm> {
    val ids = preferences(context).getStringSet(IDS, emptySet()).orEmpty().toList()
    return ids.mapNotNull { get(context, it) }
  }

  @Synchronized
  fun remove(context: Context, id: String, keepVoice: Boolean = false) {
    val prefs = preferences(context)
    val ids = prefs.getStringSet(IDS, emptySet()).orEmpty().toMutableSet()
    ids.remove(id)
    prefs.edit()
      .putStringSet(IDS, ids)
      .remove(key(id))
      .commit()
    // 알람이 없어지면 그 알람의 AI 음성 브리핑 파일도 (해제 · 취소 · 로그아웃 cancelAll 모두 여기를 지남)
    if (!keepVoice) runCatching { VoiceBriefing.clear(context, id) }
    // 새벽 브리핑 갱신 예약 · 대기 작업도 (#515) — 지운 · 끈 · 수정 전 알람에 갱신이 남지 않게 (수정은 schedule이 새 시각으로 다시 걺)
    BriefingRefresh.cancel(context, id)
  }
}
