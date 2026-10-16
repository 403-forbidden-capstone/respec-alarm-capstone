package expo.modules.alarmcore

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri

// AlarmManager에 거는 일만 함. 알람마다 걸리는 예약은 하나 — 처음 울림 · 미루기 · 다시 울림 모두 같은 PendingIntent에 시각만 바꿔 다시 걸음
object AlarmScheduler {
  const val EXTRA_ALARM_ID = "alarm_id"

  private fun requestCode(id: String): Int = id.hashCode() and 0x7fffffff

  private fun alarmIntent(context: Context, id: String): PendingIntent {
    // PendingIntent는 extras를 비교하지 않음 → data에 id를 넣어 알람마다 구분 (requestCode 해시가 겹쳐도 안 덮어씀)
    val intent = Intent(context, AlarmReceiver::class.java).apply {
      data = Uri.fromParts("alarmcore", id, null)
      putExtra(EXTRA_ALARM_ID, id)
    }
    return PendingIntent.getBroadcast(
      context,
      requestCode(id),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  // 12 이상만 권한 확인함 (13 이상은 USE_EXACT_ALARM이라 늘 true)
  fun canScheduleExactAlarms(context: Context): Boolean {
    if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.S) return true
    return context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()
  }

  // alarm.nextRingAt에 AlarmReceiver가 불리게 걸음. 같은 알람의 예전 예약은 이 호출로 바뀜
  // WAKE만 setAlarmClock(상태 표시줄에 알람 아이콘 · 시계 앱에 다음 알람으로 보임), 나머지는 setExactAndAllowWhileIdle (#79)
  // 걸지 못하면(정확한 알람 권한 없음 등) 던짐 — 이때 예전 예약은 그대로 남음
  fun schedule(context: Context, alarm: StoredAlarm) {
    if (!canScheduleExactAlarms(context)) {
      throw IllegalStateException("정확한 알람 권한이 허용되지 않았습니다.")
    }
    val alarmManager = context.getSystemService(AlarmManager::class.java)
    val operation = alarmIntent(context, alarm.alarmId)
    if (alarm.type == "WAKE") {
      // 상태 표시줄 · 시계 앱에서 다음 알람을 누르면 열 화면. 런처 화면이 없으면 알람 화면(안 울리면 바로 닫힘)
      val showIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        ?: Intent(context, AlarmRingingActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      val showOperation = PendingIntent.getActivity(
        context,
        requestCode("show_${alarm.alarmId}"),
        showIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      alarmManager.setAlarmClock(AlarmManager.AlarmClockInfo(alarm.nextRingAt, showOperation), operation)
    } else {
      alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, alarm.nextRingAt, operation)
    }
  }

  // 걸어 둔 예약을 지움 (없어도 됨)
  fun cancelPending(context: Context, id: String) {
    context.getSystemService(AlarmManager::class.java).cancel(alarmIntent(context, id))
  }
}
