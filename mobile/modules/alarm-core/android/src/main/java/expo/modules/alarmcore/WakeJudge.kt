package expo.modules.alarmcore

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

// 기상 자동 판정 — 앱 features/alarm/wake.ts의 evaluateWake · usedMinutes · thetaReachedAt과 같은 규칙 (앱을 열지 않아도 폰이 해제 10분 뒤 스스로 판정)
//   조건 = 해제 뒤 관찰 10분이 끝났고, 누적 사용 ≥ θ 그리고 뒤쪽 5분(해제 5~10분 뒤) 사용 > 0. 확정 시각은 누적 사용이 θ를 넘은 시각 (D14)
//   TS와 같은 결과여야 해서 계산 순서까지 그대로 옮김 (소수 분 double, 시각은 마지막에 ms로 버림) — spec/wake-cases.json을 WakeJudgeTest와 앱 wake.test.ts가 같이 읽음
//   안드로이드 API를 안 써서 JVM 단위 시험으로 돎
object WakeJudge {
  const val OBSERVE_MINUTES = 10.0 // types.ts WAKE_OBSERVE_MINUTES
  const val RECENT_MINUTES = 5.0 // types.ts WAKE_RECENT_MINUTES
  const val THETA_MINUTES = 1.0 // wake.ts WAKE_THETA_MINUTES

  enum class Phase { OBSERVING, PROMPT, AUTO }

  // usage · recent = 소수 첫째 자리 (화면용, 비교에는 안 씀). reachedAtMillis = AUTO일 때 확정 시각
  data class Result(val phase: Phase, val usage: Double, val recent: Double, val reachedAtMillis: Long?)

  /** 해제 뒤 분 구간 [시작, 끝] */
  data class Span(val start: Double, val end: Double)

  // 관찰 시간(0 ~ limit분) 안으로 자르고, 시각순으로 겹치는 구간을 합침
  private fun clean(spans: List<Span>, limit: Double): List<Span> {
    val sorted = spans
      .map { Span(max(0.0, it.start), min(limit, it.end)) }
      .filter { it.end > it.start }
      .sortedBy { it.start }
    val out = mutableListOf<Span>()
    for (s in sorted) {
      val last = out.lastOrNull()
      if (last != null && s.start <= last.end) out[out.size - 1] = Span(last.start, max(last.end, s.end))
      else out.add(s)
    }
    return out
  }

  fun usedMinutes(spans: List<Span>, from: Double, to: Double): Double =
    clean(spans, to).fold(0.0) { sum, s -> sum + max(0.0, s.end - max(s.start, from)) }

  // JS Math.round(n * 10) / 10 (.5는 위로)
  private fun round1(n: Double): Double = floor(n * 10 + 0.5) / 10

  private fun addMinutes(millis: Long, minutes: Double): Long = (millis.toDouble() + minutes * 60_000).toLong()

  // 누적 사용이 θ에 닿은 시각 — 관찰 안에 못 닿으면 null
  fun thetaReachedAt(dismissedAtMillis: Long, spans: List<Span>, theta: Double): Long? {
    var used = 0.0
    for (s in clean(spans, OBSERVE_MINUTES)) {
      if (used + (s.end - s.start) >= theta) return addMinutes(dismissedAtMillis, s.start + max(0.0, theta - used))
      used += s.end - s.start
    }
    return null
  }

  /** spans가 null이면 사용 정보를 못 읽은 것(권한 없음 · 안드로이드 9 미만) → PROMPT (폰은 아무것도 안 함, 앱의 확인 알림 흐름 그대로) */
  fun evaluate(dismissedAtMillis: Long, nowMillis: Long, spans: List<Span>?, theta: Double = THETA_MINUTES): Result {
    if (spans == null) return Result(Phase.PROMPT, 0.0, 0.0, null)
    val usage = round1(usedMinutes(spans, 0.0, OBSERVE_MINUTES))
    val recent = round1(usedMinutes(spans, OBSERVE_MINUTES - RECENT_MINUTES, OBSERVE_MINUTES))
    val observeEnd = addMinutes(dismissedAtMillis, OBSERVE_MINUTES)
    if (nowMillis < observeEnd) return Result(Phase.OBSERVING, usage, recent, null)
    val met = usedMinutes(spans, 0.0, OBSERVE_MINUTES) >= theta && usedMinutes(spans, OBSERVE_MINUTES - RECENT_MINUTES, OBSERVE_MINUTES) > 0
    if (!met) return Result(Phase.PROMPT, usage, recent, null)
    return Result(Phase.AUTO, usage, recent, thetaReachedAt(dismissedAtMillis, spans, theta) ?: observeEnd)
  }

  /** 시각(epoch ms) 구간 → 해제 뒤 분 구간 (modules/alarm-core src/usage.ts toUseSpans와 같은 식) */
  fun toSpans(dismissedAtMillis: Long, millisSpans: List<Pair<Long, Long>>): List<Span> =
    millisSpans.map { (s, e) -> Span((s - dismissedAtMillis) / 60_000.0, (e - dismissedAtMillis) / 60_000.0) }
}
