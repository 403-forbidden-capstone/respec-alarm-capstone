package expo.modules.alarmcore

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Process
import android.provider.Settings

// 기상 자동 확인용 화면 사용 읽기 (#35 · D14) — 사용 정보 접근 권한(설정에서 사용자가 켬)이 있어야 읽힘
//
// "사용 중" = 화면이 켜져 있고(SCREEN_INTERACTIVE) 잠금이 풀려 있는(KEYGUARD_HIDDEN) 동안.
//   앱 화면 전환(ACTIVITY_RESUMED · PAUSED) 대신 화면 · 잠금 이벤트를 쓴 이유:
//   - 알람을 끈 직후에는 알람 화면 때문에 화면이 켜져 있지만 잠금은 안 풀린 상태 → 이건 "폰을 썼다"가 아님.
//     잠금이 풀린 시각이 7장 7.13.8이 말한 "해제 후 첫 잠금 해제"와 맞음
//   - 어떤 앱을 쓰는지 상관없이 "폰을 만졌는지"만 봄 (앱 이름 · 사용 내용은 읽지 않음)
// 이벤트(SCREEN_*, KEYGUARD_*)는 안드로이드 9(API 28) 이상에만 있어서 그보다 낮으면 읽지 못한다고 던짐 → 앱은 "일어났어요" 버튼으로
object UsageSpans {
  // 구간 시작 전의 화면 · 잠금 상태를 알기 위해 시작보다 앞의 이벤트까지 읽음 (마지막 잠금 · 화면 꺼짐이 그 안에 있어야 함)
  private const val LOOKBACK_MILLIS = 12 * 60 * 60 * 1000L

  // 29 이상은 unsafeCheckOpNoThrow, 그 아래는 옛 함수 (옛 함수는 29에서 deprecated)
  @Suppress("DEPRECATION")
  private fun usageOpMode(context: Context): Int {
    val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
    } else {
      appOps.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
    }
  }

  fun hasAccess(context: Context): Boolean {
    val mode = usageOpMode(context)
    // 아직 사용자가 정하지 않은 상태(DEFAULT)는 매니페스트 권한 검사 결과를 따름
    if (mode == AppOpsManager.MODE_DEFAULT) {
      return context.checkCallingOrSelfPermission(android.Manifest.permission.PACKAGE_USAGE_STATS) ==
        PackageManager.PERMISSION_GRANTED
    }
    return mode == AppOpsManager.MODE_ALLOWED
  }

  // 사용 정보 접근 설정을 엶. 이 앱 항목으로 바로 가고, 안 되는 폰이면 앱 목록으로
  fun openSettings(context: Context) {
    val list = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val direct = Intent(list).setData(Uri.parse("package:${context.packageName}"))
    try {
      context.startActivity(direct)
    } catch (error: Exception) {
      context.startActivity(list)
    }
  }

  // fromMillis ~ toMillis 사이에 "사용 중"이던 구간을 시각순으로 돌려줌 (두 시각 밖은 잘림)
  fun read(context: Context, fromMillis: Long, toMillis: Long): List<Map<String, Any>> {
    require(toMillis > fromMillis) { "끝 시각이 시작 시각보다 늦어야 합니다." }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
      throw IllegalStateException("화면 사용 기록은 안드로이드 9 이상에서만 읽을 수 있습니다.")
    }
    if (!hasAccess(context)) {
      throw IllegalStateException("사용 정보 접근 권한이 허용되지 않았습니다.")
    }

    val manager = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
    val events = manager.queryEvents(fromMillis - LOOKBACK_MILLIS, toMillis) ?: return emptyList()
    val event = UsageEvents.Event()

    val spans = mutableListOf<Pair<Long, Long>>()
    fun addSpan(start: Long, end: Long) {
      val clippedStart = maxOf(start, fromMillis)
      val clippedEnd = minOf(end, toMillis)
      if (clippedEnd > clippedStart) spans.add(Pair(clippedStart, clippedEnd))
    }

    var screenOn = false
    // 잠금 상태를 한 번도 못 봤으면 알 수 없음(null) — 잠금 화면이 없는 폰은 KEYGUARD 이벤트가 없어서, 이때는 화면 켜짐만으로 봄
    var locked: Boolean? = null
    var openedAt: Long? = null

    while (events.hasNextEvent()) {
      events.getNextEvent(event)
      val wasInUse = screenOn && locked != true
      when (event.eventType) {
        UsageEvents.Event.SCREEN_INTERACTIVE -> screenOn = true
        UsageEvents.Event.SCREEN_NON_INTERACTIVE -> screenOn = false
        UsageEvents.Event.KEYGUARD_SHOWN -> locked = true
        UsageEvents.Event.KEYGUARD_HIDDEN -> locked = false
        else -> continue
      }
      val nowInUse = screenOn && locked != true
      if (!wasInUse && nowInUse) {
        openedAt = event.timeStamp
      } else if (wasInUse && !nowInUse) {
        val start = openedAt
        if (start != null) addSpan(start, event.timeStamp)
        openedAt = null
      }
    }
    // 구간이 끝나는 시각까지 아직 쓰는 중이면 그 시각까지로 침
    val lastStart = openedAt
    if (lastStart != null && screenOn && locked != true) addSpan(lastStart, toMillis)

    return spans.map { (start, end) ->
      mapOf<String, Any>("startMillis" to start.toDouble(), "endMillis" to end.toDouble())
    }
  }
}
