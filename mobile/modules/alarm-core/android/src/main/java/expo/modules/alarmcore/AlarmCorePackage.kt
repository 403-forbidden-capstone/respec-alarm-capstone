package expo.modules.alarmcore

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

// 앱 액티비티의 생명주기를 들여다보는 자리 — respecalarm://ring으로 열렸을 때만 잠금화면 위로 올림 (RingOverLock)
// Expo 자동 연결은 이름이 Package로 끝나고 expo.modules.core.interfaces.Package를 쓰는 파일을 찾아 등록함
class AlarmCorePackage : Package {
  override fun createReactActivityLifecycleListeners(activityContext: Context?): List<ReactActivityLifecycleListener> =
    listOf(RingActivityListener())
}

class RingActivityListener : ReactActivityLifecycleListener {
  override fun onCreate(activity: Activity?, savedInstanceState: Bundle?) {
    if (activity != null) RingOverLock.onActivityCreated(activity)
  }

  override fun onNewIntent(intent: Intent?): Boolean {
    RingOverLock.onActivityNewIntent(intent)
    // 다른 listener(expo-linking 등)가 처리하게 둠
    return false
  }

  override fun onUserLeaveHint(activity: Activity?) {
    if (activity != null) RingOverLock.onActivityLeaveHint(activity)
  }

  override fun onDestroy(activity: Activity?) {
    if (activity != null) RingOverLock.onActivityDestroyed(activity)
  }
}
