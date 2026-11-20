package expo.modules.alarmcore

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.ForegroundInfo
import androidx.work.OutOfQuotaPolicy
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

// 앱을 열지 않고 서버로 바로 올리기 (알림 버튼 · 자동 기상 판정) — 기록이 쌓이는 자리(AlarmEventLog.append)가 onAppended를 부름
//   1) 알림 버튼 · 기상 알람 해제 기록 → WorkManager(네트워크 조건) → alarm-events-device가 alarm_events에 넣음
//   2) 기상 알람 해제 → 해제 + 10분 2초에 정확 알람(setExactAndAllowWhileIdle, Doze에서도 깸) → WakeJudgeReceiver → 급한 작업(WorkManager expedited) → 화면 사용(UsageSpans)으로 WakeJudge 판정 → 확정이면 daily_records · WAKE_CONFIRMED를 같은 함수로
//      같은 시각에 폰 안에서만 판정해 자동으로 못 정하면(사용 기록 권한 없음 · 못 읽음 · 사용 적음) "지금 일어나셨나요?" 알림을 띄움 (WakePrompt, 네트워크 · 기기 키 무관)
//      정확 알람 권한이 없거나 못 걸면 같은 시각의 WorkManager 지연 작업으로 (Doze · 절전에서 늦을 수 있음 — 늦어도 확정 시각은 사용 기록으로 정해지고, 못 돌면 앱이 열릴 때 재판정)
//   인증은 백그라운드 브리핑 갱신과 같은 기기 키(BriefingCredential, Authorization: Bearer bdk_…). 키가 없거나 만료 · 폐기면 아무것도 안 하고 지금처럼 앱이 열릴 때 JS가 올림
//   기록은 폰에서 지우지 않음 — 앱이 열리면 JS가 같은 client_event_id로 다시 올리고(충돌 무시) 원탭 뒤처리(출발 · 도착 시각 반영)도 그때 돎. 그래서 다시 올려도 중복이 안 생김
//   실패는 모두 조용히 넘어감 (기록 자체는 폰에 남아 있음)
object DeviceUpload {
  private const val CONNECT_TIMEOUT_MS = 15_000
  private const val READ_TIMEOUT_MS = 20_000
  const val BACKOFF_SECONDS = 30L

  const val EXTRA_EVENT_ID = "client_event_id"
  const val EXTRA_ALARM_ID = "alarm_id"
  const val EXTRA_DISMISSED_AT = "dismissed_at"

  private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

  /** 새 기록이 쌓일 때 부름 — 올릴 종류면 업로드 작업, 기상 해제면 판정 작업을 검 */
  fun onAppended(context: Context, record: AlarmEventRecord) {
    if (DeviceUploadRules.shouldUpload(record.alarmType, record.eventType)) enqueueEvent(context, record.clientEventId)
    if (DeviceUploadRules.shouldJudgeWake(record.alarmType, record.eventType)) WakeJudgeSchedule.schedule(context, record.alarmId, record.at)
  }

  private fun enqueueEvent(context: Context, clientEventId: String) {
    val request = OneTimeWorkRequestBuilder<DeviceEventUploadWorker>()
      .setInputData(workDataOf(EXTRA_EVENT_ID to clientEventId))
      .setConstraints(network)
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
      .build()
    WorkManager.getInstance(context).enqueueUniqueWork("device_event_$clientEventId", ExistingWorkPolicy.KEEP, request)
  }

  // 로그아웃으로 키가 지워지면 작업이 시작할 때 스스로 그만둠 (BriefingCredential.load가 null)
  fun eventJson(record: AlarmEventRecord): JSONObject = JSONObject()
    .put("alarm_id", record.alarmId)
    .put("client_event_id", record.clientEventId)
    .put("event_type", record.eventType)
    .put("event_at", DeviceUploadRules.isoUtc(record.at))
    .put("sequence_no", record.sequenceNo)
    .put("input_source", record.inputSource)
    .apply { record.snoozeMinutes?.let { put("snooze_minutes", it) } }

