package expo.modules.alarmcore

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import androidx.core.app.NotificationCompat

// WAKE 알람 포그라운드 서비스: 배경음·진동·반복 AI 음성을 사용자가 해제·미루기 할 때까지 함께 유지. DEPARTURE는 기존 1회 알림+1회 브리핑 사용
// 볼륨 · 한 번 울리는 최대 시간 · 소리는 알람 저장소의 울림 계획(RingPlan)대로. 다시 울림은 AlarmController가 미리 걸어 둠
class AlarmPlaybackService : Service() {
  companion object {
    const val ACTION_DISMISS = "expo.modules.alarmcore.DISMISS"
    const val ACTION_SNOOZE = "expo.modules.alarmcore.SNOOZE"

    private const val CHANNEL_ID = "wake_alarm_native_v1"
    private const val NOTIFICATION_ID = 4101
    private const val EXTRA_ID = "alarm_id"

    // 울림 계획에 값이 없을 때만 쓰는 값 (공통 TS가 늘 넣어 보내므로 보통은 안 씀)
    private const val FALLBACK_RING_MILLIS = 3 * 60 * 1000L
    private const val FALLBACK_SNOOZE_MILLIS = 10 * 60 * 1000L

    // 웨이크락은 최대 울림 시간보다 1분 길게 잡음 (보통은 그 전에 onDestroy에서 풀림)
    private const val WAKE_LOCK_EXTRA_MILLIS = 60 * 1000L

    private const val TAG = "AlarmCore"

    // AI 음성을 읽는 동안 알람음 크기 (플레이어 안의 비율 — 폰 알람 볼륨은 계획대로 그대로)
    private const val VOICE_DUCK = 0.2f

    // 알림 채널 — 진동 없음(NONE)이면 알림이 뜰 때의 진동 한 번도 없애려고 진동이 꺼진 채널을 따로 씀 (채널은 만든 뒤 바꿀 수 없음)
    private const val CHANNEL_ID_NO_VIBRATION = "wake_alarm_native_quiet_v1"
    private val NOTIFICATION_VIBRATION = longArrayOf(700, 300, 700, 300, 700, 900)

    // 앱에 든 소리 (res/raw, mobile/scripts/make-alarm-sounds.mjs가 합성한 배경음 3개 + 기본 사이렌). 파일이 있는 키는 이 파일을 먼저 틀음 (Q7, D1 A)
    // 기본 키(default)와 모르는 키는 폰의 기본 알람음을 먼저 틀고, 우리 앱 파일은 그 다음 예비
    private val SOUND_RESOURCES = mapOf(
      AlarmSoundKeys.DEFAULT to R.raw.alarm_siren,
      AlarmSoundKeys.CALM to R.raw.theme_calm,
      AlarmSoundKeys.NORMAL to R.raw.theme_default,
      AlarmSoundKeys.URGENT to R.raw.theme_urgent,
    )

    // 지금 울리는 알람 id. 안 울리면 null
    @Volatile
    var ringingAlarmId: String? = null

    // 마지막으로 튼 알람음 주소 (개발 화면 표시용)
    @Volatile
    var lastSound: String? = null

    // 지금 읽는 AI 음성 단계 · 엔진(GEMINI/ANDROID) — 개발 화면이 시간 자동 전환(1 → 3 → 4)을 보여 주는 데만 씀
    @Volatile
    var voiceLevel: Int? = null

    @Volatile
    var voiceEngine: String? = null

    fun start(context: Context, id: String) {
      val intent = Intent(context, AlarmPlaybackService::class.java).apply {
        putExtra(EXTRA_ID, id)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, AlarmPlaybackService::class.java))
    }

