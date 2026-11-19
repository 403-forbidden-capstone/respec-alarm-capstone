package expo.modules.alarmcore

import android.content.Context

// 해제 + 10분 기상 판정 예약을 폰에 저장해 둠 (SharedPreferences) — AlarmManager 예약은 재부팅하면 사라지므로 AlarmBootReceiver가 이 기록으로 되살림 (G7)
//   알람 id → 마지막 해제 시각(ms). 같은 알람을 또 끄면 나중 해제로 덮음. 판정이 시작되거나 기상이 확정되면 지움
object WakeJudgeStore {
  private const val PREFS = "capstone_alarm_core_wake_judge"

  private fun preferences(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  @Synchronized
  fun save(context: Context, alarmId: String, dismissedAt: Long) {
    preferences(context).edit().putLong(alarmId, dismissedAt).commit()
  }

  /** dismissedAt을 주면 그 해제로 저장된 것만 지움 (그 사이 더 늦은 해제가 덮었으면 그대로 둠) */
  @Synchronized
  fun remove(context: Context, alarmId: String, dismissedAt: Long? = null) {
    val prefs = preferences(context)
    if (dismissedAt != null && prefs.getLong(alarmId, 0L) != dismissedAt) return
    prefs.edit().remove(alarmId).commit()
  }

  @Synchronized
  fun all(context: Context): List<Pair<String, Long>> =
    preferences(context).all.mapNotNull { (id, value) -> (value as? Long)?.takeIf { it > 0 }?.let { id to it } }
}
