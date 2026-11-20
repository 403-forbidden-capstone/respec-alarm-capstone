package expo.modules.alarmcore

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

// 해제 10분 뒤 자동으로 못 정할 때 띄우는 "지금 일어나셨나요?" 알림 (앱 H08 wake.tsx의 prompt 모양을 OS 알림으로)
//   판정 = WakeJudge(앱과 같은 규칙) — 사용 정보 접근 권한 없음 · 못 읽음 · 사용 적음은 모두 PROMPT. 네트워크 · 기기 키와 상관없이 폰 안에서만 판정해 띄움 (서버로 올리는 일은 WakeJudgeWorker)
//   누르면 H08(respecalarm://wake?alarmId=…)이 열리고 거기서 [일어났어요]. 버튼으로 바로 확정하지는 않음 (서버 device-events는 WAKE_CONFIRMED를 USAGE만 받음)
//   확정되면 JS가 dismissWakePrompt를 불러 알림을 거두고 "확정함" 표시를 남김 — 표시가 있으면(먼저 깼어요 · 앱에서 확정 · 자동 확정) 알림을 안 띄움
object WakePrompt {
  private const val CHANNEL_ID = "alarm_wake_prompt_v1"
  private const val PREFS = "capstone_alarm_core_wake_prompt"

  private fun preferences(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun notificationId(alarmId: String): Int = "wake_prompt_$alarmId".hashCode() and 0x7fffffff

  /** 해제 10분 뒤 판정 시각에 부름 — 알림이 필요하면 띄움 */
  fun promptIfNeeded(context: Context, alarmId: String, dismissedAt: Long) {
    val now = System.currentTimeMillis()
    // 권한 없음 · 안드로이드 9 미만 등 읽기 실패 = 사용 정보 없음(null) → PROMPT
    val spans = try {
      WakeJudge.toSpans(dismissedAt, DeviceUploadRules.usageToMillis(UsageSpans.read(context, dismissedAt, DeviceUploadRules.observeEndMillis(dismissedAt))))
    } catch (e: Exception) {
      null
    }
    val result = WakeJudge.evaluate(dismissedAt, now, spans)
    val confirmed = DeviceUploadRules.isWakeConfirmedRecently(confirmedAt(context, alarmId), now)
    if (DeviceUploadRules.shouldPromptWake(result, confirmed)) show(context, alarmId)
  }

  private fun confirmedAt(context: Context, alarmId: String): Long? =
    preferences(context).getLong("confirmed_$alarmId", 0L).takeIf { it > 0 }

  private fun show(context: Context, alarmId: String) {
    val app = context.applicationContext
    // 알림 권한(안드로이드 13+ POST_NOTIFICATIONS)이 꺼져 있으면 조용히 넘어감
    if (!NotificationManagerCompat.from(app).areNotificationsEnabled()) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      app.getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "기상 확인 알림", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "알람을 끈 뒤 일어났는지 자동으로 알 수 없을 때 확인하는 알림"
        },
      )
    }
    val id = notificationId(alarmId)
    val open = PendingIntent.getActivity(app, id, AlarmController.wakeIntent(app, alarmId), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val notification = NotificationCompat.Builder(app, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
      .setContentTitle("지금 일어나셨나요?")
      .setContentText("응답하면 기상 완료로 기록돼요.") // wake.tsx prompt 문구 (그룹 이름은 폰이 몰라 그룹이 없는 쪽 문구)
      .setCategory(NotificationCompat.CATEGORY_REMINDER)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setContentIntent(open)
      .setAutoCancel(true)
      .build()
    runCatching { NotificationManagerCompat.from(app).notify(id, notification) } // 권한 경합 등은 무시
  }

  /** 떠 있는 확인 알림을 모두 거둠 (로그아웃 정리 — 앞 계정의 "지금 일어나셨나요?"가 남지 않게). 알림 번호가 알람 번호의 해시라 알림 목록에서 채널로 찾음 */
  fun cancelAllPrompts(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return // 채널이 없는 8 미만은 이 알림만 가려낼 수 없음
    val manager = context.applicationContext.getSystemService(NotificationManager::class.java)
    runCatching {
      manager.activeNotifications
        .filter { it.notification.channelId == CHANNEL_ID }
        .forEach { manager.cancel(it.tag, it.id) }
    }
  }

  /** 앱(JS)이 기상을 확정하면 부름 — 떠 있는 알림을 거두고 확정 표시를 남김 */
  fun dismiss(context: Context, alarmId: String) {
    preferences(context).edit().putLong("confirmed_$alarmId", System.currentTimeMillis()).apply()
    NotificationManagerCompat.from(context.applicationContext).cancel(notificationId(alarmId))
  }
}
