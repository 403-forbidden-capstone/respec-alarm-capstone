package expo.modules.alarmcore

import android.app.AlarmManager
import android.content.Context
import androidx.work.WorkManager

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
  fun all(context: Context): List<Pair<String, Long>> = entriesOf(preferences(context).all)

  /** 저장된 값 중 쓸 수 있는 것만 — 알람 id → 해제 시각(ms, 0보다 큼). 깨진 값은 뺌 */
  fun entriesOf(raw: Map<String, *>): List<Pair<String, Long>> =
    raw.mapNotNull { (id, value) -> (value as? Long)?.takeIf { it > 0 }?.let { id to it } }

  /**
   * 저장된 판정 예약을 모두 지움 — 정확 알람 · 지연 작업을 취소하고 저장 기록도 비워 재부팅 복원 대상에서 뺌 (로그아웃 정리, AlarmController.cancelAll).
   * 안 지우면 다음 계정에 앞 계정의 "지금 일어나셨나요?"가 뜸. PendingIntent는 같은 알람 id면 같으므로(extras 비교 안 함) dismissedAt은 아무 값이나
   */
  @Synchronized
  fun cancelAll(context: Context) {
    val app = context.applicationContext
    val alarmManager = app.getSystemService(AlarmManager::class.java)
    val work = WorkManager.getInstance(app)
    for ((alarmId, _) in all(app)) {
      runCatching { alarmManager.cancel(WakeJudgeSchedule.operation(app, alarmId, 0L)) }
      runCatching { work.cancelUniqueWork("device_wake_$alarmId") }
      runCatching { work.cancelUniqueWork("device_wake_prompt_$alarmId") }
    }
    preferences(app).edit().clear().commit()
  }
}
