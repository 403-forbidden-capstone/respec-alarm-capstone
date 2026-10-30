// L1 알람 계산을 그대로 부르는 곳 — 다시 만들지 않음.
//   약속 시각 · 이동 · 준비 · 여유 · 중요도 · 4주 지각 수 → computePlan(plan-core.ts) → 기상 · 준비 · 출발 · 도착 알람 + 강도
//   · 이동 시간: route.resolveTravel (직접 입력 → 카카오 → 같은 경로 실측 3건↑ 중앙값 → 좌표 근사값). 카카오는 못 부르므로
//     kakaoMinutes 를 주면 "카카오 대역"(그 분 수를 그대로 돌려줌), 안 주면 카카오 없음(KAKAO_NOT_CONFIGURED 경고) 경로
//   · 준비 시간: 기록 수 n 과 P80 (calc.predictPrepare — computePlan 안에서 부름)
//   · 강도: calc.resolveIntensity (중요도 + 최근 4주 지각 수)
// 학습 입력(stats · lateCount4w · travelSamples)은 week.ts 가 하루 기록에서 만들어 넘김.
import { calc, planCore, route } from './bridge.ts';
import { addMin } from './time.ts';
import type { AppAppt, Level, PlanSummary, Place, RingKind, Transport } from './types.ts';

export interface L1Learned {
  stats: { sampleCount: number; p80: number | null }; // v_prepare_time_stats 와 같은 모양
  lateCount4w: number;
  travelSamples: { origin: { lat: number; lng: number }; destination: { lat: number; lng: number }; transport: Transport; departedAt: string; arrivedAt: string }[];
}

export interface L1Context {
  now: Date;
  profile: { bufferMinutes: number; defaultTransport: Transport; home: Place; defaultPrepareMinutes?: number | null; wakeSensitivity?: 'HEAVY' | 'NORMAL' | null }; // defaultPrepareMinutes = 온보딩 "일어나서 나가기까지" (기상~출발 첫 값, #269)
  learned: L1Learned;
  sameDayWake: boolean; // 그날 이 약속보다 앞선 약속에 켜진 기상 알람이 있음
  kakaoMinutes: number | null; // null = 카카오 없음
  prepareBound?: { around: number; within: number }; // 반복 다음 회차: 직전 회차 준비값 ±within분 안 (alarm-roll, D62 · #269)
}

const LEVELS: Level[] = [0, 1, 2];