  /** 서버 함수에 보냄. 응답 상태를 돌려줌 (연결 실패면 null) */
  internal fun post(credential: BriefingCredential.Credential, url: String, body: JSONObject): Int? {
    return try {
      val conn = (URL(url).openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        connectTimeout = CONNECT_TIMEOUT_MS
        readTimeout = READ_TIMEOUT_MS
        doOutput = true
        setRequestProperty("content-type", "application/json")
        setRequestProperty("authorization", "Bearer ${credential.token}")
        if (credential.apikey.isNotEmpty()) setRequestProperty("apikey", credential.apikey)
      }
      try {
        conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
        conn.responseCode.also { runCatching { conn.inputStream.close() } }
      } finally {
        conn.disconnect()
      }
    } catch (e: IOException) {
      null
    }
  }
}

// 기상 알람 해제 + 10분 2초 — 정확 알람으로 깨워 급한 작업을 넣음 (BriefingRefresh와 같은 방식). 권한이 없으면 지연 작업
object WakeJudgeSchedule {
  private fun requestCode(alarmId: String): Int = "wake_judge_$alarmId".hashCode() and 0x7fffffff

  /** 같은 알람 번호면 같은 PendingIntent(extras는 비교하지 않음) — 지울 때는 dismissedAt에 아무 값이나 */
  fun operation(context: Context, alarmId: String, dismissedAt: Long): PendingIntent {
    val intent = Intent(context, WakeJudgeReceiver::class.java).apply {
      data = Uri.fromParts("alarmcore-wake-judge", alarmId, null) // 알람마다 다른 PendingIntent
      putExtra(DeviceUpload.EXTRA_ALARM_ID, alarmId)
      putExtra(DeviceUpload.EXTRA_DISMISSED_AT, dismissedAt)
    }
    return PendingIntent.getBroadcast(context, requestCode(alarmId), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  /**
   * 해제 직후 부름. 같은 알람을 또 끄면(미루고 다시 울린 뒤) 나중 해제 기준으로 바뀜 — 앱도 확정 전이면 마지막 해제부터 10분을 봄 (pickDismissedAt)
   * AlarmManager 예약은 재부팅하면 사라지므로 예약을 폰에 저장해 두고(WakeJudgeStore) AlarmBootReceiver가 restore로 복원함 (G7)
   */
  fun schedule(context: Context, alarmId: String, dismissedAt: Long) {
    WakeJudgeStore.save(context, alarmId, dismissedAt)
    val at = DeviceUploadRules.judgeAtMillis(dismissedAt)
    val exact = runCatching {
      if (!AlarmScheduler.canScheduleExactAlarms(context)) return@runCatching false
      context.getSystemService(AlarmManager::class.java).setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, operation(context, alarmId, dismissedAt))
      true
    }.getOrDefault(false)
    if (!exact) {
      enqueue(context, alarmId, dismissedAt, expedited = false)
      enqueuePrompt(context, alarmId, dismissedAt)
    }
  }

  /**
   * 재부팅 · 시간 변경 뒤 저장해 둔 판정 예약을 되살림 (AlarmBootReceiver, 백그라운드 스레드에서) — 아직이면 다시 걸고,
   * 꺼져 있는 사이 판정 시각이 지났으면 바로 한 번 판정(서버로 올리는 작업 + 확인 알림), 12시간이 지난 것은 버림 (G7)
   */
  fun restore(context: Context) {
    val now = System.currentTimeMillis()
    WakeJudgeStore.all(context).forEach { (alarmId, dismissedAt) ->
      when (DeviceUploadRules.judgeRestoreAction(dismissedAt, now)) {
        DeviceUploadRules.JudgeRestore.DROP -> WakeJudgeStore.remove(context, alarmId)
        DeviceUploadRules.JudgeRestore.RESCHEDULE -> runCatching { schedule(context, alarmId, dismissedAt) }
        DeviceUploadRules.JudgeRestore.RUN_NOW -> {
          runCatching { enqueue(context, alarmId, dismissedAt, expedited = true) }
          runCatching { WakePrompt.promptIfNeeded(context, alarmId, dismissedAt) }
          WakeJudgeStore.remove(context, alarmId, dismissedAt)
        }
      }
    }
  }

  /** 정확 알람을 못 걸 때 — 확인 알림용 지연 작업. 네트워크 조건 없음 (오프라인이어도 알림은 떠야 함) */
  private fun enqueuePrompt(context: Context, alarmId: String, dismissedAt: Long) {
    val request = OneTimeWorkRequestBuilder<WakePromptWorker>()
      .setInputData(workDataOf(DeviceUpload.EXTRA_ALARM_ID to alarmId, DeviceUpload.EXTRA_DISMISSED_AT to dismissedAt))
      .setInitialDelay(DeviceUploadRules.judgeDelayMillis(dismissedAt, System.currentTimeMillis()), TimeUnit.MILLISECONDS)
      .build()
    WorkManager.getInstance(context).enqueueUniqueWork("device_wake_prompt_$alarmId", ExistingWorkPolicy.REPLACE, request)
  }

  /** 정확 알람이 울림(WakeJudgeReceiver) 또는 지연 작업 예약 — 네트워크 조건. expedited는 Doze 중에도 돌고, 할당량이 모자라면 보통 작업으로 */
  fun enqueue(context: Context, alarmId: String, dismissedAt: Long, expedited: Boolean) {
    val builder = OneTimeWorkRequestBuilder<WakeJudgeWorker>()
      .setInputData(workDataOf(DeviceUpload.EXTRA_ALARM_ID to alarmId, DeviceUpload.EXTRA_DISMISSED_AT to dismissedAt))
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, DeviceUpload.BACKOFF_SECONDS, TimeUnit.SECONDS)
    if (expedited) builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
    else builder.setInitialDelay(DeviceUploadRules.judgeDelayMillis(dismissedAt, System.currentTimeMillis()), TimeUnit.MILLISECONDS)
    WorkManager.getInstance(context).enqueueUniqueWork("device_wake_$alarmId", ExistingWorkPolicy.REPLACE, builder.build())
  }
}

