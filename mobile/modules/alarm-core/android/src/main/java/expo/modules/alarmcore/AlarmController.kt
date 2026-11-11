package expo.modules.alarmcore

import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONObject

// 알람 한 개의 흐름(예약 → 울림 → 미루기 · 다시 울림 · 해제 · 취소)을 한곳에서 처리함
// 네이티브는 계획을 계산하지 않음 — 공통(TS)이 넘긴 RingPlan(볼륨 · 최대 울림 · 다시 울림 시각 · 미루기 시간)을 그대로 실행하고 상태만 바꿈
// 상태는 StoredAlarm에 있음: snoozeCount(미루기만 셈) · nextRingAt · ringCount · seriesIndex · ringing
//
// 울림 묶음: 처음 울림(또는 미루고 난 뒤 울림)이 시작되면 같은 묶음의 다시 울림 시각이 RingPlan.reRingOffsetsMillis(첫 울림 시작으로부터의 거리)대로
//   AlarmManager에 바로 걸림. 끄면(해제) 걸어 둔 다시 울림을 지우고, 미루면 그 자리를 미루기 시각으로 바꿈
object AlarmController {
  const val STATUS_SCHEDULED = "scheduled"
  const val STATUS_SKIPPED_PAST = "skipped_past"
  // 지금 울리거나 미룬 중인 같은 알람이라 새 꾸러미를 받지 않음. 앱은 해제 뒤 다음 맞추기(앱을 열 때)에서 다시 넘김
  const val STATUS_DEFERRED = "deferred"

  // 해제 뒤 앱이 열리는 주소 (app.json의 scheme = respecalarm). 기상 확인 · 아침 루틴 · 평가가 받음
  private const val WAKE_LINK = "respecalarm://wake"

  // 다시 울림 시각이 이미 지났더라도 바로 겹쳐 울리지 않게 최소 간격을 둠
  private const val MIN_RE_RING_DELAY_MILLIS = 1000L

  /** JS의 schedule — 꾸러미 + 울림 계획 JSON을 받아 폰에 걸음. 결과는 STATUS_* 글자 */
  fun schedule(context: Context, payload: String): String {
    val incoming = StoredAlarm.fromJson(JSONObject(payload))
    // 서비스가 죽어 ringing만 남은 찌꺼기는 먼저 정리 (안 그러면 그 알람이 영영 다시 안 걸림)
    val existing = AlarmStorage.get(context, incoming.alarmId)?.let { settleStaleRinging(context, it) }

    // 지금 울리는 중인 알람은 건드리지 않음. 같은 시각의 알람이 미룸 · 다시 울림을 기다리는 중일 때도 그대로 둠
    // (서버와 맞추려고 같은 꾸러미를 다시 넘겨도 미루기가 풀리거나 지워지지 않게)
    // 서버와 맞추는 기준(시각 · 강도 · 소리 키 · 진동)이 같으면 이미 맞은 것이라 STATUS_SCHEDULED, 다르면 새 꾸러미를 받지 않았다는 뜻으로 STATUS_DEFERRED
    if (existing != null) {
      val sameOccurrence = existing.atMillis == incoming.atMillis
      if (isActuallyRinging(existing) || (sameOccurrence && (existing.snoozeCount > 0 || existing.seriesIndex > 0))) {
        val alreadyMatches = sameOccurrence &&
          existing.intensity == incoming.intensity &&
          existing.soundKey == incoming.soundKey &&
          existing.vibration == incoming.vibration
        return if (alreadyMatches) STATUS_SCHEDULED else STATUS_DEFERRED
      }
    }

    // 시각이 지났으면 걸지 않음 (setAlarmClock은 지난 시각이면 바로 울려 버림). 같은 id의 예전 예약은 거둠
    if (incoming.atMillis <= System.currentTimeMillis()) {
      cancel(context, incoming.alarmId)
      return STATUS_SKIPPED_PAST
    }

    AlarmStorage.save(context, incoming)
    try {
      AlarmScheduler.schedule(context, incoming)
    } catch (error: Exception) {
      // 걸지 못해도 AlarmManager의 예전 예약은 남으므로 저장 기록도 예전 것으로 되돌림 (없던 알람이면 지움)
      if (existing != null) AlarmStorage.save(context, existing) else AlarmStorage.remove(context, incoming.alarmId)
      throw error
    }
    return STATUS_SCHEDULED
  }

