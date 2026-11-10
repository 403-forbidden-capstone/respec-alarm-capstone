package expo.modules.alarmcore

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import org.json.JSONObject

// 출발 알람의 음성 브리핑 — 일정 알림(알림음 · 진동 한 번)을 띄운 뒤 그 일정 시각 · 준비물 · 출발 촉구를 한 번 읽고 끝나는 짧은 포그라운드 서비스
//   알람은 울리자마자 저장소에서 지워지므로(일정 알림은 한 번 알리면 끝) 알람 값은 인텐트에 실어 옴. 음성 파일은 다 읽은 뒤 지움
//   정확한 알람(AlarmReceiver)에서 시작하므로 백그라운드 시작 제한의 예외. 시작을 못 하면 알림만 남음
class BriefingSpeechService : Service() {
  companion object {
    private const val CHANNEL_ID = "depart_briefing_v1"
    private const val NOTIFICATION_ID = 4102
    private const val EXTRA_ALARM = "alarm_json"
    private const val MAX_MILLIS = 2 * 60 * 1000L // 읽기가 안 끝나도 이만큼이면 정리

    fun start(context: Context, alarm: StoredAlarm) {
      val intent = Intent(context, BriefingSpeechService::class.java).putExtra(EXTRA_ALARM, alarm.toJson().toString())
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
    }
  }

  private val handler = Handler(Looper.getMainLooper())
  private var speaker: BriefingSpeaker? = null
  private var alarmId: String? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private val timeout = Runnable { stopSelf() }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val started = runCatching { startForegroundCompat(notification()) }.isSuccess
    val alarm = intent?.getStringExtra(EXTRA_ALARM)?.let { runCatching { StoredAlarm.fromJson(JSONObject(it)) }.getOrNull() }
    if (!started || alarm == null) {
      alarm?.let { VoiceBriefing.clear(this, it.alarmId) }
      stopSelf()
      return START_NOT_STICKY
    }
    // 앞 출발 안내가 아직 읽는 중이면 멈추고 이번 것을 읽음
    speaker?.stop()
    alarmId?.let { if (it != alarm.alarmId) VoiceBriefing.clear(this, it) }
    alarmId = alarm.alarmId
    wakeLock = wakeLock ?: getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:briefing").apply { setReferenceCounted(false) }
    wakeLock?.acquire(MAX_MILLIS + 10_000L)
    val speech = VoiceBriefing.speechFor(this, alarm, System.currentTimeMillis())
    if (speech == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    speaker = BriefingSpeaker(this, onStart = {}, onDone = { stopSelf() }).also { it.speak(speech) }
    handler.removeCallbacks(timeout)
    handler.postDelayed(timeout, MAX_MILLIS)
    return START_NOT_STICKY
  }

  private fun notification(): Notification {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(CHANNEL_ID, "출발 음성 안내", NotificationManager.IMPORTANCE_LOW).apply {
        description = "출발 알람에서 일정 · 준비물을 읽어 주는 동안 표시"
        setSound(null, null)
        enableVibration(false)
      }
      getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
      .setContentTitle("출발 안내를 읽고 있어요")
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true)
      .build()
  }

  private fun startForegroundCompat(n: Notification) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(NOTIFICATION_ID, n)
    }
  }

  override fun onDestroy() {
    handler.removeCallbacks(timeout)
    speaker?.stop()
    speaker = null
    alarmId?.let { VoiceBriefing.clear(this, it) }
    wakeLock?.runCatching { if (isHeld) release() }
    wakeLock = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