    // 울리는 알람이 ids 중 하나일 때만 멈춤
    fun stopIfRinging(context: Context, ids: List<String>) {
      val ringing = ringingAlarmId ?: return
      if (ids.contains(ringing)) stop(context)
    }
  }

  private val handler = Handler(Looper.getMainLooper())
  private var currentVoiceLevel: Int? = null
  // 이번 울림에서 시작한 가장 높은 음성 단계 — 같은 울림 안에서는 이보다 높을 때만 바꿈(낮추지 않음 · 실패한 단계 재시작 안 함)
  private var peakVoiceLevel: Int? = null
  private var voiceGeneration = 0
  // 기상 알람이 울리는 동안 현재 시각을 계속 확인하여 5분(3단계)과 0분(4단계)에 음성을 전환.
  // 서버를 호출하지 않고 캐시된 규칙과 음성만 확인. 배경 알람음/진동은 중단하지 않음.
  private val checkWakeStage = object : Runnable {
    override fun run() {
      val id = ringingAlarmId ?: return
      val alarm = AlarmStorage.get(applicationContext, id) ?: return
      if (alarm.type != "WAKE" || !alarm.ringing) return
      val next = VoiceBriefing.speechFor(applicationContext, alarm, System.currentTimeMillis())
      if (next != null && SpeechUrgency.shouldSwitch(next.level, peakVoiceLevel)) {
        stopVoice()
        runCatching { startVoice(alarm, next) }.onFailure { Log.w(TAG, "알람 음성 단계 변경 실패 — 배경음/진동 유지", it) }
      }
      handler.postDelayed(this, 2_000L)
    }
  }

  // 지금 울림의 번호 (StoredAlarm.ringCount). 다음 울림이 시작됐는지 알아보는 데 씀
  private var ringToken: Int = 0

  // 한 번 울림이 최대 시간에 닿음. 그 사이 같은 알람의 다음 울림(다시 울림)이 이미 시작됐으면 멈추지 않음
  private val autoStop = Runnable {
    val id = ringingAlarmId
    val canStop = id == null || AlarmController.onRingTimeout(applicationContext, id, ringToken)
    if (canStop) stopSelf()
  }

  private val audioAttributes: AudioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_ALARM)
    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
    .build()

  // 아직 안 틀어 본 알람음 (기본 소리 키면 폰 기본 알람음 → 우리 알람음 → 폰 기본 벨소리 · 알림음 순). 재생 도중 오류가 나면 다음 것으로 넘어감
  private var remainingSounds: MutableList<Uri> = mutableListOf()

  private var mediaPlayer: MediaPlayer? = null
  // 음성 브리핑 (BriefingSpeaker: 1~3단계 Android TTS, 긴급 4단계는 미리 만든 Gemini 음성) — 해제 전까지 반복. 알람음은 계속 20%로 재생
  private var speaker: BriefingSpeaker? = null
  private var speaking = false
  // 알람음 크기 비율 — 늘 1. 개발 화면의 "진동만 · AI 음성만" 시험 알람만 0 (재생 경로 · 포커스 · 진동 · 음성은 그대로, VoiceTest)
  private var soundLevel = 1f
  private var vibrator: Vibrator? = null
  private var audioManager: AudioManager? = null
  private var audioFocusRequest: AudioFocusRequest? = null

  // 안드로이드 8 미만은 포커스를 요청한 리스너를 그대로 넘겨야 반납됨
  private var legacyFocusListener: AudioManager.OnAudioFocusChangeListener? = null
  private var previousAlarmVolume: Int? = null
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val id = intent?.getStringExtra(EXTRA_ID) ?: "alarm"
    val alarm = AlarmStorage.get(this, id)

    // 다른 알람이 울리던 중이었다면 그 울림은 끝난 것으로 처리 (그 알람의 다시 울림은 이미 걸려 있음)
    val previousId = ringingAlarmId
    if (previousId != null && previousId != id) {
      AlarmController.onRingTimeout(applicationContext, previousId, ringToken)
      releasePlayback() // 이전 알람의 배경음·진동·AI를 멈추고 새 알람으로 교체
    }
    ringingAlarmId = id
    ringToken = alarm?.ringCount ?: 0
    // 겹쳐 울려서 다른 알람으로 넘어왔으면 떠 있는 알람 화면도 이 알람으로 바꿈 (안 바꾸면 해제가 앞 알람 id를 가리킴)
    AlarmRingingActivity.showCurrentIfShowing()

    // startForegroundService로 시작했으면 알람 정보가 있든 없든 곧바로 startForeground를 불러야 함
    // 시스템이 막으면(12+ ForegroundServiceStartNotAllowedException · 14+ 타입 SecurityException) 앱이 죽지 않게 이번 울림은 끝난 것으로 처리
    val foregroundStarted = runCatching { startForegroundCompat(buildNotification(id, alarm)) }.isSuccess
    if (!foregroundStarted) {
      AlarmController.onRingTimeout(applicationContext, id, ringToken)
      stopSelf()
      return START_NOT_STICKY
    }
    if (alarm == null) {
      stopSelf()
      return START_NOT_STICKY
    }

    val ringMillis = ringMillisOf(alarm)
    val continuous = alarm.type == "WAKE"
    // 사용자가 해제·미루기 할 때까지 유지. 종료 시 onDestroy에서 wakeLock을 반드시 해제.
    holdWakeLock(if (continuous) 0L else ringMillis + WAKE_LOCK_EXTRA_MILLIS)
    if (mediaPlayer == null) {
      if (!startPlayback(alarm)) {
        AlarmController.onRingTimeout(applicationContext, id, ringToken)
        stopSelf()
        return START_NOT_STICKY
      }
    } else {
      // 이미 울리고 있다면 단계별 높인 볼륨을 유지하면서 같은 알람의 재울림 처리
      if (alarm.type == "WAKE") updateStageEffects(alarm, currentVoiceLevel ?: 1)
      else runCatching { setAlarmVolume(alarm.plan.volumePercent) }
    }
    // 기상·출발 알람은 자동 종료하지 않음. 다른 유형만 기존 최대 울림 시간을 적용.
    handler.removeCallbacks(autoStop)
    if (!continuous) handler.postDelayed(autoStop, ringMillis)
    handler.removeCallbacks(checkWakeStage)
    if (continuous) handler.postDelayed(checkWakeStage, 2_000L)
    return START_NOT_STICKY
  }

  private fun ringMillisOf(alarm: StoredAlarm): Long =
    if (alarm.plan.maxRingMillis > 0) alarm.plan.maxRingMillis else FALLBACK_RING_MILLIS

  private fun startForegroundCompat(notification: Notification) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java)
    val channel = NotificationChannel(
      CHANNEL_ID,
      "기상 알람",
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      description = "기상 알람 표시와 진동"
      setSound(null, null)
      enableVibration(true)
      vibrationPattern = NOTIFICATION_VIBRATION
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
    manager.createNotificationChannel(channel)
    // L6 안건후보: 진동 없음(NONE) 알림 채널 기본안 = 진동이 꺼진 채널을 하나 더 둠(설정 앱에 "기상 알람(진동 없음)"으로 보임). 알림 뜰 때 진동 한 번도 없애려는 것
    val quietChannel = NotificationChannel(
      CHANNEL_ID_NO_VIBRATION,
      "기상 알람 (진동 없음)",
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      description = "진동 없이 표시만 하는 기상 알람"
      setSound(null, null)
      enableVibration(false)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
    manager.createNotificationChannel(quietChannel)
  }

  private fun buildNotification(id: String, alarm: StoredAlarm?): Notification {
    val title = alarm?.title ?: "알람"
    val heading = alarm?.plan?.heading?.takeIf { it.isNotEmpty() } ?: "기상 시간입니다"
    // 미루기 규칙은 알람 화면과 같음 (D3 기본안 A): 한도에 닿으면 "미루기" 버튼을 빼고 안내, 아니면 기본 미루기 분 버튼 (늦으면 "늦어요" 표시)
    // 알람 화면에서 5 · 10 · 15분을 고르는 것과 달리 알림 버튼은 기본 미루기 시간 하나만 둠
    val snoozeMinutes = if (alarm != null) SnoozeRules.defaultMinutes(alarm.plan) else (FALLBACK_SNOOZE_MILLIS / 60_000L).toInt()
    val snoozeAllowed = alarm == null || SnoozeRules.canSnooze(alarm.snoozeCount, alarm.plan.snoozeLimit)
    val snoozeLate = alarm != null && snoozeAllowed && SnoozeRules.isLate(System.currentTimeMillis(), snoozeMinutes, alarm.departAt)
    val snoozeNote = when {
      alarm == null -> null
      !snoozeAllowed -> SnoozeRules.limitNotice(alarm.departAt)
      alarm.snoozeCount > 0 -> SnoozeRules.countLabel(alarm.snoozeCount, alarm.plan.snoozeLimit)
      else -> null
    }
    val text = listOfNotNull(heading, alarm?.subtitle, snoozeNote).joinToString(" · ")

    val fullScreenActivityIntent = Intent(this, AlarmRingingActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      putExtra(AlarmScheduler.EXTRA_ALARM_ID, id)
      putExtra(AlarmRingingActivity.EXTRA_ALARM_TITLE, title)
    }
    val fullScreenIntent = PendingIntent.getActivity(
      this,
      id.hashCode(),
      fullScreenActivityIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    // 해제는 앱을 열어야 해서 화면 없는 중계 화면으로, 미루기는 리시버로
    val dismissIntent = Intent(this, AlarmActionActivity::class.java).apply {
      action = ACTION_DISMISS
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      putExtra(AlarmScheduler.EXTRA_ALARM_ID, id)
    }
    val snoozeIntent = Intent(this, AlarmActionReceiver::class.java).apply {
      action = ACTION_SNOOZE
      putExtra(AlarmScheduler.EXTRA_ALARM_ID, id)
      putExtra(AlarmActionReceiver.EXTRA_SNOOZE_MINUTES, snoozeMinutes)
    }

    val vibrates = alarm == null || AlarmVibration.patternFor(alarm.vibration) != null
    val builder = NotificationCompat.Builder(this, if (vibrates) CHANNEL_ID else CHANNEL_ID_NO_VIBRATION)
      .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
      .setContentTitle("알람: $title")
      .setContentText(text)
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setContentIntent(fullScreenIntent)
      .setOngoing(true)
      .setAutoCancel(false)
      .apply {
        // 8 미만은 채널이 없어 알림이 직접 진동함. 진동 없음이면 안 건다
        if (vibrates) setVibrate(NOTIFICATION_VIBRATION)
        if (snoozeAllowed) {
          addAction(
            0,
            // 알림은 이미 올라온 뒤라 그때그때 못 바꿈 — 알림을 올릴 때 한 번 정한 "늦어요"가 그대로 남음 (분 수는 안 넣음)
            SnoozeRules.buttonLabel(snoozeMinutes, snoozeLate),
            PendingIntent.getBroadcast(
              this@AlarmPlaybackService,
              id.hashCode() + 1,
              snoozeIntent,
              PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ),
          )
        }
      }
      .addAction(
        0,
        "해제",
        PendingIntent.getActivity(
          this,
          id.hashCode() + 2,
          dismissIntent,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ),
      )

    builder.setFullScreenIntent(fullScreenIntent, true)
    return builder.build()
  }

  // 실패하면 바꾼 볼륨 · 포커스 · 웨이크락을 바로 되돌리고 false
  private fun startPlayback(alarm: StoredAlarm): Boolean {
    audioManager = getSystemService(AudioManager::class.java)
    remainingSounds = alarmSounds(alarm.soundKey).toMutableList()
    soundLevel = if (runCatching { VoiceBriefing.testOptions(this, alarm.alarmId).sound }.getOrDefault(true)) 1f else 0f

    // 오디오 포커스나 볼륨 조정이 실패해도(방해 금지 · 제조사 제한 등) 소리는 내야 함 — 소리를 못 트는 것만 실패로 침
    runCatching { requestAudioFocus(audioAttributes) }
    runCatching { setAlarmVolume(alarm.plan.volumePercent) }
    val started = runCatching {
      // 앞의 알람음이 안 되면 다음 것으로 (무음으로 끝나지 않게)
      if (!playNextSound()) throw IllegalStateException("알람음을 재생할 수 없습니다.")
    }.isSuccess

    if (!started) {
      releasePlayback()
      return false
    }
    // 소리가 나기 시작한 뒤에 진동 시작. 진동을 못 켜도(진동 모터 없음 · 제조사 제한) 소리는 계속
    // 진동 없음(NONE)이면 건너뜀 — 볼륨은 진동과 상관없이 계획이 정한 값 그대로
    AlarmVibration.patternFor(alarm.vibration)?.let { pattern -> runCatching { startVibration(pattern) } }
    // 미리 받아 둔 AI 음성 브리핑을 알람음과 한 흐름으로 — 없거나 못 틀면 알람음 · 진동만 (알람은 멈추지 않음)
    runCatching { startVoice(alarm) }.onFailure { Log.w(TAG, "AI 음성을 못 틀어 알람음만", it) }
    return true
  }

  // 한 번 고른 문장만 반복하지 않고, 체크 루프가 새 시각의 stage를 찾아 음성을 교체함.
  private fun startVoice(alarm: StoredAlarm, prepared: VoiceBriefing.Speech? = VoiceBriefing.speechFor(this, alarm, System.currentTimeMillis())) {
    val speech = prepared ?: return
    currentVoiceLevel = speech.level
    peakVoiceLevel = maxOf(peakVoiceLevel ?: 0, speech.level)
    voiceLevel = speech.level
    voiceEngine = if (speech.wav != null) "GEMINI" else "ANDROID"
    if (alarm.type == "WAKE") updateStageEffects(alarm, speech.level)
    val generation = ++voiceGeneration
    speaker = BriefingSpeaker(
      this,
      onStart = {
        if (generation == voiceGeneration) {
          speaking = true
          mediaPlayer?.let { runCatching { it.setVolume(VOICE_DUCK * soundLevel, VOICE_DUCK * soundLevel) } }
        }
      },
      onDone = {
        if (generation == voiceGeneration) {
          // 한국어 오프라인 TTS가 없거나 음성 파일이 깨짐 — 같은 단계는 다시 시작 안 함(peakVoiceLevel), 더 높은 단계가 되면 다시 시도
          stopVoice()
        }
      },
    ).also { it.speak(speech, repeat = BriefingRules.repeatsBriefing(alarm.type)) }
  }

  // 배경음은 선택한 볼륨에서 단계에 따라 상승(최대 100%). 진동 없음은 존중,
  // 짧은 반복을 고른 경우에만 3단계부터 강한 연속 패턴으로 변경.
  private fun updateStageEffects(alarm: StoredAlarm, level: Int) {
    val boost = when (level) { 2 -> 10; 3 -> 20; 4 -> 30; else -> 0 }
    runCatching { setAlarmVolume((alarm.plan.volumePercent + boost).coerceAtMost(100)) }
    if (level >= 3 && alarm.vibration == AlarmVibration.SHORT_REPEAT) {
      AlarmVibration.patternFor(AlarmVibration.STRONG_CONTINUOUS)?.let { pattern ->
        runCatching {
          stopVibration()
          startVibration(pattern)
        }
      }
    }
  }

  private fun stopVoice() {
    voiceGeneration += 1
    speaker?.stop()
    speaker = null
    currentVoiceLevel = null
    speaking = false
    mediaPlayer?.let { runCatching { it.setVolume(soundLevel, soundLevel) } }
  }

  // 알람음 후보 (앞에서부터 시도). 기본 키(default) · 보통(theme_default) · 모르는 키는 폰 기본 알람음이 먼저, 우리 앱 파일이 그 다음 — 안드로이드 기본 알람처럼
  // 약(theme_calm) · 강(theme_urgent)만 우리 앱 파일이 먼저 (AlarmSoundKeys.playsOwnFileFirst). 마지막은 폰 기본 벨소리 · 알림음 (어느 것도 안 되면 그때서야 실패)
  private fun alarmSounds(soundKey: String): List<Uri> {
    val resource = SOUND_RESOURCES[soundKey]
    val ownFirst = AlarmSoundKeys.playsOwnFileFirst(soundKey, resource != null)
    // 앱 파일은 이 모듈 res/raw에 있음. 빌드 때 앱 리소스로 합쳐지므로 앱 패키지 이름으로 찾음
    val own = Uri.parse("android.resource://$packageName/${resource ?: R.raw.alarm_siren}")
    val phoneAlarm = phoneDefaultSounds(RingtoneManager.TYPE_ALARM)
    val ordered = if (ownFirst) listOf(own) + phoneAlarm else phoneAlarm + own
    return (
      ordered +
        phoneDefaultSounds(RingtoneManager.TYPE_RINGTONE) +
        phoneDefaultSounds(RingtoneManager.TYPE_NOTIFICATION)
      ).distinct()
  }

  // 사용자가 고른 폰의 기본 소리(없으면 안 넣음) 다음에 시스템 기본 주소. 앞의 것이 권한 등으로 안 열려도 뒤의 것으로 한 번 더 시도
  private fun phoneDefaultSounds(type: Int): List<Uri> = listOfNotNull(
    runCatching { RingtoneManager.getActualDefaultRingtoneUri(this, type) }.getOrNull(),
    runCatching { RingtoneManager.getDefaultUri(type) }.getOrNull(),
  )

  // 남은 알람음 중 처음으로 재생되는 것을 틂. 하나도 안 되면 false
  private fun playNextSound(): Boolean {
    while (remainingSounds.isNotEmpty()) {
      releasePlayer()
      val uri = remainingSounds.removeAt(0)
      val player = preparePlayer(uri)
      if (player == null) {
        Log.w(TAG, "알람음을 열 수 없어 다음 것으로: $uri")
        continue
      }
      mediaPlayer = player
      // 재생 도중 오류(오디오 서버 재시작 등)가 나면 다음 알람음으로, 더 없으면 멈추고 볼륨을 되돌림
      // 준비가 끝난 뒤에 붙여서 준비 실패 이벤트가 여기로 오지 않게 함. 지금 플레이어의 오류일 때만 반응
      player.setOnErrorListener { errored, _, _ ->
        if (errored === mediaPlayer && !playNextSound()) {
          ringingAlarmId?.let { AlarmController.onRingTimeout(applicationContext, it, ringToken) }
          stopSelf()
        }
        true
      }
      val playing = runCatching {
        val volume = (if (speaking) VOICE_DUCK else 1f) * soundLevel
        player.setVolume(volume, volume)
        player.start()
      }.isSuccess
      if (playing) {
        Log.i(TAG, "알람음 재생: $uri")
        lastSound = if (soundLevel > 0f) uri.toString() else "$uri (시험: 소리 0)"
        return true
      }
    }
    releasePlayer()
    return false
  }

  // 울리는 동안 계속 진동 — 알람 용도로 걸어서 무음 · 방해 금지에서도 시계 앱처럼 울림. 알림 채널 진동(알림이 뜰 때 한 번)과는 별개
  private fun startVibration(pattern: LongArray) {
    val target = vibrator ?: obtainVibrator() ?: return
    if (!target.hasVibrator()) return
    vibrator = target
    when {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ->
        target.vibrate(
          VibrationEffect.createWaveform(pattern, 0),
          VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM),
        )
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O -> vibrateWithAudioAttributes(target, pattern)
      else -> vibrateLegacy(target, pattern)
    }
    Log.i(TAG, "진동 시작")
  }

  private fun obtainVibrator(): Vibrator? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      getSystemService(VibratorManager::class.java)?.defaultVibrator
    } else {
      getVibratorLegacy()
    }

  @Suppress("DEPRECATION")
  private fun getVibratorLegacy(): Vibrator? = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator

  // 8 ~ 12: 알람 용도 속성은 AudioAttributes로 넘김 (13부터는 이 방식이 폐지되어 VibrationAttributes로)
  @Suppress("DEPRECATION")
  private fun vibrateWithAudioAttributes(target: Vibrator, pattern: LongArray) {
    target.vibrate(VibrationEffect.createWaveform(pattern, 0), audioAttributes)
  }

  // 8 미만: 패턴 반복(0번부터)
  @Suppress("DEPRECATION")
  private fun vibrateLegacy(target: Vibrator, pattern: LongArray) {
    target.vibrate(pattern, 0, audioAttributes)
  }

  private fun stopVibration() {
    vibrator?.let { target -> runCatching { target.cancel() } }
    vibrator = null
  }

  // 재생 준비까지 끝낸 플레이어. 실패하면 null
  private fun preparePlayer(uri: Uri): MediaPlayer? {
    val player = MediaPlayer()
    return runCatching {
      player.setAudioAttributes(audioAttributes)
      player.setDataSource(this, uri)
      player.isLooping = true
      player.prepare()
      player
    }.onFailure { player.release() }.getOrNull()
  }

  private fun releasePlayer() {
    mediaPlayer?.let { player ->
      runCatching { if (player.isPlaying) player.stop() }
      runCatching { player.release() }
    }
    mediaPlayer = null
  }

  private fun requestAudioFocus(attributes: AudioAttributes) {
    val manager = audioManager ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      audioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(attributes)
        .setOnAudioFocusChangeListener { _ -> }
        .build()
      manager.requestAudioFocus(audioFocusRequest!!)
    } else {
      val listener = AudioManager.OnAudioFocusChangeListener { _ -> }
      legacyFocusListener = listener
      requestLegacyAudioFocus(manager, listener)
    }
  }

  @Suppress("DEPRECATION")
  private fun requestLegacyAudioFocus(manager: AudioManager, listener: AudioManager.OnAudioFocusChangeListener) {
    manager.requestAudioFocus(listener, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
  }

  @Suppress("DEPRECATION")
  private fun abandonLegacyAudioFocus(manager: AudioManager, listener: AudioManager.OnAudioFocusChangeListener) {
    manager.abandonAudioFocus(listener)
  }

  // 알람 볼륨 스트림을 최대치의 percent%로 맞춤 (울림 계획의 volumePercent). 처음 바꿀 때 원래 볼륨을 기억해 끝나면 되돌림
  private fun setAlarmVolume(percent: Int) {
    val manager = audioManager ?: return
    if (previousAlarmVolume == null) previousAlarmVolume = manager.getStreamVolume(AudioManager.STREAM_ALARM)
    val maximum = manager.getStreamMaxVolume(AudioManager.STREAM_ALARM)
    if (maximum <= 0) return
    // 소리가 안 나는 단계(0)는 피함
    val target = Math.round(maximum * percent.coerceIn(1, 100) / 100.0).toInt().coerceIn(1, maximum)
    manager.setStreamVolume(AudioManager.STREAM_ALARM, target, 0)
  }

  // 새 울림마다 다시 잡아서 시간 제한을 늘림
  private fun holdWakeLock(timeoutMillis: Long) {
    val lock = wakeLock ?: getSystemService(PowerManager::class.java)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:alarm")
      .apply { setReferenceCounted(false) }
    wakeLock = lock
    if (timeoutMillis > 0L) lock.acquire(timeoutMillis) else lock.acquire()
  }

  // 해제 · 미루기 · 자동 정지 · 실패 모두 여기서 원래대로 되돌림 (여러 번 불러도 됨)
  private fun releasePlayback() {
    handler.removeCallbacks(autoStop)
    handler.removeCallbacks(checkWakeStage)
    peakVoiceLevel = null
    remainingSounds.clear()
    stopVoice()
    releasePlayer()
    stopVibration()

    audioManager?.let { manager ->
      audioFocusRequest?.let { request -> runCatching { manager.abandonAudioFocusRequest(request) } }
      legacyFocusListener?.let { listener -> runCatching { abandonLegacyAudioFocus(manager, listener) } }
      previousAlarmVolume?.let { volume ->
        runCatching { manager.setStreamVolume(AudioManager.STREAM_ALARM, volume, 0) }
      }
    }
    audioFocusRequest = null
    legacyFocusListener = null
    previousAlarmVolume = null

    wakeLock?.runCatching { if (isHeld) release() }
    wakeLock = null
  }

  override fun onDestroy() {
    releasePlayback()
    ringingAlarmId = null
    ringToken = 0
    stopForeground(STOP_FOREGROUND_REMOVE)
    // 어떻게 멈췄든 떠 있는 알람 화면도 닫음
    AlarmRingingActivity.closeIfShowing()
    // 앱 H07을 잠금화면 위에 올렸다면 곧 앱이 되돌림 — 안 되돌리고 끝났을 때를 위한 안전장치 (RingOverLock)
    RingOverLock.releaseIfStale()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