  /** JS의 ringNow — 예약처럼 저장했다가 바로 울림 (시험용). 같은 id가 있으면 덮어씀 */
  fun ringNow(context: Context, payload: String) {
    val alarm = StoredAlarm.fromJson(JSONObject(payload))
    AlarmStorage.save(context, alarm.copy(nextRingAt = System.currentTimeMillis()))
    fire(context, alarm.alarmId)
  }

  /** 알람 시각이 됨 (AlarmReceiver) — 기록을 남기고 WAKE는 소리 서비스, 나머지는 일정 알림(알림음 · 진동 한 번) */
  fun fire(context: Context, id: String) {
    val stored = AlarmStorage.get(context, id) ?: return
    // 업데이트 전에 예약된 옛 출발 알람도 기존 한 번 알림 대신 지속 알람으로 승격.
    val current = if (stored.type == "DEPARTURE" && !stored.plan.sound) {
      val baseVolume = when (stored.intensity) { "SOFT" -> 60; "STRONG" -> 100; else -> 80 }
      val percent = kotlin.math.round(baseVolume * (1.0 + (stored.volumeAdjust ?: 0.0))).toInt().coerceIn(10, 100)
      stored.copy(plan = stored.plan.copy(
        sound = true,
        volumePercent = percent,
        maxRingMillis = 180_000L,
        snoozeMillis = 600_000L,
        snoozeMinutesOptions = SnoozeRules.DEFAULT_OPTIONS,
        snoozeLimit = stored.snoozeLimit.coerceAtLeast(0),
        oneTapLabel = null,
        oneTapEventType = null,
      ))
    } else stored
    val plan = current.plan
    val now = System.currentTimeMillis()
    val index = current.seriesIndex
    val seriesStart = if (index == 0) now else current.seriesStartAt
    val ringCount = current.ringCount + 1
    var next = current.copy(
      ringCount = ringCount,
      seriesIndex = index + 1,
      seriesStartAt = seriesStart,
      ringing = plan.sound,
      nextRingAt = now,
    )
    AlarmEventLog.append(context, id, current.type, "TRIGGERED", sequenceNo = ringCount)

    if (!plan.sound) {
      // 일정 알림은 한 번 알리면 끝 (미루기 · 다시 울림 없음). 원탭 응답은 알림이 인텐트에 실어 가짐
      // 출발 알림은 그 일정 시각 · 준비물 · 출발 촉구를 음성으로 읽음 — 읽을 때까지 브리핑 파일을 남겨 두고 서비스가 다 읽은 뒤 지움
      val speak = current.type == "DEPARTURE"
      AlarmStorage.remove(context, id, keepVoice = speak)
      AlarmNotifications.showNotice(context, next)
      if (speak) runCatching { BriefingSpeechService.start(context, next) }.onFailure { VoiceBriefing.clear(context, id) }
      return
    }

    // 이번 울림이 끝나기 전에 다음 다시 울림을 미리 걸어 둠 — 서비스가 죽어도 이어짐
    val offset = plan.reRingOffsetsMillis.getOrNull(index)
    if (offset != null) {
      val reRingAt = maxOf(seriesStart + offset, now + MIN_RE_RING_DELAY_MILLIS)
      val withReRing = next.copy(nextRingAt = reRingAt)
      next = try {
        AlarmScheduler.schedule(context, withReRing)
        withReRing
      } catch (error: Exception) {
        // 걸지 못하면(권한이 중간에 꺼짐 등) 이번 울림을 마지막으로 침
        next.copy(seriesIndex = plan.reRingOffsetsMillis.size + 1)
      }
    }
    AlarmStorage.save(context, next)
    // 서비스를 못 띄우면(시스템이 막음 등) 이번 울림은 끝난 것으로 치고, 걸어 둔 다시 울림은 그대로 이어 감
    val started = runCatching { AlarmPlaybackService.start(context, id) }.isSuccess
    if (!started) onRingTimeout(context, id, ringCount)
  }

