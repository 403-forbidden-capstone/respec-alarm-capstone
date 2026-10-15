package expo.modules.alarmcore

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// 재부팅 · 시간 변경 · 정확한 알람 권한 변경 뒤 폰에 걸린 예약을 다시 걸음
class AlarmBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    AlarmController.restoreAll(context, rebooted = intent.action == Intent.ACTION_BOOT_COMPLETED)
  }
}