// 정확 알람 → ① 서버로 올리는 급한 작업 넣기 ② 확인 알림 판정 · 표시 (폰 안에서만, 네트워크 · 기기 키 상관없음)
//   ②는 사용 기록 읽기라 시간이 걸릴 수 있어 goAsync로 별도 스레드에서 — ①의 네트워크 제약 밖
class WakeJudgeReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val alarmId = intent.getStringExtra(DeviceUpload.EXTRA_ALARM_ID) ?: return
    val dismissedAt = intent.getLongExtra(DeviceUpload.EXTRA_DISMISSED_AT, 0L).takeIf { it > 0 } ?: return
    runCatching { WakeJudgeSchedule.enqueue(context, alarmId, dismissedAt, expedited = true) }
    WakeJudgeStore.remove(context, alarmId, dismissedAt) // 판정이 시작됨 — 재부팅해도 다시 안 함 (이후 올리기는 WorkManager가 이어 감)
    val pending = goAsync()
    Thread {
      try {
        runCatching { WakePrompt.promptIfNeeded(context, alarmId, dismissedAt) }
      } finally {
        pending.finish()
      }
    }.start()
  }
}

// 정확 알람을 못 걸 때의 확인 알림 — 같은 판정 · 표시, 네트워크 조건 없음
class WakePromptWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val alarmId = inputData.getString(DeviceUpload.EXTRA_ALARM_ID) ?: return Result.success()
    val dismissedAt = inputData.getLong(DeviceUpload.EXTRA_DISMISSED_AT, 0L).takeIf { it > 0 } ?: return Result.success()
    runCatching { WakePrompt.promptIfNeeded(applicationContext, alarmId, dismissedAt) }
    WakeJudgeStore.remove(applicationContext, alarmId, dismissedAt)
    return Result.success()
  }
}

