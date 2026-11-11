package expo.modules.alarmcore

import android.app.NotificationManager
import android.content.Context
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// JS(src/index.ts)가 부르는 함수 모음. ackRingScreen만 바로 끝나는 Function이고 나머지는 AsyncFunction — 판단은 AlarmController가 하고 여기는 이어 주기만 함
// 복잡한 값(꾸러미 + 울림 계획)은 JSON 글자 하나로 받아 AlarmController가 파싱함
class AlarmCoreModule : Module() {
  // 컨텍스트가 없으면 조용히 넘어가지 않고 JS 쪽 Promise를 reject함 ("예약된 줄 알았는데 안 울림" 방지)
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("AlarmCore")

    // 앱이 켜져 있는 동안 새 울림 기록이 생기면 JS로 알림 (꺼져 있을 때 쌓인 것은 getPendingEvents로 읽음)
    Events("onAlarmEvent")

    OnCreate {
      AlarmEventLog.listener = { record -> runCatching { sendEvent("onAlarmEvent", record.toMap()) } }
    }

    OnDestroy {
      AlarmEventLog.listener = null
    }

    // 예약: 'scheduled' · 'skipped_past'(시각이 지남) · 'deferred'(울리거나 미룬 중이라 새 꾸러미를 받지 않음). 권한이 없으면 reject
    AsyncFunction("schedule") { payload: String ->
      AlarmController.schedule(context, payload)
    }

    // 그 알람(미루기 · 다시 울림 포함)을 지우고, 울리는 중이면 멈춤
    AsyncFunction("cancel") { alarmId: String ->
      AlarmController.cancel(context, alarmId)
    }

    AsyncFunction("cancelAll") {
      AlarmController.cancelAll(context)
    }

    // 다음 울릴 시각 순
    AsyncFunction("list") {
      AlarmController.list(context)
    }

    // 지금 울리는 알람을 해제 처리
    AsyncFunction("stop") {
      AlarmController.stopRinging(context)
    }

    // 지금 울리는 알람 (앱 H07이 그림). 울리는 게 없으면 null
    AsyncFunction("getRinging") {
      AlarmController.getRinging(context)
    }

    // 지금 울리는 알람을 고른 분만큼 미룸. 한도 · 허용 분을 넘었거나 이미 멈췄으면 false
    AsyncFunction("snooze") { minutes: Int ->
      AlarmController.snoozeRinging(context, minutes)
    }

    // 앱이 H07(/ring)을 띄웠다고 알림 — 길잡이 화면(AlarmRingingActivity)이 닫힘
    Function("ackRingScreen") {
      AlarmRingingActivity.onAppShowedRing()
    }

    // 알람이 끝나 앱 H07의 잠금화면 위 설정을 되돌림. dismissKeyguard = true(해제)면 잠금 해제도 요청, false(미루기)면 앱을 뒤로 보냄
    AsyncFunction("releaseRingOverLock") { dismissKeyguard: Boolean ->
      RingOverLock.release(dismissKeyguard)
    }

    // 예약 없이 바로 울림 (시험용)
    AsyncFunction("ringNow") { payload: String ->
      AlarmController.ringNow(context, payload)
    }

    // 개발 화면 AI 음성 시험 (시험 알람 id만) — 샘플 브리핑을 쓰고 바로 울림 · 지금 상태 · 즉시 정지
    AsyncFunction("ringVoiceTest") { payload: String, voiceJson: String ->
      AlarmController.ringVoiceTest(context, payload, voiceJson)
    }

    AsyncFunction("voiceTestStatus") {
      AlarmController.voiceTestStatus()
    }

    AsyncFunction("stopVoiceTest") { alarmId: String? ->
      AlarmController.stopVoiceTest(context, alarmId)
    }

    AsyncFunction("canScheduleExactAlarms") {
      AlarmScheduler.canScheduleExactAlarms(context)
    }

    // 잠금화면 위 알람 화면에 필요함. 14 미만은 늘 허용
    AsyncFunction("canUseFullScreenIntent") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        true
      } else {
        context.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()
      }
    }

    AsyncFunction("hasUsageAccess") {
      UsageSpans.hasAccess(context)
    }

    AsyncFunction("openUsageAccessSettings") {
      UsageSpans.openSettings(context)
    }

    AsyncFunction("getUsageSpans") { fromMillis: Double, toMillis: Double ->
      UsageSpans.read(context, fromMillis.toLong(), toMillis.toLong())
    }

    AsyncFunction("getPendingEvents") {
      AlarmEventLog.pending(context).map { it.toMap() }
    }

    AsyncFunction("markEventsUploaded") { clientEventIds: List<String> ->
      AlarmEventLog.acknowledge(context, clientEventIds)
    }

    // AI 음성 브리핑 — 앱이 alarm-briefing 결과를 알람별로 저장 · 폰에 있는 음성 열쇠 읽기 · 지우기 (VoiceBriefing)
    AsyncFunction("saveVoiceBriefing") { alarmId: String, json: String ->
      VoiceBriefing.save(context, alarmId, json)
    }

    AsyncFunction("getVoiceBriefingHashes") { alarmId: String ->
      VoiceBriefing.hashes(context, alarmId)
    }

    AsyncFunction("clearVoiceBriefing") { alarmId: String ->
      VoiceBriefing.clear(context, alarmId)
    }
  }
}
