package expo.modules.alarmcore

import android.app.AlarmManager
import android.content.Context
import androidx.work.WorkManager

// 걸어 둔 "해제 + 10분 판정" 예약의 장부 — 예약은 알람 번호로만 지울 수 있는데 시스템(AlarmManager · WorkManager)에서 목록을 읽을 수 없어서, 걸 때 번호를 적어 둠
//   로그아웃 정리(AlarmController.cancelAll)가 이 장부로 앞 계정의 판정 예약(정확 알람 · 지연 작업)을 모두 지움 — 안 지우면 다음 계정에 앞 계정의 확인 알림이 뜸
//   예약은 하루 안에 모두 지나가므로 하루 넘은 줄은 걸 때 버림
object WakeJudgeLedgerRules {
  const val KEEP_MILLIS = 24L * 60 * 60 * 1000
  private const val SEPARATOR = "|"

  fun encode(alarmId: String, dismissedAt: Long): String = "$alarmId$SEPARATOR$dismissedAt"

  fun alarmIdOf(entry: String): String? = entry.substringBefore(SEPARATOR, "").takeIf { it.isNotEmpty() && entry.contains(SEPARATOR) }

  private fun dismissedAtOf(entry: String): Long? = entry.substringAfter(SEPARATOR, "").toLongOrNull()

  /** 같은 알람을 또 끄면 나중 것으로 바뀜(예약도 같은 번호로 덮어씀). 하루 넘은 줄과 깨진 줄은 뺌 */
  fun add(entries: Set<String>, alarmId: String, dismissedAt: Long, nowMillis: Long): Set<String> =
    (entries.filter { alarmIdOf(it) != alarmId } + encode(alarmId, dismissedAt))
      .filter { entry -> dismissedAtOf(entry)?.let { nowMillis - it <= KEEP_MILLIS } == true }
      .toSet()
}

object WakeJudgeLedger {
  private const val PREFS = "capstone_alarm_core_wake_judges"
  private const val ENTRIES = "entries"

  private fun preferences(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  @Synchronized
  fun record(context: Context, alarmId: String, dismissedAt: Long) {
    val prefs = preferences(context)
    val next = WakeJudgeLedgerRules.add(prefs.getStringSet(ENTRIES, emptySet()).orEmpty(), alarmId, dismissedAt, System.currentTimeMillis())
    prefs.edit().putStringSet(ENTRIES, next).commit()
  }

  /** 장부에 적힌 판정 예약을 모두 지우고 장부를 비움 */
  @Synchronized
  fun cancelAll(context: Context) {
    val app = context.applicationContext
    val prefs = preferences(app)
    val alarmManager = app.getSystemService(AlarmManager::class.java)
    val work = WorkManager.getInstance(app)
    for (entry in prefs.getStringSet(ENTRIES, emptySet()).orEmpty()) {
      val alarmId = WakeJudgeLedgerRules.alarmIdOf(entry) ?: continue
      runCatching { alarmManager.cancel(WakeJudgeSchedule.operation(app, alarmId, 0L)) }
      runCatching { work.cancelUniqueWork("device_wake_$alarmId") }
      runCatching { work.cancelUniqueWork("device_wake_prompt_$alarmId") }
    }
    prefs.edit().remove(ENTRIES).commit()
  }
}
