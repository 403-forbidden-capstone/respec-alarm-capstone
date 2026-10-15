package expo.modules.alarmcore

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.widget.Toast

// 알림 버튼 처리: WAKE 알림의 "미루기", 소리 없는 알림의 원탭 버튼
// WAKE 알림의 "해제"는 앱을 열어야 해서(알림 버튼 → 리시버 → 화면은 12부터 막힘) AlarmActionActivity가 맡음
class AlarmActionReceiver : BroadcastReceiver() {
  companion object {
    const val ACTION_ONE_TAP = "expo.modules.alarmcore.ONE_TAP"
    const val EXTRA_ALARM_TYPE = "alarm_type"
    const val EXTRA_EVENT_TYPE = "event_type"
  }

  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action ?: return
    val id = intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID) ?: return

    when (action) {
      AlarmPlaybackService.ACTION_SNOOZE -> {
        // 미루기 예약을 먼저 함. 정확한 알람 권한이 없어 실패하면 소리를 끄지 않음 → 미루기가 조용히 사라지지 않게
        if (!AlarmController.snooze(context, id)) {
          Toast.makeText(context, "미루기를 예약하지 못함. 해제로 꺼 주세요.", Toast.LENGTH_LONG).show()
        }
      }
      ACTION_ONE_TAP -> {
        val alarmType = intent.getStringExtra(EXTRA_ALARM_TYPE) ?: return
        val eventType = intent.getStringExtra(EXTRA_EVENT_TYPE) ?: return
        AlarmController.acknowledge(context, id, alarmType, eventType)
      }
    }
  }
}
