package expo.modules.alarmcore

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.ForegroundInfo
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

// 백그라운드 기상 브리핑 갱신 작업 (#515) — 앱이 꺼져 있어도 기상 알람의 브리핑(대본 문장 · 3 · 4단계 Gemini 음성)을 다시 받아 저장
//   앱 prepareBriefings와 같은 일: alarm-briefing-device에 { alarm_id, have(폰에 있는 음성 열쇠) } → 응답을 VoiceBriefing.save에 그대로
//   대본은 입력이 같으면 서버 캐시(wake_scripts), 음성은 열쇠가 같으면 안 만듦 — 같은 날 여러 번 돌아도 Gemini 호출이 늘지 않음
//   저장된 브리핑은 새 응답을 다 받았을 때만 바뀜. 실패(인터넷 · 서버 · 키 만료 · 정리 지연)면 그대로 두고 기상 5분 전까지만 다시 시도
//   알람이 울리는 순간에는 이 작업이 아니라 저장된 파일만 씀 (네트워크 · Gemini 없음)
class BriefingRefreshWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  companion object {
    const val BACKOFF_SECONDS = 30L
    private const val CONNECT_TIMEOUT_MS = 15_000
    // 서버가 3 · 4단계 Gemini 음성을 만드는 시간까지 (앱 BRIEFING_TIMEOUT_MS와 같음)
    private const val READ_TIMEOUT_MS = 90_000
    private const val CHANNEL_ID = "alarm_briefing_refresh_v1"
    private const val NOTIFICATION_ID = 4310
  }

  override fun doWork(): Result {
    val id = inputData.getString(BriefingRefresh.EXTRA_ALARM_ID) ?: return Result.success()
    val now = System.currentTimeMillis()
    val alarm = AlarmStorage.get(applicationContext, id) ?: return Result.success() // 그사이 지워짐
    if (!BriefingRules.canRefresh(alarm.type, alarm.ringing, alarm.snoozeCount, alarm.seriesIndex, alarm.atMillis, now)) return Result.success()
    // 키가 없으면(로그아웃 · 아직 발급 전) 안 함 — 앱을 열 때 맞추기가 받음
    val credential = BriefingCredential.load(applicationContext) ?: return Result.success()

    val (status, body) = try {
      post(credential, id)
    } catch (e: IOException) {
      null to null
    }
    val deadline = BriefingRules.refreshDeadline(alarm.atMillis)
    // 응답을 기다리는 사이 알람이 지워졌거나(삭제 · 끔 · 로그아웃) 작업이 취소됐으면 쓰지 않음 — 지운 알람 폴더에 브리핑이 다시 생기지 않게
    val current = AlarmStorage.get(applicationContext, id)
    if (isStopped || current == null || current.atMillis != alarm.atMillis) return Result.success()
    return when (BriefingRules.refreshOutcome(status)) {
      BriefingRules.RefreshOutcome.SAVE -> {
        val text = body ?: return retryOrStop(now, deadline)
        val parsed = runCatching { JSONObject(text) }.getOrNull() ?: return retryOrStop(now, deadline)
        if (!parsed.optBoolean("enabled", true)) {
          VoiceBriefing.clear(applicationContext, id) // 사용자가 AI 음성 브리핑을 끔 (앱 prepareBriefings와 같음)
        } else {
          // 파일 쓰기가 실패하면 예전 브리핑이 남음 (VoiceBriefing.save는 음성을 먼저 다 풀어 본 뒤에 바꿈)
          runCatching { VoiceBriefing.save(applicationContext, id, text) }.onFailure { return retryOrStop(now, deadline) }
        }
        // 서버: 전날 대화가 아직 정리 전이면 refresh_at → 그때 한 번 더 (마감을 넘으면 BriefingRefresh가 안 걺)
        val refreshAt = parsed.optDouble("refresh_at", Double.NaN).takeIf { !it.isNaN() }?.toLong()
        BriefingRefresh.offer(applicationContext, id, refreshAt)
        Result.success()
      }
      BriefingRules.RefreshOutcome.STOP -> Result.success() // 키 만료 · 알람 없음 등 — 다시 해도 같음, 저장된 브리핑으로 울림
      BriefingRules.RefreshOutcome.RETRY -> retryOrStop(now, deadline)
    }
  }

  private fun retryOrStop(now: Long, deadline: Long): Result {
    val backoff = BACKOFF_SECONDS * 1000L shl runAttemptCount.coerceAtMost(10)
    return if (BriefingRules.shouldRetry(runAttemptCount, now, backoff, deadline)) Result.retry() else Result.success()
  }

  private fun post(c: BriefingCredential.Credential, alarmId: String): Pair<Int, String?> {
    val payload = JSONObject()
      .put("alarm_id", alarmId)
      .put("have", org.json.JSONArray(VoiceBriefing.hashes(applicationContext, alarmId)))
      .toString()
    val conn = (URL(c.url).openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = CONNECT_TIMEOUT_MS
      readTimeout = READ_TIMEOUT_MS
      doOutput = true
      setRequestProperty("content-type", "application/json")
      setRequestProperty("authorization", "Bearer ${c.token}")
      if (c.apikey.isNotEmpty()) setRequestProperty("apikey", c.apikey)
    }
    try {
      conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
      val status = conn.responseCode
      val body = if (status in 200..299) conn.inputStream.bufferedReader().use { it.readText() } else null
      return status to body
    } finally {
      conn.disconnect()
    }
  }

  // 12(API 31) 미만에서 급한 작업은 짧은 포그라운드 서비스로 돎 — 그때 보일 조용한 알림
  override fun getForegroundInfo(): ForegroundInfo {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      applicationContext.getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "기상 브리핑 준비", NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false) },
      )
    }
    val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
      .setContentTitle("기상 브리핑을 준비하고 있어요")
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setSilent(true)
      .build()
    return ForegroundInfo(NOTIFICATION_ID, notification)
  }
}