// 알림 버튼 · 기상 해제 기록 하나를 올림
class DeviceEventUploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val id = inputData.getString(DeviceUpload.EXTRA_EVENT_ID) ?: return Result.success()
    // 그사이 앱이 열려 JS가 올리고 지웠으면(기록 없음) · 기기 키가 없으면 할 일 없음
    val record = AlarmEventLog.pending(applicationContext).firstOrNull { it.clientEventId == id }
    val credential = BriefingCredential.load(applicationContext)
    val url = DeviceUploadRules.eventTarget(record != null, credential?.url) ?: return Result.success()
    val status = DeviceUpload.post(credential!!, url, JSONObject().put("events", JSONArray().put(DeviceUpload.eventJson(record!!))))
    return if (DeviceUploadRules.shouldRetry(status, runAttemptCount)) Result.retry() else Result.success()
  }
}

// 기상 알람을 끈 10분 뒤 — 화면 사용으로 앱과 같은 규칙(WakeJudge)으로 판정, 확정이면 서버에 기록. 확정이 아니면 이 작업은 아무것도 안 함 (확인 알림은 WakePrompt가 따로 띄움 · 놓침은 서버 배치)
class WakeJudgeWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val alarmId = inputData.getString(DeviceUpload.EXTRA_ALARM_ID)
    val dismissedAt = inputData.getLong(DeviceUpload.EXTRA_DISMISSED_AT, 0L)
    val credential = BriefingCredential.load(applicationContext)
    val url = DeviceUploadRules.judgeTarget(alarmId, dismissedAt, credential?.url) ?: return Result.success()

    // 사용 정보 접근 권한이 없거나 못 읽으면(안드로이드 9 미만) 판정 못 함 → 앱의 확인 알림 흐름 그대로
    val raw = try {
      UsageSpans.read(applicationContext, dismissedAt, DeviceUploadRules.observeEndMillis(dismissedAt))
    } catch (e: Exception) {
      return Result.success()
    }
    val result = WakeJudge.evaluate(dismissedAt, System.currentTimeMillis(), WakeJudge.toSpans(dismissedAt, DeviceUploadRules.usageToMillis(raw)))
    val confirm = DeviceUploadRules.wakeConfirmation(alarmId!!, dismissedAt, result) ?: return Result.success()

    // 앱 realWake.ts writeConfirmation과 같은 내용 · 같은 번호 — 서버가 그날 기록의 빈 칸 먼저, 이벤트는 마지막에 넣음. 앱이 먼저 · 나중에 같은 판정을 해도 한 줄
    val event = JSONObject()
      .put("alarm_id", confirm.alarmId)
      .put("client_event_id", confirm.eventId)
      .put("event_type", "WAKE_CONFIRMED")
      .put("event_at", confirm.confirmedAtIso)
      .put("sequence_no", 1)
      .put("input_source", "USAGE")
    val wake = JSONObject()
      .put("alarm_id", confirm.alarmId)
      .put("record_date", confirm.recordDate)
      .put("wake_confirmed_at", confirm.confirmedAtIso)
      .put("wake_reported_at", confirm.reportedAtIso)
    val status = DeviceUpload.post(credential!!, url, JSONObject().put("events", JSONArray().put(event)).put("wake", wake))
    return if (DeviceUploadRules.shouldRetry(status, runAttemptCount)) Result.retry() else Result.success()
  }

  // 12(API 31) 미만에서 급한 작업은 짧은 포그라운드 서비스로 돎 — 그때 보일 조용한 알림
  override fun getForegroundInfo(): ForegroundInfo {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      applicationContext.getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "기상 확인", NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false) },
      )
    }
    val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
      .setContentTitle("기상을 확인하고 있어요")
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setSilent(true)
      .build()
    return ForegroundInfo(NOTIFICATION_ID, notification)
  }

  private companion object {
    const val CHANNEL_ID = "alarm_wake_judge_v1"
    const val NOTIFICATION_ID = 4311
  }
}
