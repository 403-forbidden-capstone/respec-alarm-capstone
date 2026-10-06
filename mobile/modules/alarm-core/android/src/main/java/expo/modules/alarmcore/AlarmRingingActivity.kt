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

class AlarmRingingActivity : Activity() {
  private var alarmId: String = "alarm"
  private var alarmTitle: String = "알람"

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    readAlarmDetails(intent)
    showOverLockScreen()
    renderAlarmControls()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    readAlarmDetails(intent)
    renderAlarmControls()
  }

  private fun readAlarmDetails(source: Intent?) {
    alarmId = source?.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID) ?: "alarm"
    alarmTitle = source?.getStringExtra(AlarmScheduler.EXTRA_ALARM_TITLE) ?: "알람"
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
      text = alarmTitle
      setTextColor(Color.WHITE)
      textSize = 34f
      gravity = Gravity.CENTER
      setPadding(0, dp(24), 0, dp(8))
    }
    root.addView(title, matchWidth())

    val instruction = TextView(this).apply {
      text = "알람이 울리고 있습니다"
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
      setOnClickListener { sendAlarmAction(AlarmPlaybackService.ACTION_DISMISS) }
    }
    root.addView(dismissButton, buttonLayoutParams())

    val snoozeButton = Button(this).apply {
      text = "10분 미루기"
      textSize = 18f
      setOnClickListener { sendAlarmAction(AlarmPlaybackService.ACTION_SNOOZE) }
    }
    val snoozeParams = buttonLayoutParams().apply { topMargin = dp(12) }
    root.addView(snoozeButton, snoozeParams)

    setContentView(root)
  }

  private fun sendAlarmAction(action: String) {
    sendBroadcast(Intent(this, AlarmActionReceiver::class.java).apply {
      this.action = action
      putExtra(AlarmScheduler.EXTRA_ALARM_ID, alarmId)
    })
    finish()
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
