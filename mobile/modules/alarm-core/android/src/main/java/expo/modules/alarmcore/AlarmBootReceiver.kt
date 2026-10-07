package expo.modules.alarmcore

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class AlarmBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    AlarmStorage.all(context).forEach { alarm ->
      runCatching { AlarmScheduler.scheduleStored(context, alarm) }
    }
  }
}
