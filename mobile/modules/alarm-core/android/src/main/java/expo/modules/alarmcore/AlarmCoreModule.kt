package expo.modules.alarmcore

import android.app.NotificationManager
import android.content.Context
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AlarmCoreModule : Module() {
  // 컨텍스트가 없으면 조용히 넘어가지 않고 JS 쪽 Promise를 reject함 ("예약된 줄 알았는데 안 울림" 방지)
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("AlarmCore")

    Function("scheduleOneShot") { id: String, title: String, atMillis: Double ->
      AlarmScheduler.scheduleOneShot(context, id, title, atMillis.toLong())
    }

    Function("scheduleDaily") { id: String, title: String, hour: Int, minute: Int ->
      AlarmScheduler.scheduleDaily(context, id, title, hour, minute)
    }

    // 그 알람 · 딸린 미루기를 지우고, 그중 하나가 울리는 중일 때만 멈춤
    Function("cancel") { id: String ->
      val cancelledIds = AlarmScheduler.cancel(context, id)
      AlarmPlaybackService.stopIfRinging(context, cancelledIds)
    }

    Function("cancelAll") {
      AlarmScheduler.cancelAll(context)
      AlarmPlaybackService.stop(context)
    }

    // 다음 울릴 시각 순으로 돌려줌
    Function("getScheduledAlarms") {
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
      AlarmScheduler.canScheduleExactAlarms(context)
    }

    // 잠금화면 위 알람 화면에 필요함. 14 미만은 늘 허용
    Function("canUseFullScreenIntent") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return@Function true
      context.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()
    }

    Function("startTest") { title: String ->
      AlarmPlaybackService.start(context, "test", title)
    }

    Function("stop") {
      AlarmPlaybackService.stop(context)
    }
  }
}
