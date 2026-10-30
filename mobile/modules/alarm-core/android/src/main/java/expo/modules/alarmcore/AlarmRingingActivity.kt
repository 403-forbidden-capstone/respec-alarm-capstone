package expo.modules.alarmcore

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
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

    // 알람 둘이 겹쳐 서비스가 다른 알람으로 넘어가면 불러서 화면이 지금 울리는 알람을 보이게 함
    fun showCurrentIfShowing() {
      showing?.get()?.showCurrentAlarm()
    }
  }

  private var alarmId: String = "alarm"
  private var alarm: StoredAlarm? = null
  private var fallbackTitle: String = "알람"

  // 고른 미루기 분 (칩). 알람이 바뀌면 비워서 기본(목록 첫 값)으로
  private var selectedMinutes: Int? = null

  // 지금 그려진 스크롤 칸 — 다시 그릴 때 스크롤 위치를 이어 가려고 들고 있음
  private var scrollView: ScrollView? = null

  // 미루기를 누른 뒤 서비스가 멈춰 화면이 닫히기까지 사이에 또 눌려 두 번 세어지지 않게. 예약이 실패하면 풀어 다시 누를 수 있음
  private var snoozing = false

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

  // 지금 울리는 알람이 화면이 든 알람과 다르면 그 알람으로 바꿔 다시 그림 (해제 · 미루기가 보이는 알람에 듣게)
  fun showCurrentAlarm() {
    val current = AlarmPlaybackService.ringingAlarmId ?: return
    if (current == alarmId) return
    alarmId = current
    fallbackTitle = "알람"
    alarm = AlarmStorage.get(this, current)
    selectedMinutes = null
    snoozing = false
    renderAlarmControls()
  }

  private fun readAlarmDetails(source: Intent?) {
    alarmId = source?.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID) ?: "alarm"
    fallbackTitle = source?.getStringExtra(EXTRA_ALARM_TITLE) ?: "알람"
    alarm = AlarmStorage.get(this, alarmId)
    selectedMinutes = null
    snoozing = false
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
    // 미루기 규칙 (D3 기본안 A): 5 · 10 · 15분 중 고르기, 알람 한 개당 한도까지. 목록 · 한도는 TS가 계획에 실어 보낸 값
    val options = current?.plan?.snoozeMinutesOptions?.takeIf { it.isNotEmpty() } ?: SnoozeRules.DEFAULT_OPTIONS
    val snoozeCount = current?.snoozeCount ?: 0
    val snoozeLimit = current?.plan?.snoozeLimit ?: 0
    val canSnooze = current != null && SnoozeRules.canSnooze(snoozeCount, snoozeLimit)
    val departAt = current?.departAt
    val now = System.currentTimeMillis()
    // L6 안건후보: 미루기 기본 선택 분 = 기본안은 목록의 첫 값(5분, 목업 H07). 알림의 "미루기" 버튼은 기본 10분(plan.snoozeMillis)
    val selected = selectedMinutes?.takeIf { it in options } ?: options.first()

    // 칩을 눌러 다시 그릴 때 작은 화면에서 스크롤이 맨 위로 돌아가지 않게 지금 위치를 기억함
    val savedScrollY = scrollView?.scrollY ?: 0

    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setPadding(dp(28), dp(36), dp(28), dp(12))
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

    // 미루기 N/한도회 — N = 이미 미룬 횟수
    val countLabel = TextView(this).apply {
      text = SnoozeRules.countLabel(snoozeCount, snoozeLimit)
      setTextColor(Color.LTGRAY)
      textSize = 16f
      gravity = Gravity.CENTER
      setPadding(0, dp(24), 0, dp(8))
    }
    root.addView(countLabel, matchWidth())

    // 한도에 닿으면 미루기 버튼을 끄고 (흐리게) 바로 준비하라는 안내
    if (!canSnooze) {
      val limitNotice = TextView(this).apply {
        text = SnoozeRules.limitNotice(departAt)
        setTextColor(Color.WHITE)
        textSize = 18f
        gravity = Gravity.CENTER
        setPadding(0, 0, 0, dp(8))
      }
      root.addView(limitNotice, matchWidth())
    }

    // 미루기 시간 3개 (5 · 10 · 15분). 미룬 시각이 출발 시각을 넘으면 그 버튼 아래에 "이만큼 미루면 늦어요"
    val optionRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
    options.forEachIndexed { index, minutes ->
      val isSelected = minutes == selected
      val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
      val chip = Button(this).apply {
        text = "${minutes}분"
        textSize = 18f
        setTextColor(if (isSelected) Color.rgb(11, 26, 58) else Color.WHITE)
        setBackgroundColor(if (isSelected) Color.WHITE else Color.rgb(36, 56, 98))
        isEnabled = canSnooze
        alpha = if (canSnooze) 1f else 0.35f
        setOnClickListener {
          selectedMinutes = minutes
          renderAlarmControls()
        }
      }
      column.addView(chip, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)))
      if (canSnooze && SnoozeRules.isLate(now, minutes, departAt)) {
        val lateLabel = TextView(this).apply {
          text = SnoozeRules.LATE_LABEL
          setTextColor(Color.rgb(255, 190, 92))
          textSize = 12f
          gravity = Gravity.CENTER
          setPadding(0, dp(4), 0, 0)
        }
        column.addView(lateLabel, matchWidth())
      }
      val params = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
        if (index > 0) marginStart = dp(8)
      }
      optionRow.addView(column, params)
    }
    root.addView(optionRow, matchWidth())

    val snoozeButton = Button(this).apply {
      text = "${selected}분 미루기"
      textSize = 18f
      isEnabled = canSnooze
      alpha = if (canSnooze) 1f else 0.35f
      setOnClickListener { snoozeAlarm(selected) }
    }
    val snoozeParams = buttonLayoutParams().apply { topMargin = dp(12) }
    root.addView(snoozeButton, snoozeParams)

    // 해제 버튼은 스크롤 밖 맨 아래에 고정 — 내용이 길어 작은 화면에서 스크롤돼도 늘 보이고 눌림
    val dismissButton = Button(this).apply {
      text = "해제"
      textSize = 20f
      setTextColor(Color.WHITE)
      setBackgroundColor(Color.rgb(210, 45, 55))
      setOnClickListener { dismissAlarm() }
    }
    val dismissBar = LinearLayout(this).apply {
      setPadding(dp(28), dp(8), dp(28), dp(24))
      addView(dismissButton, buttonLayoutParams())
    }

    // 내용이 길어 작은 화면에서 넘치면 스크롤됨
    val scroll = ScrollView(this).apply {
      isFillViewport = true
      addView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
    val screen = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(Color.rgb(11, 26, 58))
      addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
      addView(dismissBar, matchWidth())
    }
    scrollView = scroll
    setContentView(screen)
    if (savedScrollY > 0) scroll.post { scroll.scrollTo(0, savedScrollY) }
  }

  // 화면은 소리가 멈출 때 서비스가 닫음 (미루기 예약이 실패해 계속 울리면 화면도 남아 해제할 수 있음)
  private fun dismissAlarm() {
    AlarmController.dismiss(this, alarmId, openApp = true)
  }

  // minutes = 고른 미루기 분 → SNOOZED 기록의 snooze_minutes로 남음
  private fun snoozeAlarm(minutes: Int) {
    if (snoozing) return
    snoozing = true
    if (!AlarmController.snooze(this, alarmId, minutes)) {
      snoozing = false
      // 이미 미룬 직후(더 안 울림)에 들어온 두 번째 누름이면 알리지 않음 — 아직 울리는 중일 때만 진짜 실패
      if (AlarmController.isRinging(this, alarmId)) {
        Toast.makeText(this, "미루기를 예약하지 못함. 해제로 꺼 주세요.", Toast.LENGTH_LONG).show()
      }
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
