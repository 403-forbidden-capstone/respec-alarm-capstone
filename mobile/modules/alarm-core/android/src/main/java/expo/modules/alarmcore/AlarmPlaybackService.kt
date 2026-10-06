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
import android.net.Uri
import android.os.Build
import android.os.IBinder
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
  }

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
    startForegroundCompat(buildNotification(id, title))
    if (mediaPlayer == null) startPlayback()
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

  private fun startPlayback() {
    audioManager = getSystemService(AudioManager::class.java)
    val audioAttributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ALARM)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()

    requestAudioFocus(audioAttributes)
    forceAlarmVolume()
    acquireWakeLock()

    // 알람음은 이 모듈 res/raw에 있음. 빌드 때 앱 리소스로 합쳐지므로 앱 패키지 이름으로 찾음
    val uri = Uri.parse("android.resource://$packageName/${R.raw.alarm_siren}")

    mediaPlayer = MediaPlayer().apply {
      setAudioAttributes(audioAttributes)
      setDataSource(this@AlarmPlaybackService, uri)
      isLooping = true
      prepare()
      setVolume(1f, 1f)
      start()
    }
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

  private fun acquireWakeLock() {
    val powerManager = getSystemService(PowerManager::class.java)
    wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:alarm").apply {
      acquire()
    }
  }

  override fun onDestroy() {
    mediaPlayer?.runCatching {
      if (isPlaying) stop()
      release()
    }
    mediaPlayer = null

    audioManager?.let { manager ->
      audioFocusRequest?.let { manager.abandonAudioFocusRequest(it) }
      previousAlarmVolume?.let { manager.setStreamVolume(AudioManager.STREAM_ALARM, it, 0) }
    }
    previousAlarmVolume = null
    wakeLock?.runCatching { if (isHeld) release() }
    wakeLock = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
