package expo.modules.alarmcore

import android.app.NotificationManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AlarmCoreModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AlarmCore")

    Function("scheduleOneShot") { id: String, title: String, atMillis: Double ->
      val context = appContext.reactContext ?: return@Function
      AlarmScheduler.scheduleOneShot(context, id, title, atMillis.toLong())
    }

    Function("scheduleDaily") { id: String, title: String, hour: Int, minute: Int ->
      val context = appContext.reactContext ?: return@Function
      AlarmScheduler.scheduleDaily(context, id, title, hour, minute)
    }

    // 그 알람 · 딸린 미루기를 지우고, 그중 하나가 울리는 중일 때만 멈춤
    Function("cancel") { id: String ->
      val context = appContext.reactContext ?: return@Function
      val cancelledIds = AlarmScheduler.cancel(context, id)
      AlarmPlaybackService.stopIfRinging(context, cancelledIds)
    }

    Function("cancelAll") {
      val context = appContext.reactContext ?: return@Function null
      AlarmScheduler.cancelAll(context)
      AlarmPlaybackService.stop(context)
      null
    }

    // 다음 울릴 시각 순으로 돌려줌
    Function("getScheduledAlarms") {
      val context = appContext.reactContext ?: return@Function emptyList<Map<String, Any>>()
      AlarmStorage.all(context)
        .sortedBy { it.triggerAtMillis }
        .map { alarm ->
          mapOf<String, Any>(
            "id" to alarm.id,
            "title" to alarm.title,
            "triggerAtMillis" to alarm.triggerAtMillis.toDouble(),
            "repeat" to alarm.repeat,
            "hour" to alarm.hour,
            "minute" to alarm.minute,
          )
        }
    }

    Function("canScheduleExactAlarms") {
      val context = appContext.reactContext ?: return@Function false
      AlarmScheduler.canScheduleExactAlarms(context)
    }

    // 잠금화면 위 알람 화면에 필요함. 14 미만은 늘 허용
    Function("canUseFullScreenIntent") {
      val context = appContext.reactContext ?: return@Function false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return@Function true
      context.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()
    }

    Function("startTest") { title: String ->
      val context = appContext.reactContext ?: return@Function
      AlarmPlaybackService.start(context, "test", title)
    }

    Function("stop") {
      val context = appContext.reactContext ?: return@Function null
      AlarmPlaybackService.stop(context)
      null
    }
  }
}
