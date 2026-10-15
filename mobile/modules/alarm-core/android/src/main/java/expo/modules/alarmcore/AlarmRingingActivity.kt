package expo.modules.alarmcore

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import java.lang.ref.WeakReference

// 잠금화면 위에 뜨는 WAKE 알람 화면. 해제 · 미루기는 알람 코어(AlarmController)가 처리하고, 해제하면 앱을 기상 확인 화면으로 엶
class AlarmRingingActivity : Activity() {
  companion object {
    const val EXTRA_ALARM_TITLE = "alarm_title"

    private var showing: WeakReference<AlarmRingingActivity>? = null

    // 소리가 멈추면(해제 · 미루기 · 자동 정지 · 취소) 서비스가 불러서 알람 화면을 닫음
    fun closeIfShowing() {
      showing?.get()?.finish()
      showing = null
    }
  }

  private var alarmId: String = "alarm"
  private var alarm: StoredAlarm? = null
  private var fallbackTitle: String = "알람"

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // 이미 멈춘 뒤에 늦게 열리면 바로 닫음
    if (AlarmPlaybackService.ringingAlarmId == null) {
      finish()
      return
    }
    showing = WeakReference(this)
    readAlarmDetails(intent)
    showOverLockScreen()
    renderAlarmControls()
  }

  override fun onDestroy() {
    if (showing?.get() === this) showing = null
    super.onDestroy()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    readAlarmDetails(intent)
    renderAlarmControls()
  }

  private fun readAlarmDetails(source: Intent?) {
    alarmId = source?.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID) ?: "alarm"
    fallbackTitle = source?.getStringExtra(EXTRA_ALARM_TITLE) ?: "알람"
    alarm = AlarmStorage.get(this, alarmId)
  }

  private fun showOverLockScreen() {
    window.addFlags(
      WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    }
  }

  private fun renderAlarmControls() {
    val current = alarm
    val snoozeMinutes = (((current?.plan?.snoozeMillis ?: 0L).takeIf { it > 0 } ?: (10 * 60 * 1000L)) / 60_000L).toInt()

    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setPadding(dp(28), dp(36), dp(28), dp(36))
      setBackgroundColor(Color.rgb(11, 26, 58))
    }

    val heading = TextView(this).apply {
      text = "기상 알람"
      setTextColor(Color.WHITE)
      textSize = 20f
      gravity = Gravity.CENTER
    }
    root.addView(heading, matchWidth())

    val title = TextView(this).apply {
      text = current?.title ?: fallbackTitle
      setTextColor(Color.WHITE)
      textSize = 34f
      gravity = Gravity.CENTER
      setPadding(0, dp(24), 0, dp(8))
    }
    root.addView(title, matchWidth())

    val instruction = TextView(this).apply {
      text = current?.subtitle ?: current?.plan?.heading?.takeIf { it.isNotEmpty() } ?: "알람이 울리고 있습니다"
      setTextColor(Color.LTGRAY)
      textSize = 18f
      gravity = Gravity.CENTER
      setPadding(0, 0, 0, dp(36))
    }
    root.addView(instruction, matchWidth())

    val dismissButton = Button(this).apply {
      text = "해제"
      textSize = 20f
      setTextColor(Color.WHITE)
      setBackgroundColor(Color.rgb(210, 45, 55))
      setOnClickListener { dismissAlarm() }
    }
    root.addView(dismissButton, buttonLayoutParams())

    val snoozeButton = Button(this).apply {
      text = "${snoozeMinutes}분 미루기"
      textSize = 18f
      setOnClickListener { snoozeAlarm() }
    }
    val snoozeParams = buttonLayoutParams().apply { topMargin = dp(12) }
    root.addView(snoozeButton, snoozeParams)

    setContentView(root)
  }

  // 화면은 소리가 멈출 때 서비스가 닫음 (미루기 예약이 실패해 계속 울리면 화면도 남아 해제할 수 있음)
  private fun dismissAlarm() {
    AlarmController.dismiss(this, alarmId, openApp = true)
  }

  private fun snoozeAlarm() {
    if (!AlarmController.snooze(this, alarmId)) {
      Toast.makeText(this, "미루기를 예약하지 못함. 해제로 꺼 주세요.", Toast.LENGTH_LONG).show()
    }
  }

  private fun matchWidth() = LinearLayout.LayoutParams(
    LinearLayout.LayoutParams.MATCH_PARENT,
    LinearLayout.LayoutParams.WRAP_CONTENT,
  )

  private fun buttonLayoutParams() = LinearLayout.LayoutParams(
    LinearLayout.LayoutParams.MATCH_PARENT,
    dp(64),
  )

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