  /**
   * 서비스가 한 번 울림(최대 시간)을 끝냄. 돌려주는 값 = 서비스가 멈춰도 되는지
   * ringCount는 그 울림의 번호 — 그 사이 다음 울림이 이미 시작됐으면(번호가 다름) 서비스를 멈추지 않음
   */
  fun onRingTimeout(context: Context, id: String, ringCount: Int): Boolean {
    val alarm = AlarmStorage.get(context, id) ?: return true
    if (alarm.ringCount != ringCount) return false
    if (!alarm.ringing) return true
    if (alarm.isLastRingOfSeries) {
      // 다시 울림까지 다 지나도록 안 껐음. 놓침(MISSED) 판정과 기록은 서버가 함 (7장 7.9.2)
      AlarmStorage.remove(context, id)
    } else {
      AlarmStorage.save(context, alarm.copy(ringing = false))
    }
    return true
  }

  /**
   * 미루기 — 같은 알람의 상태를 바꿈 (새 알람을 만들지 않음). 예약을 못 걸면 false이고 아무것도 안 바뀜(계속 울림)
   * minutes = 고른 미루기 분 (계획의 5 · 10 · 15분 중 하나). null이면 계획의 기본 미루기 시간(알림의 "미루기" 버튼)
   * 한도(plan.snoozeLimit)에 닿았거나 목록에 없는 분이면 false (D3 기본안 A) — 화면이 이미 막지만 알림이 오래 남아 눌릴 때를 위해 여기서도 막음
   */
  fun snooze(context: Context, id: String, minutes: Int? = null): Boolean {
    val alarm = AlarmStorage.get(context, id) ?: return false
    // 울리는 중(ringing)에만 미룸 — 서비스가 비동기로 멈추기 전에 같은 버튼을 두 번 눌러도 한 번만 셈.
    // ringing은 울림이 시작될 때(fire) 서비스를 띄우기 전에 true로 저장되고, 미루기 · 해제 · 최대 시간 끝에서 false가 됨.
    // 알림의 미루기 버튼과 울림 화면은 서비스가 울리는 동안에만 보이므로 정상 누름은 늘 true
    if (!alarm.ringing) return false
    if (!SnoozeRules.canSnooze(alarm.snoozeCount, alarm.plan.snoozeLimit)) return false
    val chosenMinutes = minutes ?: SnoozeRules.defaultMinutes(alarm.plan)
    // 옵션 칸이 없던 옛 저장 알람은 화면과 같이 기본 목록으로 봄 (#332 로컬 리뷰)
    if (chosenMinutes !in alarm.plan.snoozeMinutesOptions.ifEmpty { SnoozeRules.DEFAULT_OPTIONS }) return false
    val updated = alarm.copy(
      ringing = false,
      snoozeCount = alarm.snoozeCount + 1,
      seriesIndex = 0,
      nextRingAt = System.currentTimeMillis() + chosenMinutes * 60_000L,
    )
    // 걸어 둔 다시 울림이 있으면 이 예약이 그 자리를 바꿈
    try {
      AlarmScheduler.schedule(context, updated)
    } catch (error: Exception) {
      return false
    }
    AlarmStorage.save(context, updated)
    AlarmEventLog.append(context, id, alarm.type, "SNOOZED", sequenceNo = alarm.ringCount, snoozeMinutes = chosenMinutes)
    AlarmPlaybackService.stopIfRinging(context, listOf(id))
    return true
  }

  /** 지금 이 알람이 울리는 중인지 (저장된 ringing 값) — 미루기 실패가 "이미 미룸"인지 진짜 실패인지 가릴 때 씀 */
  fun isRinging(context: Context, id: String): Boolean = AlarmStorage.get(context, id)?.ringing == true

