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
import androidx.core.app.NotificationCompat

class AlarmPlaybackService : Service() {
  companion object {
    const val ACTION_DISMISS = "expo.modules.alarmcore.DISMISS"
    const val ACTION_SNOOZE = "expo.modules.alarmcore.SNOOZE"

    private const val CHANNEL_ID = "wake_alarm_native_v1"
    private const val NOTIFICATION_ID = 4101
    private const val EXTRA_ID = "alarm_id"
    private const val EXTRA_TITLE = "alarm_title"

    // 아무도 안 끄면 5분 뒤 멈춤. 강도별 다시 울림(#29 · #33)이 생기면 그 로직으로 바꿈
    private const val AUTO_STOP_MILLIS = 5 * 60 * 1000L

    // 웨이크락은 자동 정지보다 1분 길게 잡음 (보통은 그 전에 onDestroy에서 풀림)
    private const val WAKE_LOCK_TIMEOUT_MILLIS = AUTO_STOP_MILLIS + 60 * 1000L

    // 지금 울리는 알람 id. 안 울리면 null
    @Volatile
    var ringingAlarmId: String? = null

    fun start(context: Context, id: String, title: String) {
      val intent = Intent(context, AlarmPlaybackService::class.java).apply {
        putExtra(EXTRA_ID, id)
        putExtra(EXTRA_TITLE, title)
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
  private val autoStop = Runnable { stopSelf() }

  private var mediaPlayer: MediaPlayer? = null
  private var audioManager: AudioManager? = null
  private var audioFocusRequest: AudioFocusRequest? = null
  private var previousAlarmVolume: Int? = null
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val id = intent?.getStringExtra(EXTRA_ID) ?: "alarm"
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "알람"
    ringingAlarmId = id
    startForegroundCompat(buildNotification(id, title))
    holdWakeLock()
    if (mediaPlayer == null && !startPlayback()) {
      stopSelf()
      return START_NOT_STICKY
    }
    // 새 알람이 오면 자동 정지 시간을 다시 잼
    handler.removeCallbacks(autoStop)
    handler.postDelayed(autoStop, AUTO_STOP_MILLIS)
    return START_NOT_STICKY
  }

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
      vibrationPattern = longArrayOf(700, 300, 700, 300, 700, 900)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(id: String, title: String): Notification {
    val fullScreenActivityIntent = Intent(this, AlarmRingingActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      putExtra(AlarmScheduler.EXTRA_ALARM_ID, id)
      putExtra(AlarmScheduler.EXTRA_ALARM_TITLE, title)
    }
    val fullScreenIntent = PendingIntent.getActivity(
      this,
      id.hashCode(),
      fullScreenActivityIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val dismissIntent = Intent(this, AlarmActionReceiver::class.java).apply {
      action = ACTION_DISMISS
      putExtra(AlarmScheduler.EXTRA_ALARM_ID, id)
    }
    val snoozeIntent = Intent(this, AlarmActionReceiver::class.java).apply {
      action = ACTION_SNOOZE
      putExtra(AlarmScheduler.EXTRA_ALARM_ID, id)
    }

    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
      .setContentTitle("알람: $title")
      .setContentText("기상 시간입니다")
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setContentIntent(fullScreenIntent)
      .setOngoing(true)
      .setAutoCancel(false)
      .setVibrate(longArrayOf(700, 300, 700, 300, 700, 900))
      .addAction(
        0,
        "10분 미루기",
        PendingIntent.getBroadcast(
          this,
          id.hashCode() + 1,
          snoozeIntent,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ),
      )
      .addAction(
        0,
        "해제",
        PendingIntent.getBroadcast(
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
  private fun startPlayback(): Boolean {
    audioManager = getSystemService(AudioManager::class.java)
    val audioAttributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ALARM)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()

    val started = runCatching {
      requestAudioFocus(audioAttributes)
      forceAlarmVolume()

      // 우리 알람음이 안 되면 폰 기본 알람음으로 (무음으로 끝나지 않게)
      val player = alarmSounds().firstNotNullOfOrNull { preparePlayer(it, audioAttributes) }
        ?: throw IllegalStateException("알람음을 재생할 수 없습니다.")
      mediaPlayer = player
      player.setVolume(1f, 1f)
      player.start()
    }.isSuccess

    if (!started) releasePlayback()
    return started
  }

  // 알람음은 이 모듈 res/raw에 있음. 빌드 때 앱 리소스로 합쳐지므로 앱 패키지 이름으로 찾음
  private fun alarmSounds(): List<Uri> = listOfNotNull(
    Uri.parse("android.resource://$packageName/${R.raw.alarm_siren}"),
    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
  )

  // 재생 준비까지 끝낸 플레이어. 실패하면 null
  private fun preparePlayer(uri: Uri, attributes: AudioAttributes): MediaPlayer? {
    val player = MediaPlayer()
    return runCatching {
      player.setAudioAttributes(attributes)
      player.setDataSource(this, uri)
      player.isLooping = true
      // 재생 중에 오류가 나도 멈추고 볼륨을 되돌림
      player.setOnErrorListener { _, _, _ ->
        stopSelf()
        true
      }
      player.prepare()
      player
    }.onFailure { player.release() }.getOrNull()
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
      @Suppress("DEPRECATION")
      manager.requestAudioFocus(
        { },
        AudioManager.STREAM_ALARM,
        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
      )
    }
  }

  private fun forceAlarmVolume() {
    val manager = audioManager ?: return
    previousAlarmVolume = manager.getStreamVolume(AudioManager.STREAM_ALARM)
    val maximum = manager.getStreamMaxVolume(AudioManager.STREAM_ALARM)
    if (maximum > 0) manager.setStreamVolume(AudioManager.STREAM_ALARM, maximum, 0)
  }

  // 새 알람마다 다시 잡아서 시간 제한을 늘림
  private fun holdWakeLock() {
    val lock = wakeLock ?: getSystemService(PowerManager::class.java)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:alarm")
      .apply { setReferenceCounted(false) }
    wakeLock = lock
    lock.acquire(WAKE_LOCK_TIMEOUT_MILLIS)
  }

  // 해제 · 미루기 · 자동 정지 · 실패 모두 여기서 원래대로 되돌림 (여러 번 불러도 됨)
  private fun releasePlayback() {
    handler.removeCallbacks(autoStop)

    mediaPlayer?.runCatching {
      if (isPlaying) stop()
      release()
    }
    mediaPlayer = null

    audioManager?.let { manager ->
      audioFocusRequest?.let { request -> runCatching { manager.abandonAudioFocusRequest(request) } }
      previousAlarmVolume?.let { volume ->
        runCatching { manager.setStreamVolume(AudioManager.STREAM_ALARM, volume, 0) }
      }
    }
    audioFocusRequest = null
    previousAlarmVolume = null

    wakeLock?.runCatching { if (isHeld) release() }
    wakeLock = null
  }

  override fun onDestroy() {
    releasePlayback()
    ringingAlarmId = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    // 어떻게 멈췄든 떠 있는 알람 화면도 닫음
    AlarmRingingActivity.closeIfShowing()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
