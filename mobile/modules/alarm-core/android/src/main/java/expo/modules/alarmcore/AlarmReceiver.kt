package expo.modules.alarmcore

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// AlarmManager가 알람 시각(처음 울림 · 미루기 · 다시 울림 모두)에 부름
class AlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID) ?: return
    AlarmController.fire(context, id)
  }
}