  /** 해제 — 소리를 끄고, 걸어 둔 다시 울림을 지우고, 기록을 남김. WAKE는 openApp이면 기상 확인 화면으로 앱을 엶 */
  fun dismiss(context: Context, id: String, openApp: Boolean) {
    val alarm = AlarmStorage.get(context, id)
    AlarmScheduler.cancelPending(context, id)
    if (alarm != null) {
      AlarmStorage.remove(context, id)
      AlarmEventLog.append(context, id, alarm.type, "DISMISSED", sequenceNo = alarm.ringCount)
    }
    AlarmPlaybackService.stopIfRinging(context, listOf(id))
    if (alarm != null && openApp && alarm.type == "WAKE") openWakeScreen(context, id)
  }

  /** 일정 알림의 원탭 버튼 — 기록만 남기고 알림을 지움 */
  fun acknowledge(context: Context, id: String, alarmType: String, eventType: String) {
    // 울림(TRIGGERED)이 1번이었으므로 회차는 1
    AlarmEventLog.append(context, id, alarmType, eventType, sequenceNo = 1)
    AlarmNotifications.cancelNotice(context, id)
  }

  /** JS의 cancel — 알람을 없앰(해제 기록은 남기지 않음). 울리는 중이면 멈춤 */
  fun cancel(context: Context, id: String) {
    AlarmScheduler.cancelPending(context, id)
    AlarmStorage.remove(context, id)
    AlarmNotifications.cancelNotice(context, id)
    AlarmPlaybackService.stopIfRinging(context, listOf(id))
  }

  fun cancelAll(context: Context) {
    AlarmStorage.all(context).forEach { alarm ->
      AlarmScheduler.cancelPending(context, alarm.alarmId)
      AlarmStorage.remove(context, alarm.alarmId)
      AlarmNotifications.cancelNotice(context, alarm.alarmId)
    }
    // 이미 울려서 저장소에서 지워진 일정 알림도 지움 (로그아웃 정리 뒤 남은 알림의 원탭이 기록을 쌓지 않게)
    AlarmNotifications.cancelAllNotices(context)
    AlarmPlaybackService.stop(context)
    // 지운 알람에 안 묶인 브리핑(읽다 만 출발 안내 등)까지 — 다음 계정에 남지 않게
    runCatching { VoiceBriefing.clearAll(context) }
  }

  /** JS의 stop — 지금 울리는 알람을 해제 처리 (앱이 이미 열려 있으니 앱은 안 엶) */
  fun stopRinging(context: Context) {
    val id = AlarmPlaybackService.ringingAlarmId
    if (id == null) {
      AlarmPlaybackService.stop(context)
    } else {
      dismiss(context, id, openApp = false)
    }
  }

  /**
   * JS의 getRinging — 지금 울리는 알람 (앱 H07이 그릴 값). 울리는 게 없으면 null
   * 값의 출처는 알람 화면(AlarmRingingActivity.renderAlarmControls)과 같음: 저장된 알람(StoredAlarm) + 울림 계획
   */
  fun getRinging(context: Context): Map<String, Any?>? {
    val id = AlarmPlaybackService.ringingAlarmId ?: return null
    val alarm = AlarmStorage.get(context, id) ?: return null
    return mapOf(
      "id" to alarm.alarmId,
      "type" to alarm.type,
      "title" to alarm.title,
      "subtitle" to alarm.subtitle,
      "atMillis" to alarm.atMillis.toDouble(),
      "nextRingAt" to alarm.nextRingAt.toDouble(),
      "snoozeCount" to alarm.snoozeCount,
      "snoozeLimit" to alarm.plan.snoozeLimit,
      "snoozeMinutesOptions" to (alarm.plan.snoozeMinutesOptions.takeIf { it.isNotEmpty() } ?: SnoozeRules.DEFAULT_OPTIONS),
      "departAtMillis" to alarm.departAt?.toDouble(),
      "heading" to alarm.plan.heading,
      "soundKey" to alarm.soundKey,
      "vibration" to alarm.vibration,
      "intensity" to alarm.intensity,
      // AI 음성 브리핑 문장 (지금 단계) — 음성을 못 틀어도 화면에 일정 안내가 남게. 없으면 null
      "briefingText" to VoiceBriefing.speechFor(context, alarm, System.currentTimeMillis())?.text,
    )
  }

