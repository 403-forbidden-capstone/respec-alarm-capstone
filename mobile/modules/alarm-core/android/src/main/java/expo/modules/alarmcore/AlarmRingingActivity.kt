package expo.modules.alarmcore

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.lang.ref.WeakReference

// 울림 길잡이 + 대체 화면 (#332). 풀스크린 인텐트 · 알림 본문이 이 화면을 열면 앱의 H07(/ring)을 잠금화면 위로 불러 주고,
//   앱이 ackRingScreen()으로 "H07 떴음"을 알리면 닫힘. 앱이 RING_APP_TIMEOUT_MS 안에 못 띄우면(콜드 스타트 실패 · 로그아웃 등)
//   아래의 네이티브 컨트롤(해제 · 미루기)을 그려 알람을 끌 수 있게 함. 해제 · 미루기는 알람 코어(AlarmController)가 처리하고,
//   이 화면에서 해제하면 앱을 기상 확인 화면으로 엶
class AlarmRingingActivity : Activity() {
  companion object {
    const val EXTRA_ALARM_TITLE = "alarm_title"

    // "늦어요" 경고색 — 앱 theme 토큰과 같은 값 (warn #C8553D = 칩 테두리, danger #B8452E = 경고 줄 · 늦는 칩 바탕, 흰 글자 5.3 : 1)
    private val WARN_COLOR = Color.rgb(200, 85, 61)
    private val DANGER_COLOR = Color.rgb(184, 69, 46)
    private val NAVY = Color.rgb(11, 26, 58)

    // 앱을 기다리는 동안의 바탕 — 앱 H07 기상 배경(theme ringWake #141414)과 같아 앱이 뜰 때 깜빡이지 않음
    private val WAIT_COLOR = Color.rgb(20, 20, 20)

    // 앱이 /ring을 띄우기를 기다리는 시간. 이 안에 ackRingScreen()이 없으면 네이티브 컨트롤을 그림 (콜드 스타트를 감안한 값)
    const val RING_APP_TIMEOUT_MS = 6000L
    private val CHIP_COLOR = Color.rgb(36, 56, 98)

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

    // 앱이 H07을 띄웠다고 알림 (JS ackRingScreen) — 길잡이 화면이 떠 있으면 닫음. 어느 스레드에서 불러도 됨
    fun onAppShowedRing() {
      val activity = showing?.get() ?: return
      activity.runOnUiThread { activity.handleAppAck() }
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

  // 앱이 H07을 띄웠다고 알려 올 때까지 기다리다 못해 네이티브 컨트롤을 그렸는지
  private var fallbackShown = false
  private val handler = Handler(Looper.getMainLooper())
  private val fallbackRunnable = Runnable { showFallback() }

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
    waitForApp()
  }

  override fun onDestroy() {
    handler.removeCallbacks(fallbackRunnable)
    if (showing?.get() === this) showing = null
    super.onDestroy()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    readAlarmDetails(intent)
    // 이미 네이티브 컨트롤을 그렸으면 새 알람으로 다시 그림, 아직 기다리는 중이면 앱을 다시 불러 기다림
    if (fallbackShown) renderAlarmControls() else waitForApp()
  }

  // 앱에 H07을 열라고 하고, 단색 화면으로 기다림. 시간 안에 앱 응답이 없으면 showFallback
  private fun waitForApp() {
    fallbackShown = false
    handler.removeCallbacks(fallbackRunnable)
    scrollView = null
    setContentView(View(this).apply { setBackgroundColor(WAIT_COLOR) })
    val ringId = AlarmPlaybackService.ringingAlarmId ?: alarmId
    // 앱 액티비티가 새로 만들어지며 이 인텐트를 못 받아도 울림 화면으로 열리게 적어 둠 (RingOverLock.onActivityCreated)
    RingOverLock.pendingRingId = ringId
    val opened = runCatching {
      startActivity(
        Intent(Intent.ACTION_VIEW, RingOverLock.ringLink(ringId)).apply {
          setPackage(packageName)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        },
      )
    }.isSuccess
    // 앱을 아예 못 열면 기다리지 않고 바로 네이티브 컨트롤
    if (opened) handler.postDelayed(fallbackRunnable, RING_APP_TIMEOUT_MS) else showFallback()
  }

  // 앱이 H07을 띄움 — 이 화면은 할 일이 끝남. 알람은 앱이 해제 · 미루기하면 서비스가 멈춰 끝남
  private fun handleAppAck() {
    handler.removeCallbacks(fallbackRunnable)
    RingOverLock.pendingRingId = null
    finish()
  }

  // 대체 화면: 앱이 못 떴으니 여기서 해제 · 미루기. 앱이 다른 화면을 앞에 올렸을 수 있어 이 화면을 앞으로 가져옴
  private fun showFallback() {
    if (isFinishing) return
    fallbackShown = true
    renderAlarmControls()
    runCatching {
      startActivity(
        Intent(this, AlarmRingingActivity::class.java).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        },
      )
    }
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
    if (fallbackShown) renderAlarmControls()
  }

