package expo.modules.alarmcore

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit

// 백그라운드 기상 브리핑 갱신 예약 (#515) — 기상 알람마다 정확 알람 하나(시각만 바뀜) → BriefingRefreshReceiver → WorkManager(BriefingRefreshWorker)
//   언제: 알람 날(KST) 04:10 (전날 대화 자동 정리 뒤) · 서버가 "아직 정리 전"이라고 준 refresh_at — 둘 중 지금 뒤 · 기상 5분 전 앞인 이른 것 (BriefingRules.pickRefresh)
//   기상 알람을 걸 때(AlarmController.schedule · restoreAll) · 앱이나 갱신 작업이 브리핑을 저장할 때(refresh_at) 다시 정하고, 알람이 지워지면(AlarmStorage.remove) 지움
//   AlarmManager.setExactAndAllowWhileIdle — Doze 중에도 깨어남. 정확 알람 권한이 없거나 못 걸면 조용히 넘어감(기상 알람 자체는 영향 없음, 앱을 열 때 맞추기로)
object BriefingRefresh {
  private const val PREFS = "alarm_briefing_refresh"
  const val EXTRA_ALARM_ID = "alarm_id"

  private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun requestCode(id: String): Int = "refresh_$id".hashCode() and 0x7fffffff

  private fun operation(context: Context, id: String): PendingIntent {
    val intent = Intent(context, BriefingRefreshReceiver::class.java).apply {
      data = Uri.fromParts("alarmcore-refresh", id, null) // 알람마다 다른 PendingIntent (AlarmScheduler와 같은 방식)
      putExtra(EXTRA_ALARM_ID, id)
    }
    return PendingIntent.getBroadcast(context, requestCode(id), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  /** 기상 알람을 걸었을 때(재부팅 뒤 다시 걸 때 포함 — 정확 알람은 재부팅하면 사라짐) — 새벽 4:10 후보를 더함. 이미 걸린 refresh_at이 더 이르면 그것 */
  fun onAlarmScheduled(context: Context, alarm: StoredAlarm) {
    if (alarm.type != "WAKE") return
    offer(context, alarm.alarmId, null)
  }

  /**
   * 후보 시각을 더해 다시 정함 — 후보 = 이 알람의 새벽 4:10 · 걸어 둔 시각 · at(서버 refresh_at). at = null이면 앞의 둘만
   * 갱신 작업이 끝난 뒤에도 불려서, 다른 날 알람이면 그날 4:10이 다시 걸림 (알람 시각 변경 · 재부팅 뒤 다시 걸기도 같은 길)
   */
  @Synchronized
  fun offer(context: Context, alarmId: String, at: Long?) {
    runCatching {
      val alarm = AlarmStorage.get(context, alarmId)
      if (alarm == null || alarm.type != "WAKE") return unset(context, alarmId)
      val stored = prefs(context).getLong(alarmId, 0L).takeIf { it > 0 }
      val pick = BriefingRules.pickRefresh(listOf(stored, at, BriefingRules.refreshSlot(alarm.atMillis)), System.currentTimeMillis(), BriefingRules.refreshDeadline(alarm.atMillis))
        ?: return unset(context, alarmId)
      if (!AlarmScheduler.canScheduleExactAlarms(context)) return unset(context, alarmId)
      context.getSystemService(AlarmManager::class.java).setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, pick, operation(context, alarmId))
      prefs(context).edit().putLong(alarmId, pick).commit()
    }
  }

  /** 걸어 둔 갱신 시각 · 대기 중인 작업을 지움 (알람 삭제 · 해제 · 로그아웃 cancelAll — AlarmStorage.remove) */
  fun cancel(context: Context, alarmId: String) {
    unset(context, alarmId)
    runCatching { WorkManager.getInstance(context).cancelUniqueWork(workName(alarmId)) }
  }

  // 갱신 시각만 지움 (도는 작업은 그대로 — 작업 자신이 offer를 부르므로 여기서 작업을 지우면 안 됨)
  private fun unset(context: Context, alarmId: String) {
    runCatching { context.getSystemService(AlarmManager::class.java).cancel(operation(context, alarmId)) }
    prefs(context).edit().remove(alarmId).commit()
  }

  fun workName(alarmId: String) = "briefing_refresh_$alarmId"

  /**
   * 갱신 시각이 됨 — 작업 하나를 넣음. 같은 알람 작업이 이미 돌거나 다시 시도를 기다리면 그대로 둠(KEEP, 중복 실행 없음)
   * 급한 작업(expedited) — Doze 중에도 네트워크를 씀. 할당량이 모자라면 보통 작업으로(늦을 수 있음 → 그래도 저장된 브리핑으로 울림)
   * 네트워크 연결 조건 — 인터넷이 없으면 생길 때까지 기다림 (작업이 시작될 때 마감을 다시 봄)
   */
  fun enqueue(context: Context, alarmId: String) {
    prefs(context).edit().remove(alarmId).commit()
    val request = OneTimeWorkRequestBuilder<BriefingRefreshWorker>()
      .setInputData(workDataOf(EXTRA_ALARM_ID to alarmId))
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
      .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BriefingRefreshWorker.BACKOFF_SECONDS, TimeUnit.SECONDS)
      .build()
    WorkManager.getInstance(context).enqueueUniqueWork(workName(alarmId), ExistingWorkPolicy.KEEP, request)
  }
}

// 갱신 정확 알람 → 작업 넣기만 (바로 끝남)
class BriefingRefreshReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra(BriefingRefresh.EXTRA_ALARM_ID) ?: return
    runCatching { BriefingRefresh.enqueue(context, id) }
  }
}
