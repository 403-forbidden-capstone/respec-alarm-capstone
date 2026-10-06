package expo.modules.alarmcore

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.widget.Toast

class AlarmActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action ?: return
    val id = intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID) ?: return

    when (action) {
      AlarmPlaybackService.ACTION_DISMISS -> AlarmPlaybackService.stop(context)
      AlarmPlaybackService.ACTION_SNOOZE -> {
        val original = AlarmStorage.get(context, id)
        // 미루기 예약을 먼저 함. 정확한 알람 권한이 없어 실패하면 소리를 끄지 않음 → 미루기가 조용히 사라지지 않게
        val snoozed = runCatching {
          AlarmScheduler.scheduleOneShot(
            context,
            AlarmScheduler.snoozeId(id),
            original?.title ?: "알람",
            System.currentTimeMillis() + 10 * 60 * 1000L,
          )
        }.isSuccess
        if (snoozed) {
          AlarmPlaybackService.stop(context)
        } else {
          Toast.makeText(context, "미루기를 예약하지 못함. 해제로 꺼 주세요.", Toast.LENGTH_LONG).show()
        }
      }
    }
  }
}
