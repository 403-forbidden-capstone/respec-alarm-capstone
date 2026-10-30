// 앱이 기억하는 것 — 가상 사용자가 쓴 앱 한 대의 상태 (저장한 약속 · 하루 기록 · 서버 질문 기록).
//   진짜 세계(day.ts)는 여기 없음. 앱은 밤 대화로 일정을 받아 저장하고, 아침 기록(위치 · 원탭)과 정정으로만 배움.
import { calc, participantTimes } from './bridge.ts';
import { statsFrom, type L1Learned } from './l1.ts';
import { kstDate, MIN } from './time.ts';
import type { AppAppt, DayRecord, Persona, PlanSummary, WorldDay } from './types.ts';

export interface AskedQuestion {
  kind: string;
  subject_key: string;
  asked_at: string; // ISO
}

export interface AppState {
  persona: Persona;
  seed: string;
  onboardingPrepare: number; // 온보딩 "일어나서 나가기까지 보통 몇 분?" 답 (기상~출발 첫 값)
  worlds: WorldDay[]; // 지나온 날의 세계 (index = 날 번호 0부터)
  saved: Record<string, AppAppt>; // 저장한 약속 (월드 약속 id → 앱 약속, plan 들어 있음)
  records: DayRecord[]; // 지나온 날의 기록 (정정 반영)
  asked: AskedQuestion[]; // 서버 질문 기록 (하루 1 · 주 3 예산 검사)
}

// 온보딩 답 = 인물이 스스로 어림하는 준비 시간(prep_minutes)을 5분 단위로 — DECISIONS 21
export const onboardingPrepareOf = (p: Persona): number => Math.max(5, Math.round(p.prep_minutes / 5) * 5);

export function newAppState(persona: Persona, seed: string, onboardingPrepare?: number): AppState {
  return { persona, seed, onboardingPrepare: onboardingPrepare ?? onboardingPrepareOf(persona), worlds: [], saved: {}, records: [], asked: [] };
}

// 약속에 저장된 계획
export const planOf = (app: AppState, worldApptId: string): PlanSummary | undefined => app.saved[worldApptId]?.plan ?? undefined;

// 그날 약속들의 계획 (월드 약속 id → 계획)
export function plansFor(app: AppState, world: WorldDay): Record<string, PlanSummary | undefined> {
  return Object.fromEntries(world.appts.map((a) => [a.id, planOf(app, a.id)]));
}

// 학습 입력 — 지금까지 기록에서 만든 통계 · 4주 지각 수 · 같은 길 이동 실측
export function learnedAt(app: AppState, now: Date): L1Learned {
  const newestFirst = [...app.records].reverse().map((r) => r.actualPrepareMinutes);
  const stats = statsFrom(newestFirst);
  const since = now.getTime() - 28 * 24 * 60 * MIN;
  let lateCount4w = 0;
  const travelSamples: L1Learned['travelSamples'] = [];
  app.records.forEach((rec, i) => {
    const world = app.worlds[i];
    if (!world) return;
    for (const t of rec.trips) {
      const arrivedMs = t.recordedArrive ? Date.parse(t.recordedArrive) : NaN;
      if (t.isLate === true && Number.isFinite(arrivedMs) && arrivedMs >= since) lateCount4w++;
      // 이동 실측 — 출발 · 도착이 둘 다 있고 집에서 출발한 약속만 (actual_travel_minutes, participantTimes.travelMinutesOf)
      const a = world.appts.find((x) => x.id === t.apptId);
      const plan = planOf(app, t.apptId);
      if (!a || !plan || !t.recordedDepart || !t.recordedArrive || !t.departSource || !t.arriveSource) continue;
      const home = world.home;
      const minutes = participantTimes.travelMinutesOf({
        departedAtMs: Date.parse(t.recordedDepart),
        arrivedAtMs: arrivedMs,
        departedSource: t.departSource,
        arrivedSource: t.arriveSource,
        origin: { lat: home.lat, lng: home.lng },
        dest: { lat: a.place.lat, lng: a.place.lng },
        departAtMs: plan.departAt.getTime(),
        appointmentAtMs: a.at.getTime(),
      });
      if (minutes == null) continue;
      const departedAt = new Date(t.recordedDepart);
      travelSamples.push({ origin: { lat: home.lat, lng: home.lng }, destination: { lat: a.place.lat, lng: a.place.lng }, transport: a.transport, departedAt: departedAt.toISOString(), arrivedAt: new Date(departedAt.getTime() + minutes * MIN).toISOString() });
    }
  });
  return { stats, lateCount4w, travelSamples };
}

// 사람의 기상 알람 요약 한 줄 (보고서용)
export const prepareLabelOf = (n: number): string => calc.prepareSourceLabel(n) as string;
export { kstDate };
