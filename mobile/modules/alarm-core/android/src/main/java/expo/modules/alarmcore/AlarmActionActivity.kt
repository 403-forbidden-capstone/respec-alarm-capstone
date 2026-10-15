package expo.modules.alarmcore

import android.app.Activity
import android.os.Bundle

// 화면 없는 중계 화면: WAKE 알림의 "해제" 버튼이 여기로 옴
// 알림 버튼이 리시버를 거쳐 화면을 여는 것은 안드로이드 12부터 막혀서, 버튼이 이 화면을 바로 열고 여기서 해제 + 앱 열기를 함
class AlarmActionActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val id = intent?.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID)
    if (id != null) AlarmController.dismiss(this, id, openApp = true)
    finish()
  }
}
