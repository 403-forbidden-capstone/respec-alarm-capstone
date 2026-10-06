package expo.modules.alarmcore

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class AlarmActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action ?: return
    val id = intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID) ?: return

    when (action) {
      AlarmPlaybackService.ACTION_DISMISS -> AlarmPlaybackService.stop(context)
      AlarmPlaybackService.ACTION_SNOOZE -> {
        val original = AlarmStorage.get(context, id)
        AlarmPlaybackService.stop(context)
        val snoozeId = "${id}__snooze"
        // 정확한 알람 권한이 없으면 예약이 실패함 → 앱이 죽지 않게 막음
        runCatching {
          AlarmScheduler.scheduleOneShot(
            context,
            snoozeId,
            original?.title ?: "알람",
            System.currentTimeMillis() + 10 * 60 * 1000L,
          )
        }
      }
    }
  }
}
