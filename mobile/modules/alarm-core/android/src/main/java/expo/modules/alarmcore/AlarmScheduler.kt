package expo.modules.alarmcore

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import java.util.Calendar

object AlarmScheduler {
  const val EXTRA_ALARM_ID = "alarm_id"
  const val EXTRA_ALARM_TITLE = "alarm_title"

  private fun requestCode(id: String): Int = id.hashCode() and 0x7fffffff

  private fun alarmIntent(context: Context, id: String): PendingIntent {
    val intent = Intent(context, AlarmReceiver::class.java).apply {
      putExtra(EXTRA_ALARM_ID, id)
    }
    return PendingIntent.getBroadcast(
      context,
      requestCode(id),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  fun scheduleOneShot(context: Context, id: String, title: String, triggerAtMillis: Long) {
    AlarmStorage.saveOneShot(context, id, title, triggerAtMillis)
    runCatching { schedule(context, id, triggerAtMillis) }.onFailure {
      AlarmStorage.remove(context, id)
      throw it
    }
  }

  fun scheduleDaily(context: Context, id: String, title: String, hour: Int, minute: Int) {
    require(hour in 0..23) { "시간은 0에서 23 사이여야 합니다." }
    require(minute in 0..59) { "분은 0에서 59 사이여야 합니다." }
    val triggerAtMillis = nextDailyMillis(hour, minute)
    AlarmStorage.saveDaily(context, id, title, hour, minute, triggerAtMillis)
    runCatching { schedule(context, id, triggerAtMillis) }.onFailure {
      AlarmStorage.remove(context, id)
      throw it
    }
  }

  fun scheduleStored(context: Context, alarm: StoredAlarm) {
    val triggerAtMillis = if (alarm.repeat == "DAILY") {
      nextDailyMillis(alarm.hour, alarm.minute)
    } else {
      alarm.triggerAtMillis
    }
    if (triggerAtMillis <= System.currentTimeMillis()) {
      AlarmStorage.remove(context, alarm.id)
      return
    }
    AlarmStorage.updateTrigger(context, alarm.id, triggerAtMillis)
    schedule(context, alarm.id, triggerAtMillis)
  }

  // 12 이상만 권한 확인함 (13 이상은 USE_EXACT_ALARM이라 늘 true)
  fun canScheduleExactAlarms(context: Context): Boolean {
    if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.S) return true
    return context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()
  }

  private fun schedule(context: Context, id: String, triggerAtMillis: Long) {
    if (!canScheduleExactAlarms(context)) {
      throw IllegalStateException("정확한 알람 권한이 허용되지 않았습니다.")
    }
    val alarmManager = context.getSystemService(AlarmManager::class.java)
    val operation = alarmIntent(context, id)
    val showIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?: Intent(context, AlarmReceiver::class.java)
    val showOperation = PendingIntent.getActivity(
      context,
      requestCode("show_$id"),
      showIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    alarmManager.setAlarmClock(AlarmManager.AlarmClockInfo(triggerAtMillis, showOperation), operation)
  }

  fun cancel(context: Context, id: String) {
    val alarmManager = context.getSystemService(AlarmManager::class.java)
    alarmManager.cancel(alarmIntent(context, id))
    AlarmStorage.remove(context, id)
  }

  fun cancelAll(context: Context) {
    AlarmStorage.all(context).forEach { cancel(context, it.id) }
  }

  private fun nextDailyMillis(hour: Int, minute: Int): Long {
    val calendar = Calendar.getInstance().apply {
      set(Calendar.HOUR_OF_DAY, hour)
      set(Calendar.MINUTE, minute)
      set(Calendar.SECOND, 0)
      set(Calendar.MILLISECOND, 0)
      if (timeInMillis <= System.currentTimeMillis()) add(Calendar.DAY_OF_YEAR, 1)
    }
    return calendar.timeInMillis
  }
}
