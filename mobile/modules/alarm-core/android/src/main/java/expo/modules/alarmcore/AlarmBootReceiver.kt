package expo.modules.alarmcore

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// 재부팅 · 시간 변경 · 정확한 알람 권한 변경 뒤 폰에 걸린 예약을 다시 걸음
//   알람 예약(restoreAll)과 함께, 해제 + 10분 기상 판정 예약도 저장해 둔 것에서 되살림(G7) — 사용 기록을 읽는 일이라 별도 스레드에서
class AlarmBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    AlarmController.restoreAll(context)
    val pending = goAsync()
    Thread {
      try {
        runCatching { WakeJudgeSchedule.restore(context.applicationContext) }
      } finally {
        pending.finish()
      }
    }.start()
  }
}
