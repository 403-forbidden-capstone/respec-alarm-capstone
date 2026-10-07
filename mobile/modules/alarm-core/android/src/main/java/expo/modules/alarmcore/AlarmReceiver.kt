package expo.modules.alarmcore

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class AlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID) ?: return
    val alarm = AlarmStorage.get(context, id) ?: return

    if (alarm.repeat == "DAILY") {
      runCatching { AlarmScheduler.scheduleStored(context, alarm) }
    } else {
      AlarmStorage.remove(context, id)
    }

    AlarmPlaybackService.start(context, id, alarm.title)
  }
}