export async function planAppt(appt: AppAppt, ctx: L1Context): Promise<{ summary: PlanSummary; plan: unknown }> {
  const { home } = ctx.profile;
  const dest = appt.dest;
  if (!dest) throw new Error(`${appt.title}: 장소가 없어 계획을 못 만듦 (NEEDS_PLACE는 부르는 쪽이 먼저 거름)`);
  const samples = ctx.learned.travelSamples.map((s) => ({ ...s, departedAt: new Date(s.departedAt), arrivedAt: new Date(s.arrivedAt) }));
  const kakao = ctx.kakaoMinutes != null ? async () => ({ minutes: ctx.kakaoMinutes as number, partial: false }) : undefined;
  const travel = await route.resolveTravel(
    { origin: { lat: home.lat, lng: home.lng }, destination: { lat: dest.lat, lng: dest.lng }, transport: appt.transport, override: appt.overrides.travelMinutes },
    { kakao, samples: async () => samples },
  );
  if (!travel.chosen) throw new Error(`${appt.title}: 이동시간을 못 구함`);

  const manualTimes = appt.overrides.manualTimes;
  const levels = appt.overrides.levels;
  const inputs = {
    now: ctx.now,
    draft: {
      at: appt.at,
      destination: { name: dest.name, lat: dest.lat, lng: dest.lng },
      importance: appt.importance,
      origin: { name: '집', lat: home.lat, lng: home.lng },
      transport: appt.transport,
      bufferMinutes: appt.bufferMinutes,
      prepareMinutes: appt.overrides.prepareMinutes,
      ...(manualTimes ? { manualTimes } : {}),
      ...(levels ? { levels } : {}),
      ...(appt.overrides.enabled ? { enabled: appt.overrides.enabled } : {}),
    },
    profile: { timezone: 'Asia/Seoul', default_buffer_minutes: ctx.profile.bufferMinutes, default_transport: ctx.profile.defaultTransport, home_name: '집', home_lat: home.lat, home_lng: home.lng, default_prepare_minutes: ctx.profile.defaultPrepareMinutes ?? null, wake_sensitivity: ctx.profile.wakeSensitivity ?? null }, // wake_sensitivity: 지금 main 계산(computePlan)은 안 읽음 — 기능 확인 표 5b가 이 빈틈을 봄
    existingAlarms: [],
    stats: ctx.learned.stats,
    lateCount4w: ctx.learned.lateCount4w,
    sameDayWake: ctx.sameDayWake,
    ...(ctx.prepareBound ? { prepareBound: ctx.prepareBound } : {}),
  };
  const plan = planCore.computePlan(inputs, travel, 'preview');

  const checked: { kind: string; at: Date; auto?: Date; enabled: boolean }[] = plan.check.ok ? plan.check.alarms : plan.chain.map((a: { kind: string; at: Date; auto?: Date }) => ({ ...a, enabled: true }));
  const alarms = checked.map((a) => ({ kind: a.kind as PlanSummary['alarms'][number]['kind'], at: a.at as Date, enabled: a.enabled, manual: a.auto != null }));
  const wake = alarms.find((a) => a.kind === 'WAKE');
  const axes = plan.intensity.axes as Record<'sound' | 'voice' | 'vibration', { level: Level }>;
  const level = LEVELS[axes.vibration.level] as Level;
  const summary: PlanSummary = {
    apptId: appt.id,
    alarms,
    level,
    levelReason: planCore.intensityReason(plan.basics, plan.intensity),
    wakeAt: wake ? wake.at : null,
    departAt: plan.departure,
    prepareMinutes: plan.prepare.minutes,
    prepareSource: plan.prepare.source,
    prepareBasis: { common: plan.prepare.commonP80, correction: plan.prepare.correction, n: plan.prepare.sampleCount, weight: plan.prepare.weight },
    travelMinutes: plan.travelMinutes,
    travelSource: travel.chosen.source,
    withWake: plan.withWake,
    checkOk: plan.check.ok,
    checkMessage: plan.check.ok ? null : plan.check.message,
  };
  return { summary, plan };
}

// 그날 앞선 약속에 켜진 기상 알람이 있는지 — calc.hasEarlierWake (서버 · 앱 같은 함수)
export function hasEarlierWake(appt: AppAppt, sameDay: readonly AppAppt[]): boolean {
  const wakes = sameDay
    .filter((a) => a.id !== appt.id && a.saved && a.plan)
    .map((a) => ({ appointmentId: a.id, appointmentAt: a.at, isEnabled: a.plan?.alarms.find((x) => x.kind === 'WAKE')?.enabled ?? false }))
    .filter((w) => w.isEnabled);
  return calc.hasEarlierWake(appt.at, wakes, appt.id);
}

// 학습 통계 — 하루 기록의 actual_prepare_minutes(최신순) → 최근 30건 중 10~240분만 센 기록 수 · P80 (#269 calc.prepareStatsOf, 서버 plan.ts loadPrepareStats 와 같음)
export function statsFrom(minutesNewestFirst: readonly (number | null)[]): L1Learned['stats'] {
  return calc.prepareStatsOf(minutesNewestFirst);
}

// 계산 근거 한 줄 (H03) — 5건부터 "내 기록 기반 N건", 4건까지 "배우는 중 N/5"
export const prepareLabel = (n: number): string => calc.prepareSourceLabel(n) as string;

// 강도 이름 → 단계
export const LEVEL_OF_NAME: Record<'SOFT' | 'NORMAL' | 'STRONG', Level> = { SOFT: 0, NORMAL: 1, STRONG: 2 };
export const NAME_OF_LEVEL = ['약하게', '보통', '강하게'] as const;

export function alarmAt(summary: PlanSummary | null, kind: RingKind | 'ARRIVE'): Date | null {
  return summary?.alarms.find((a) => a.kind === kind)?.at ?? null;
}

export { addMin };