  /** JS의 snooze — 지금 울리는 알람을 minutes분 미룸. 울리는 게 없거나 한도 · 허용 분을 넘으면 false */
  fun snoozeRinging(context: Context, minutes: Int): Boolean {
    val id = AlarmPlaybackService.ringingAlarmId ?: return false
    return snooze(context, id, minutes)
  }

  /** JS의 list — 다음 울릴 시각 순 */
  fun list(context: Context): List<Map<String, Any>> =
    AlarmStorage.all(context)
      .sortedBy { it.nextRingAt }
      .map { alarm ->
        mapOf<String, Any>(
          "id" to alarm.alarmId,
          "type" to alarm.type,
          "intensity" to alarm.intensity,
          "soundKey" to alarm.soundKey,
          "vibration" to alarm.vibration,
          "title" to alarm.title,
          "atMillis" to alarm.atMillis.toDouble(),
          "snoozeCount" to alarm.snoozeCount,
          "nextRingAt" to alarm.nextRingAt.toDouble(),
        )
      }

  /**
   * 재부팅 · 시간 변경 뒤 폰에 걸린 예약을 다시 걸음
   * 꺼져 있는 동안 시각이 지난 알람은 늦게 울리지 않고 지움 (의도한 동작).
   * 재부팅 등으로 끊긴 울림(서비스 없이 ringing만 남은 것)은 정리하고 다음 울림만 이어 감.
   * 시간만 바뀐 경우 지금 정말 울리는 중인 알람은 그대로 둠
   */
  fun restoreAll(context: Context) {
    val now = System.currentTimeMillis()
    AlarmStorage.all(context).forEach { stored ->
      val alarm = settleStaleRinging(context, stored) ?: return@forEach
      if (isActuallyRinging(alarm)) return@forEach
      if (alarm.nextRingAt <= now) {
        AlarmStorage.remove(context, alarm.alarmId)
        return@forEach
      }
      runCatching { AlarmScheduler.schedule(context, alarm) }
    }
  }

  // 저장소의 ringing은 서비스가 정리되지 못하고 죽으면(시스템 종료 · 강제 종료 · 재부팅) true로 남을 수 있음
  // 그래서 이 알람의 소리 서비스가 지금 이 프로세스에서 돌고 있는지도 함께 확인함
  private fun isActuallyRinging(alarm: StoredAlarm): Boolean =
    alarm.ringing && AlarmPlaybackService.ringingAlarmId == alarm.alarmId

  // 울림이 끊긴 찌꺼기(ringing=true인데 서비스가 없음)를 정리함. 마지막 울림이었으면 알람을 지우고(null), 아니면 걸어 둔 다시 울림만 남김
  private fun settleStaleRinging(context: Context, alarm: StoredAlarm): StoredAlarm? {
    if (!alarm.ringing || isActuallyRinging(alarm)) return alarm
    if (alarm.isLastRingOfSeries) {
      AlarmStorage.remove(context, alarm.alarmId)
      return null
    }
    val settled = alarm.copy(ringing = false)
    AlarmStorage.save(context, settled)
    return settled
  }

  // 해제 뒤 앱 열기: respecalarm://wake?alarmId=<id> (알림 · 알람 화면처럼 사용자가 누른 직후라 막히지 않음)
  private fun openWakeScreen(context: Context, alarmId: String) {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("$WAKE_LINK?alarmId=${Uri.encode(alarmId)}")).apply {
      setPackage(context.packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    runCatching { context.startActivity(intent) }
  }
}
