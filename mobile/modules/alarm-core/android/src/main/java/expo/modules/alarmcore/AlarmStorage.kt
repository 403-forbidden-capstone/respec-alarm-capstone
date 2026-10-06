package expo.modules.alarmcore

import android.content.Context

data class StoredAlarm(
  val id: String,
  val title: String,
  val triggerAtMillis: Long,
  val repeat: String,
  val hour: Int,
  val minute: Int,
)

object AlarmStorage {
  private const val PREFS = "capstone_alarm_core"
  private const val IDS = "alarm_ids"

  private fun preferences(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  private fun key(id: String, field: String) = "alarm_${id}_$field"

  fun saveOneShot(context: Context, id: String, title: String, triggerAtMillis: Long) {
    save(context, id, title, triggerAtMillis, "ONCE", -1, -1)
  }

  fun saveDaily(context: Context, id: String, title: String, hour: Int, minute: Int, triggerAtMillis: Long) {
    save(context, id, title, triggerAtMillis, "DAILY", hour, minute)
  }

  private fun save(
    context: Context,
    id: String,
    title: String,
    triggerAtMillis: Long,
    repeat: String,
    hour: Int,
    minute: Int,
  ) {
    val prefs = preferences(context)
    val ids = prefs.getStringSet(IDS, emptySet()).orEmpty().toMutableSet()
    ids.add(id)
    prefs.edit()
      .putStringSet(IDS, ids)
      .putString(key(id, "title"), title)
      .putLong(key(id, "trigger"), triggerAtMillis)
      .putString(key(id, "repeat"), repeat)
      .putInt(key(id, "hour"), hour)
      .putInt(key(id, "minute"), minute)
      .apply()
  }

  fun get(context: Context, id: String): StoredAlarm? {
    val prefs = preferences(context)
    if (!prefs.getStringSet(IDS, emptySet()).orEmpty().contains(id)) return null
    return StoredAlarm(
      id = id,
      title = prefs.getString(key(id, "title"), "알람") ?: "알람",
      triggerAtMillis = prefs.getLong(key(id, "trigger"), 0L),
      repeat = prefs.getString(key(id, "repeat"), "ONCE") ?: "ONCE",
      hour = prefs.getInt(key(id, "hour"), -1),
      minute = prefs.getInt(key(id, "minute"), -1),
    )
  }

  fun all(context: Context): List<StoredAlarm> {
    return preferences(context).getStringSet(IDS, emptySet()).orEmpty().mapNotNull { get(context, it) }
  }

  fun remove(context: Context, id: String) {
    val prefs = preferences(context)
    val ids = prefs.getStringSet(IDS, emptySet()).orEmpty().toMutableSet()
    ids.remove(id)
    prefs.edit()
      .putStringSet(IDS, ids)
      .remove(key(id, "title"))
      .remove(key(id, "trigger"))
      .remove(key(id, "repeat"))
      .remove(key(id, "hour"))
      .remove(key(id, "minute"))
      .apply()
  }

  fun updateTrigger(context: Context, id: String, triggerAtMillis: Long) {
    preferences(context).edit().putLong(key(id, "trigger"), triggerAtMillis).apply()
  }
}
