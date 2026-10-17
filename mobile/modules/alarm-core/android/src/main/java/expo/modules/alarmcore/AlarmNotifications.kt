package expo.modules.alarmcore

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat

// 일정 알림 — WAKE를 뺀 준비 시작 · 출발 · 도착 · 루틴. 보통 푸시처럼 알림음 · 진동 한 번 + 배너 (alarm-core.md 소리 줄, 10/18 지형님)
// 알림 한 줄에 원탭 버튼 하나("준비 시작" · "출발했어요" · "도착했어요" · "했어요"). 누르면 기록만 남기고 앱은 열지 않음
object AlarmNotifications {
  // 채널은 한 번 만들면 소리 · 진동 설정을 못 바꾸므로 설정이 바뀌면 새 id로 만들고 옛것은 지움
  private const val NOTICE_CHANNEL_ID = "alarm_notice_v1"
  private const val NOTICE_NOTIFICATION_ID = 4200

  // 소리 · 진동 없이 알리던 옛 채널. 새 채널을 만들 때 같이 지워서 폰의 알림 설정에 무음 채널이 안 남게 함
  private const val OLD_SILENT_CHANNEL_ID = "alarm_silent_v1"

  private fun ensureNoticeChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.deleteNotificationChannel(OLD_SILENT_CHANNEL_ID)
    val channel = NotificationChannel(
      NOTICE_CHANNEL_ID,
      "일정 알림",
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      description = "준비 시작 · 출발 · 도착 · 루틴을 알려 주는 알림 (알림음 · 진동 한 번)"
      // 폰의 기본 알림음 + 기본 진동 (보통 푸시와 같음)
      setSound(
        Settings.System.DEFAULT_NOTIFICATION_URI,
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_NOTIFICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build(),
      )
      enableVibration(true)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
    manager.createNotificationChannel(channel)
  }

  fun showNotice(context: Context, alarm: StoredAlarm) {
    ensureNoticeChannel(context)

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
    val builder = NotificationCompat.Builder(context, NOTICE_CHANNEL_ID)
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

    // 8 미만은 채널이 없어서 알림마다 기본 소리 · 진동을 켬 (8 이상은 위 채널 설정이 따로 적용됨)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      builder.setDefaults(NotificationCompat.DEFAULT_ALL)
    }

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
      .notify(alarm.alarmId, NOTICE_NOTIFICATION_ID, builder.build())
  }

  fun cancelNotice(context: Context, alarmId: String) {
    context.getSystemService(NotificationManager::class.java).cancel(alarmId, NOTICE_NOTIFICATION_ID)
  }

  // 이 모듈이 띄운 일정 알림을 전부 지움 (cancelAll용). 울린 알림형 알람은 저장소에서 지워지므로 알람 목록이 아니라 시스템에 떠 있는 알림에서 찾음
  fun cancelAllNotices(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java)
    runCatching {
      manager.activeNotifications
        .filter { it.id == NOTICE_NOTIFICATION_ID }
        .forEach { manager.cancel(it.tag, it.id) }
    }
  }
}
