package expo.modules.alarmcore

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat

// 소리 없는 알림 — WAKE를 뺀 준비 시작 · 출발 · 도착 · 루틴 (alarm-core.md 소리 줄)
// 알림 한 줄에 원탭 버튼 하나("준비 시작" · "출발했어요" · "도착했어요" · "했어요"). 누르면 기록만 남기고 앱은 열지 않음
object AlarmNotifications {
  // 채널은 한 번 만들면 소리 · 진동 설정을 못 바꾸므로 설정이 바뀌면 이름의 버전을 올림
  private const val SILENT_CHANNEL_ID = "alarm_silent_v1"
  private const val SILENT_NOTIFICATION_ID = 4200

  private fun ensureSilentChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      SILENT_CHANNEL_ID,
      "준비 · 출발 · 도착 알림",
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      description = "소리 없이 알려 주는 준비 시작 · 출발 · 도착 · 루틴 알림"
      setSound(null, null)
      enableVibration(false)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
    context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  fun showSilent(context: Context, alarm: StoredAlarm) {
    ensureSilentChannel(context)

    // 이 알림의 버튼은 알람 저장소에 기대지 않음 — 울린 알람은 저장소에서 지워지므로 필요한 값을 인텐트에 실음
    val oneTapIntent = Intent(context, AlarmActionReceiver::class.java).apply {
      action = AlarmActionReceiver.ACTION_ONE_TAP
      // PendingIntent는 extras를 비교하지 않으므로 data로 알람마다 구분
      data = Uri.fromParts("alarmcore", "${alarm.alarmId}/one_tap", null)
      putExtra(AlarmScheduler.EXTRA_ALARM_ID, alarm.alarmId)
      putExtra(AlarmActionReceiver.EXTRA_ALARM_TYPE, alarm.type)
      putExtra(AlarmActionReceiver.EXTRA_EVENT_TYPE, alarm.plan.oneTapEventType ?: "ACKNOWLEDGED")
    }
    val oneTapPending = PendingIntent.getBroadcast(
      context,
      alarm.alarmId.hashCode() + 3,
      oneTapIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val text = listOfNotNull(alarm.plan.heading.takeIf { it.isNotEmpty() }, alarm.subtitle).joinToString(" · ")
    val builder = NotificationCompat.Builder(context, SILENT_CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
      .setContentTitle(alarm.title)
      .setContentText(text)
      .setCategory(NotificationCompat.CATEGORY_REMINDER)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOnlyAlertOnce(true)
      .setAutoCancel(true)
      .setWhen(alarm.atMillis)
      .addAction(0, alarm.plan.oneTapLabel ?: "확인", oneTapPending)

    // 알림 본문을 누르면 앱을 엶 (런처 화면이 없으면 본문 누르기는 없음)
    context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { launch ->
      builder.setContentIntent(
        PendingIntent.getActivity(
          context,
          alarm.alarmId.hashCode() + 4,
          launch,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ),
      )
    }

    // POST_NOTIFICATIONS가 없으면 시스템이 조용히 무시함 (권한 안내는 앱 쪽)
    context.getSystemService(NotificationManager::class.java)
      .notify(alarm.alarmId, SILENT_NOTIFICATION_ID, builder.build())
  }

  fun cancelSilent(context: Context, alarmId: String) {
    context.getSystemService(NotificationManager::class.java).cancel(alarmId, SILENT_NOTIFICATION_ID)
  }

  // 이 모듈이 띄운 무음 알림을 전부 지움 (cancelAll용). 울린 무음 알람은 저장소에서 지워지므로 알람 목록이 아니라 시스템에 떠 있는 알림에서 찾음
  fun cancelAllSilent(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java)
    runCatching {
      manager.activeNotifications
        .filter { it.id == SILENT_NOTIFICATION_ID }
        .forEach { manager.cancel(it.tag, it.id) }
    }
  }
}
