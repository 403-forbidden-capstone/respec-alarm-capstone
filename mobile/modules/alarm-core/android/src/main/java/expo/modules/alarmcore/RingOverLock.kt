package expo.modules.alarmcore

import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import java.lang.ref.WeakReference

// 앱(MainActivity)의 H07(/ring)을 잠금화면 위에 띄우는 규칙 (#332)
// 앱 manifest에 showWhenLocked를 영구로 박으면 잠금 상태에서 다른 알림을 눌러도 앱이 잠금 위에 보이므로,
// "respecalarm://ring" 인텐트로 열렸을 때만 켜고 알람이 끝나면(JS releaseRingOverLock) 되돌림
object RingOverLock {
  private const val SCHEME = "respecalarm"
  private const val HOST = "ring"

  // 알람이 저절로 끝났는데(최대 시간 · 취소) 앱이 되돌리지 않았을 때 잠금화면 위 설정을 거두기까지 기다리는 시간
  private const val STALE_RELEASE_MS = 8000L

  private val handler = Handler(Looper.getMainLooper())

  // 지금 떠 있는 앱 액티비티, 그중 잠금화면 위 설정을 켜 둔 것
  private var current: WeakReference<Activity>? = null
  private var held: WeakReference<Activity>? = null

  /** 길잡이 화면이 앱을 여는 주소: respecalarm://ring?alarm=<알람 id> */
  fun ringLink(alarmId: String): Uri = Uri.parse("$SCHEME://$HOST?alarm=${Uri.encode(alarmId)}")

  fun isRingIntent(intent: Intent?): Boolean {
    val data = intent?.data ?: return false
    return intent.action == Intent.ACTION_VIEW && data.scheme == SCHEME && data.host == HOST
  }

  // --- 앱 액티비티 생명주기 (AlarmCorePackage의 listener가 부름, 전부 메인 스레드) ---

  fun onActivityCreated(activity: Activity) {
    current = WeakReference(activity)
    if (isRingIntent(activity.intent)) hold(activity)
  }

  fun onActivityNewIntent(intent: Intent?) {
    if (!isRingIntent(intent)) return
    current?.get()?.let { hold(it) }
  }

  // 사용자가 홈 · 최근 앱으로 나가면 잠금화면 위 설정은 거둠 (알람은 계속 울림 — 길잡이 화면이 다시 앞으로 올 수 있음)
  fun onActivityLeaveHint(activity: Activity) {
    if (held?.get() === activity) clearFlags(activity)
  }

  fun onActivityDestroyed(activity: Activity) {
    if (held?.get() === activity) held = null
    if (current?.get() === activity) current = null
  }

  private fun hold(activity: Activity) {
    handler.removeCallbacksAndMessages(null)
    held = WeakReference(activity)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      activity.setShowWhenLocked(true)
      activity.setTurnScreenOn(true)
    }
    activity.window.addFlags(
      WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
    )
  }

  private fun clearFlags(activity: Activity) {
    if (held?.get() === activity) held = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      activity.setShowWhenLocked(false)
      activity.setTurnScreenOn(false)
    }
    activity.window.clearFlags(
      WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
    )
  }

  /**
   * JS의 releaseRingOverLock — 알람이 끝나 잠금화면 위 설정을 되돌림. 어느 스레드에서 불러도 됨
   * dismissKeyguard = true(해제): 잠금 해제를 요청해 기상 확인(H08)이 이어서 보이게 함. 잠금이 풀리기 전에 설정을 거두면 화면이 잠금 뒤로 숨으므로 결과가 나온 뒤에 거둠
   * false(미루기): 설정만 거두고 앱을 뒤로 보냄 — 잠금화면으로 돌아가도 됨
   */
  fun release(dismissKeyguard: Boolean) {
    handler.removeCallbacksAndMessages(null)
    handler.post {
      val activity = held?.get() ?: return@post
      if (!dismissKeyguard) {
        clearFlags(activity)
        activity.moveTaskToBack(true)
        return@post
      }
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        clearFlags(activity)
        return@post
      }
      val finish = { clearFlags(activity) }
      val keyguard = activity.getSystemService(KeyguardManager::class.java)
      if (keyguard == null) {
        finish()
        return@post
      }
      keyguard.requestDismissKeyguard(
        activity,
        object : KeyguardManager.KeyguardDismissCallback() {
          override fun onDismissSucceeded() = finish()
          override fun onDismissCancelled() = finish()
          override fun onDismissError() = finish()
        },
      )
    }
  }

  // 소리 서비스가 멈췄을 때(AlarmPlaybackService.onDestroy) 부름. 해제 · 미루기는 앱이 곧 release를 부르니 잠깐 기다렸다가,
  // 그래도 설정이 남아 있으면(최대 시간으로 끝남 · 취소 · 앱이 못 부름) 잠금화면 위 설정만 거둠
  fun releaseIfStale() {
    handler.postDelayed({ held?.get()?.let { clearFlags(it) } }, STALE_RELEASE_MS)
  }
}