  private fun readAlarmDetails(source: Intent?) {
    // 인자 없이 앞으로 가져온 경우(showFallback)를 위해 없으면 지금 울리는 알람
    alarmId = source?.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID) ?: AlarmPlaybackService.ringingAlarmId ?: "alarm"
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
    // 늦어요 표시 — 막지 않고 보여 주기만 함. 고른 분이 늦는지 · 가장 짧은 분(5분)도 늦는지
    val selectedLateMinutes = if (canSnooze) SnoozeRules.lateMinutes(now, selected, departAt) else 0
    val wakeNow = canSnooze && departAt != null && SnoozeRules.isLate(now, options.first(), departAt)

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

    // 5분만 미뤄도 늦으면 큰 알람 내용 위에 경고 띠
    if (wakeNow && departAt != null) {
      val banner = TextView(this).apply {
        text = SnoozeRules.wakeNowBanner(departAt)
        setTextColor(Color.WHITE)
        setTypeface(typeface, Typeface.BOLD)
        textSize = 17f
        gravity = Gravity.CENTER
        setPadding(dp(14), dp(10), dp(14), dp(10))
        background = box(DANGER_COLOR)
      }
      root.addView(banner, matchWidth().apply { topMargin = dp(16) })
    }

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

    // 미루기 시간 3개 (5 · 10 · 15분). 미룬 시각이 출발 시각을 넘는 칩은 경고색 + 칩 안에 "늦어요"
    val optionRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
    options.forEachIndexed { index, minutes ->
      val isSelected = minutes == selected
      val late = canSnooze && SnoozeRules.isLate(now, minutes, departAt)
      val chip = Button(this).apply {
        text = if (late) "${minutes}분\n${SnoozeRules.LATE_CHIP}" else "${minutes}분"
        textSize = if (late) 16f else 18f
        isAllCaps = false
        if (late) setTypeface(typeface, Typeface.BOLD)
        // 늦는 칩: 안 고르면 경고 바탕 + 흰 글자, 고르면 흰 바탕 + 경고 글자 + 굵은 경고 테두리. 안 늦는 칩은 전과 같음
        setTextColor(if (isSelected) (if (late) DANGER_COLOR else NAVY) else Color.WHITE)
        background = when {
          late && isSelected -> box(Color.WHITE, WARN_COLOR, 3)
          late -> box(DANGER_COLOR)
          isSelected -> box(Color.WHITE)
          else -> box(CHIP_COLOR)
        }
        isEnabled = canSnooze
        alpha = if (canSnooze) 1f else 0.35f
        setOnClickListener {
          selectedMinutes = minutes
          renderAlarmControls()
        }
      }
      val params = LinearLayout.LayoutParams(0, dp(64), 1f).apply {
        if (index > 0) marginStart = dp(8)
      }
      optionRow.addView(chip, params)
    }
    root.addView(optionRow, matchWidth())

    // 고른 분이 늦으면 미루기 버튼 바로 위에 굵은 경고 한 줄 ("15분 미루면 9:00 출발보다 5분 늦어요")
    if (selectedLateMinutes > 0 && departAt != null) {
      val lateLine = TextView(this).apply {
        text = SnoozeRules.lateLine(selected, departAt, selectedLateMinutes)
        setTextColor(Color.WHITE)
        setTypeface(typeface, Typeface.BOLD)
        textSize = 16f
        gravity = Gravity.CENTER
        setPadding(dp(12), dp(10), dp(12), dp(10))
        background = box(DANGER_COLOR)
      }
      root.addView(lateLine, matchWidth().apply { topMargin = dp(12) })
    }

    val snoozeButton = Button(this).apply {
      text = SnoozeRules.buttonLabel(selected, selectedLateMinutes > 0)
      textSize = 18f
      isAllCaps = false
      // 늦는 분을 골랐으면 경고 테두리 (눌림 — 막지는 않음)
      if (selectedLateMinutes > 0) {
        setTextColor(Color.WHITE)
        background = box(CHIP_COLOR, WARN_COLOR, 3)
      }
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

  // 둥근 사각 바탕 (strokeDp > 0이면 테두리)
  private fun box(fill: Int, stroke: Int = Color.TRANSPARENT, strokeDp: Int = 0): GradientDrawable =
    GradientDrawable().apply {
      setColor(fill)
      cornerRadius = dp(8).toFloat()
      if (strokeDp > 0) setStroke(dp(strokeDp), stroke)
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
