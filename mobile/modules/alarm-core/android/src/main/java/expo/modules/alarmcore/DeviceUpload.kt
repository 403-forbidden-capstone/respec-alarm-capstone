package expo.modules.alarmcore

import android.content.Context
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
//   2) 기상 알람 해제 → 해제 + 10분에 WorkManager → 화면 사용(UsageSpans)으로 WakeJudge 판정 → 확정이면 daily_records · WAKE_CONFIRMED를 같은 함수로
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
    if (DeviceUploadRules.shouldJudgeWake(record.alarmType, record.eventType)) enqueueWakeJudge(context, record.alarmId, record.at)
  }

  private fun enqueueEvent(context: Context, clientEventId: String) {
    val request = OneTimeWorkRequestBuilder<DeviceEventUploadWorker>()
      .setInputData(workDataOf(EXTRA_EVENT_ID to clientEventId))
      .setConstraints(network)
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
      .build()
    WorkManager.getInstance(context).enqueueUniqueWork("device_event_$clientEventId", ExistingWorkPolicy.KEEP, request)
  }

  // 같은 알람을 또 끄면(미루고 다시 울린 뒤) 나중 해제 기준으로 바꿈 — 앱도 확정 전이면 마지막 해제부터 10분을 봄 (pickDismissedAt)
  private fun enqueueWakeJudge(context: Context, alarmId: String, dismissedAt: Long) {
    val request = OneTimeWorkRequestBuilder<WakeJudgeWorker>()
      .setInputData(workDataOf(EXTRA_ALARM_ID to alarmId, EXTRA_DISMISSED_AT to dismissedAt))
      .setInitialDelay(DeviceUploadRules.judgeDelayMillis(dismissedAt, System.currentTimeMillis()), TimeUnit.MILLISECONDS)
      .setConstraints(network)
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
      .build()
    WorkManager.getInstance(context).enqueueUniqueWork("device_wake_$alarmId", ExistingWorkPolicy.REPLACE, request)
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

// 알림 버튼 · 기상 해제 기록 하나를 올림
class DeviceEventUploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val id = inputData.getString(DeviceUpload.EXTRA_EVENT_ID) ?: return Result.success()
    // 그사이 앱이 열려 JS가 올리고 지웠으면 할 일 없음
    val record = AlarmEventLog.pending(applicationContext).firstOrNull { it.clientEventId == id } ?: return Result.success()
    val credential = BriefingCredential.load(applicationContext) ?: return Result.success()
    val url = DeviceUploadRules.eventsUrl(credential.url) ?: return Result.success()
    val status = DeviceUpload.post(credential, url, JSONObject().put("events", JSONArray().put(DeviceUpload.eventJson(record))))
    return if (DeviceUploadRules.shouldRetry(status, runAttemptCount)) Result.retry() else Result.success()
  }
}

// 기상 알람을 끈 10분 뒤 — 화면 사용으로 앱과 같은 규칙(WakeJudge)으로 판정, 확정이면 서버에 기록. 확정이 아니면 아무것도 안 함 (확인 알림 · 놓침은 지금 흐름 그대로)
class WakeJudgeWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val alarmId = inputData.getString(DeviceUpload.EXTRA_ALARM_ID) ?: return Result.success()
    val dismissedAt = inputData.getLong(DeviceUpload.EXTRA_DISMISSED_AT, 0L).takeIf { it > 0 } ?: return Result.success()
    val credential = BriefingCredential.load(applicationContext) ?: return Result.success()
    val url = DeviceUploadRules.eventsUrl(credential.url) ?: return Result.success()

    val observeEnd = dismissedAt + (WakeJudge.OBSERVE_MINUTES * 60_000).toLong()
    val now = System.currentTimeMillis()
    // 사용 정보 접근 권한이 없거나 못 읽으면(안드로이드 9 미만) 판정 못 함 → 앱의 확인 알림 흐름 그대로
    val millisSpans = try {
      UsageSpans.read(applicationContext, dismissedAt, observeEnd).map { (it["startMillis"] as Double).toLong() to (it["endMillis"] as Double).toLong() }
    } catch (e: Exception) {
      return Result.success()
    }
    val result = WakeJudge.evaluate(dismissedAt, now, WakeJudge.toSpans(dismissedAt, millisSpans))
    val reachedAt = result.reachedAtMillis
    if (result.phase != WakeJudge.Phase.AUTO || reachedAt == null) return Result.success()

    // 앱 realWake.ts writeConfirmation과 같은 내용 · 같은 번호 — 서버가 그날 기록의 빈 칸 먼저, 이벤트는 마지막에 넣음. 앱이 먼저 · 나중에 같은 판정을 해도 한 줄
    val event = JSONObject()
      .put("alarm_id", alarmId)
      .put("client_event_id", DeviceUploadRules.wakeConfirmedId(alarmId, dismissedAt))
      .put("event_type", "WAKE_CONFIRMED")
      .put("event_at", DeviceUploadRules.isoUtc(reachedAt))
      .put("sequence_no", 1)
      .put("input_source", "USAGE")
    val wake = JSONObject()
      .put("alarm_id", alarmId)
      .put("record_date", DeviceUploadRules.kstDay(reachedAt))
      .put("wake_confirmed_at", DeviceUploadRules.isoUtc(reachedAt))
      .put("wake_reported_at", DeviceUploadRules.isoUtc(dismissedAt))
    val status = DeviceUpload.post(credential, url, JSONObject().put("events", JSONArray().put(event)).put("wake", wake))
    return if (DeviceUploadRules.shouldRetry(status, runAttemptCount)) Result.retry() else Result.success()
  }
}
