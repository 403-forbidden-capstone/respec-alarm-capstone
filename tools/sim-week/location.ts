// 위치 신호 만들기 + L2 판정 — day.ts 의 "진짜 움직임"(DayTruth)을 앱이 어떻게 보는지로 바꾼다.
//   진짜 움직임 → 집 이탈 · 목적지 진입 신호(실제 시각 + 감지 지연 1~6분) → L2 순수 함수가 해석:
//     planRegions(감시 목록) → noteRegistered → interpretSignals(이탈 · 진입 → 출발 · 도착, 약속 붙이기, 5분 대기, 도착 전 귀가 지움)
//     → resolvePending(앱 열 때 확정) → participantTimes.decideWrite / judgeArrival / prepareMinutesOf / mayWritePrepare (출처 규칙 · 지각 판정 · 준비 실측)
//   값(집 반경 · 목적지 반경 · 감지 지연 · 지각 경계)만 바꿔 같은 진실을 다시 읽을 수 있게 GeoParams 로 받음 (adjust-runs.ts).
import { geoConst, geoRegions, geoState, participantTimes } from './bridge.ts';
import type { DayTruth, TripTruth } from './day.ts';
import { addMin, diffMin, isoKst, kstDate } from './time.ts';
import { rngFor } from './rng.ts';
import type { DayRecord, Persona, Place, PlanSummary, TripRecord, WorldDay } from './types.ts';

export interface GeoParams {
  homeRadiusM: number;
  destRadiusM: Partial<Record<Place['kind'], number>>; // 분류별 목적지 반경 (없으면 앱 기본 defaultRadiusFor)
  delay: { mode: 'mix' } | { mode: 'fixed'; minutes: number };
  lateBoundary: 'code' | 5 | 11; // code = L2 코드 값 그대로(기본, 헤드 기준 5) · 5 = 지금 코드(judgeArrival, −2~+5분 보류) · 11 = 보류 없이 +11분 넘을 때만 지각 (constants LOCATION_HOLD_AFTER_MINUTES)
}

export const DEFAULT_GEO: GeoParams = { homeRadiusM: geoConst.HOME_RADIUS_M, destRadiusM: {}, delay: { mode: 'mix' }, lateBoundary: 'code' };

const WALK = 70; // m/분
// 현관(또는 건물 입구)에서 distM 만큼 떨어지는 데 걸리는 분 — 처음(끝) 구간은 걷기, 그 너머는 탈것
function timeToDistance(transport: string, distM: number): number {
  if (transport === 'WALK') return distM / WALK;
  if (transport === 'CAR') return distM <= 70 ? distM / WALK : 1 + (distM - 70) / 700;
  return distM <= 700 ? distM / WALK : 10 + (distM - 700) / 600;
}

interface Sig {
  regionId: string;
  type: 'ENTER' | 'EXIT';
  at: number; // 받은 시각 (ms)
  trueAt: number;
  label: string;
  tripIdx: number | null;
}

type PartState = { departedAt: number | null; departSource: 'LOCATION' | 'BUTTON' | 'MANUAL' | null; arrivedAt: number | null; arriveSource: 'LOCATION' | 'BUTTON' | 'MANUAL' | null; isLate: boolean | null; lateMinutes: number | null };

export function judgeLocationArrival(arrivedMs: number, apptMs: number, source: 'LOCATION' | 'BUTTON' | 'MANUAL', boundary: 'code' | 5 | 11): { isLate: boolean | null; lateMinutes: number | null } {
  if (boundary !== 11 || source !== 'LOCATION') return participantTimes.judgeArrival(arrivedMs, apptMs, source);
  const diff = (arrivedMs - apptMs) / 60_000;
  return diff > geoConst.LOCATION_HOLD_AFTER_MINUTES ? { isLate: true, lateMinutes: Math.round(diff) } : { isLate: false, lateMinutes: 0 };
}

export interface ObserveInput {
  persona: Persona;
  world: WorldDay;
  truth: DayTruth;
  plans: Record<string, PlanSummary | undefined>; // 앱에 저장된 약속 (월드 약속 id → 계획)
  params: GeoParams;
  seed?: string;
}

export interface Observation {
  trips: TripRecord[];
  wakeRecordedAt: string;
  wakeSource: 'USAGE' | 'BUTTON';
  actualPrepareMinutes: number | null;
  oneTapCount: number;
  misjudgeCount: number;
  oneTap: string[];
}

export function observeDay(input: ObserveInput): Observation {
  const { world, truth, params } = input;
  const seed = input.seed ?? 'sim';
  const rs = rngFor(seed, truth.personaId, truth.date, 'delay');
  const delayMin = () => (params.delay.mode === 'fixed' ? params.delay.minutes : Math.min(6, Math.max(1, rs.gauss(2.6, 1.6))));
  const T = (s: string) => new Date(s).getTime();
  const ms = (m: number) => m * 60_000;

  const tripsT = truth.trips;
  const tracked = tripsT.filter((t) => t.tracked);
  const apptOf = (id: string) => world.appts.find((a) => a.id === id)!;

  // ---- 감시 목록 (앱이 아는 약속만) ----
  const homePlace = world.home;
  const participants = tracked.map((t) => {
    const a = apptOf(t.worldApptId);
    return {
      participantId: t.worldApptId,
      appointmentAt: T(t.apptAt),
      departAt: T(t.plannedDepartAt as string),
      dest: { lat: a.place.lat, lng: a.place.lng, radiusM: params.destRadiusM[a.place.kind] ?? a.place.radiusM },
      origin: null,
    };
  });
  const times = [T(truth.dismissAt), ...tripsT.flatMap((t) => [T(t.leaveHomeAt), t.falseStart ? T(t.falseStart.startAt) : Infinity])].filter(Number.isFinite);
  const regAt = Math.min(...times) - ms(90);
  const plan = geoRegions.planRegions({ home: { lat: homePlace.lat, lng: homePlace.lng, radiusM: params.homeRadiusM }, participants, now: regAt, aheadMinutes: 24 * 60 });
  let state = geoState.noteRegistered(geoState.initialGeoState(), geoRegions.diffRegions([], plan.regions), regAt);
  const destRegionOf = (pid: string): string | null => plan.regions.find((r: { destOf: string[] }) => r.destOf.includes(pid))?.id ?? null;
  const nearOf = (pid: string): boolean => plan.participants.find((p: { participantId: string }) => p.participantId === pid)?.near ?? false;

  // ---- 신호 만들기 ----
  const sigs: Sig[] = [];
  const push = (regionId: string, type: 'ENTER' | 'EXIT', trueAtMs: number, label: string, tripIdx: number | null, extraDelay = 0) =>
    sigs.push({ regionId, type, trueAt: trueAtMs, at: Math.round(trueAtMs + ms(delayMin() + extraDelay)), label, tripIdx });

  push('home', 'ENTER', regAt, '등록 직후 이미 안', null); // 등록하면 OS가 "이미 안" 알림을 줌 (L2: 첫 신호는 상태만)
  const R = params.homeRadiusM;
  tripsT.forEach((t, idx) => {
    const a = apptOf(t.worldApptId);
    const f = Math.max(0.6, t.exitWalkMin / 2.1);
    const outT = (r: number) => timeToDistance(a.transport, r) * f;
    // 집 근처 왕복 (편의점 · 조깅 · 쓰레기) — 반경 밖으로 나가야 신호가 생김
    for (const ex of t.excursions) {
      const s = T(ex.startAt);
      const e = T(ex.endAt);
      const reach = Math.min(ex.maxDistanceM, (ms(1) * 0 + ((e - s) / 60_000 / 2) * (ex.kind === 'JOG' ? 150 : WALK)));
      if (reach > R) {
        const sp = ex.kind === 'JOG' ? 150 : WALK;
        push('home', 'EXIT', s + ms(R / sp), `${ex.kind} 집 이탈`, idx);
        push('home', 'ENTER', e - ms(R / sp), `${ex.kind} 집 복귀`, idx);
      }
    }
    if (t.falseStart && t.fromHome) {
      push('home', 'EXIT', T(t.falseStart.startAt) + ms(outT(R)), '도착 전 귀가: 첫 이탈', idx);
      push('home', 'ENTER', T(t.falseStart.backAt) - ms(outT(R)), '도착 전 귀가: 집 복귀', idx);
    }
    if (t.fromHome) {
      const exitAt = T(t.leaveHomeAt) + ms(outT(R));
      push('home', 'EXIT', exitAt, '집 이탈', idx);
      if (truth.situation === 'SUBWAY_DUP') sigs.push({ ...sigs[sigs.length - 1], label: '집 이탈 (같은 신호 한 번 더)' });
    }
    const destId = destRegionOf(t.worldApptId);
    if (t.tracked && destId) {
      const rad = params.destRadiusM[a.place.kind] ?? a.place.radiusM;
      const before = timeToDistance(a.transport, rad + t.buildingOffsetM);
      push(destId, 'ENTER', T(t.arriveAt) - ms(before), '목적지 진입', idx);
      if (truth.situation === 'SUBWAY_DUP') push(destId, 'ENTER', T(t.arriveAt) - ms(before) + ms(2), '목적지 진입 (끊김 뒤 다시 한 번)', idx);
    }
    if (t.returnHomeAt) push('home', 'ENTER', T(t.returnHomeAt) - ms(outT(R)), '귀가', idx);
  });
  sigs.sort((x, y) => x.at - y.at);

  // ---- 해석 · 기록 쓰기 ----
  const recs: Record<string, PartState> = Object.fromEntries(tracked.map((t) => [t.worldApptId, { departedAt: null, departSource: null, arrivedAt: null, arriveSource: null, isLate: null, lateMinutes: null } as PartState]));
  const wakeAuto = truth.wakeAutoDetected;
  const wakeRecordedAt = wakeAuto ? truth.wakeDetectedAt : truth.getUpAt;
  const wakeMs = T(wakeRecordedAt);
  const schedWakeMs = truth.alarmWakeAt ? T(truth.alarmWakeAt) : null;
  let prepMin: number | null = null;
  let prepFromDepartMs: number | null = null;
  const actionLog: { type: string; at: number; pid: string }[] = [];
  const oneTap: string[] = [];

  const writePrepare = (departedMs: number, previousMs: number | null) => {
    const minutes = participantTimes.prepareMinutesOf(departedMs, wakeMs, schedWakeMs);
    if (minutes == null) return;
    const prev = previousMs == null ? null : participantTimes.prepareMinutesOf(previousMs, wakeMs, schedWakeMs);
    if (participantTimes.mayWritePrepare(prepMin, prev) && prepMin !== minutes) {
      prepMin = minutes;
      prepFromDepartMs = departedMs;
    }
  };
  const apply = (actions: { type: string; participantId: string; at: number }[]) => {
    for (const ac of actions) {
      actionLog.push({ type: ac.type, at: ac.at, pid: ac.participantId });
      const rec = recs[ac.participantId];
      const a = apptOf(ac.participantId);
      if (!rec) continue;
      if (ac.type === 'DEPART') {
        if (participantTimes.decideWrite('LOCATION', { present: rec.departedAt != null, byResponse: rec.departSource === 'BUTTON' || rec.departSource === 'MANUAL' }) === 'new') {
          rec.departedAt = ac.at;
          rec.departSource = 'LOCATION';
          writePrepare(ac.at, null);
        }
      } else if (ac.type === 'ARRIVE') {
        if (participantTimes.decideWrite('LOCATION', { present: rec.arrivedAt != null, byResponse: false }) === 'new') {
          rec.arrivedAt = ac.at;
          rec.arriveSource = 'LOCATION';
          const j = judgeLocationArrival(ac.at, a.at.getTime(), 'LOCATION', params.lateBoundary);
          rec.isLate = j.isLate;
          rec.lateMinutes = j.lateMinutes;
        }
      } else if (ac.type === 'RETRACT_DEPART') {
        if (rec.departedAt === ac.at && rec.departSource === 'LOCATION') {
          rec.departedAt = null;
          rec.departSource = null;
        }
      }
    }
  };
  const sigRows: Record<number, TripRecord['signals']> = {};
  const actRows: Record<string, TripRecord['actions']> = {};
  for (const s of sigs) {
    const res = geoState.interpretSignals(state, [{ regionId: s.regionId, type: s.type, at: s.at }], plan, s.at);
    state = res.state;
    apply(res.actions);
    if (s.tripIdx != null) (sigRows[s.tripIdx] ??= []).push({ regionId: s.regionId, type: s.type, at: isoKst(new Date(s.at)), label: s.label });
    for (const ac of res.actions) (actRows[ac.participantId] ??= []).push({ type: ac.type, at: isoKst(new Date(ac.at)) });
  }
  const night = kstDate(truth.date, '21:00').getTime();
  const tick = geoState.resolvePending(state, night);
  state = tick.state;
  apply(tick.actions);
  for (const ac of tick.actions) (actRows[ac.participantId] ??= []).push({ type: `${ac.type}(앱 열 때)`, at: isoKst(new Date(ac.at)) });

  // ---- 오판 · 원탭 · 원탭 응답 ----
  const tap = rngFor(seed, truth.personaId, truth.date, 'tap');
  const tapProb = input.persona.flow?.conversation.tap_prob ?? 0.7;
  const tripRecords: TripRecord[] = tripsT.map((t, idx) => {
    const rec = recs[t.worldApptId];
    const a = apptOf(t.worldApptId);
    const trueDepartExit = T(t.leaveHomeAt);
    const misjudge: string[] = [];
    const taps: string[] = [];
    const note: string[] = [];
    if (!rec) {
      note.push('앱에 저장되지 않은 약속 — 위치 판정 없음');
      return {
        apptId: t.worldApptId, title: t.title, apptAt: t.apptAt, trueDepart: t.leaveHomeAt, trueArrive: t.arriveAt, trueLateMin: t.trulyLateMin, trulyLate: t.trulyLate,
        recordedDepart: null, departSource: null, recordedArrive: null, arriveSource: null, isLate: null, lateMinutes: null, near: false,
        signals: sigRows[idx] ?? [], actions: [], misjudge: ['UNTRACKED'], oneTap: [], alarmWake: t.plannedWakeAt, note,
      };
    }
    const near = nearOf(t.worldApptId);
    // 앱 혼자 판정한 결과 기준 오판
    const wrongDepart = rec.departedAt != null && !t.fromHome ? 'DEPART_FALSE' : rec.departedAt != null && Math.abs(rec.departedAt - trueDepartExit) > ms(10) ? 'DEPART_FALSE' : null;
    if (t.fromHome && rec.departedAt == null) misjudge.push('DEPART_MISSED');
    if (!t.fromHome) {
      misjudge.push('DEPART_MISSED');
      note.push('앞 약속 자리에서 바로 이동 — 앱은 집에서 출발한다고 알아 집 이탈이 없음');
    }
    if (wrongDepart) misjudge.push(wrongDepart);
    if (rec.arrivedAt == null) misjudge.push('ARRIVE_MISSED');
    else if (rec.arrivedAt < T(t.arriveAt) - ms(5)) misjudge.push('ARRIVE_EARLY');
    if (t.trulyLate && rec.isLate !== true) misjudge.push('LATE_MISSED');
    if (!t.trulyLate && rec.isLate === true) misjudge.push('LATE_FALSE');
    if (near) note.push('출발지~목적지 500m 안: 도착 감지 꺼짐');

    // 원탭이 필요했던 일 (사람이 눌러야 맞아지는 것)
    if (rec.departedAt == null) taps.push('DEPART_MISSING');
    if (wrongDepart) taps.push('DEPART_WRONG');
    if (rec.arrivedAt == null) taps.push('ARRIVE_MISSING');
    else if (rec.isLate === null) taps.push('ARRIVE_HOLD');
    const record: TripRecord = {
      apptId: t.worldApptId, title: t.title, apptAt: t.apptAt, trueDepart: t.leaveHomeAt, trueArrive: t.arriveAt, trueLateMin: t.trulyLateMin, trulyLate: t.trulyLate,
      recordedDepart: rec.departedAt != null ? isoKst(new Date(rec.departedAt)) : null, departSource: rec.departSource,
      recordedArrive: rec.arrivedAt != null ? isoKst(new Date(rec.arrivedAt)) : null, arriveSource: rec.arriveSource,
      isLate: rec.isLate, lateMinutes: rec.lateMinutes, near,
      signals: sigRows[idx] ?? [], actions: actRows[t.worldApptId] ?? [], misjudge, oneTap: taps, alarmWake: t.plannedWakeAt, note,
    };
    // 사람이 원탭에 응함 (tap_prob) — 응답은 위치보다 우선 (decideWrite 가 override)
    if (taps.length && tap.chance(tapProb)) {
      if (taps.includes('DEPART_MISSING') || taps.includes('DEPART_WRONG')) {
        const old = rec.departedAt;
        const at = trueDepartExit + ms(1);
        if (participantTimes.decideWrite('BUTTON', { present: old != null, byResponse: false }) !== 'keep') {
          rec.departedAt = at;
          rec.departSource = 'BUTTON';
          writePrepare(at, old);
        }
      }
      if (taps.includes('ARRIVE_MISSING') || taps.includes('ARRIVE_HOLD')) {
        rec.arrivedAt = T(t.arriveAt) + ms(1);
        rec.arriveSource = 'BUTTON';
        const j = judgeLocationArrival(rec.arrivedAt, a.at.getTime(), 'BUTTON', params.lateBoundary);
        rec.isLate = j.isLate;
        rec.lateMinutes = j.lateMinutes;
      }
      record.recordedDepart = rec.departedAt != null ? isoKst(new Date(rec.departedAt)) : null;
      record.departSource = rec.departSource;
      record.recordedArrive = rec.arrivedAt != null ? isoKst(new Date(rec.arrivedAt)) : null;
      record.arriveSource = rec.arriveSource;
      record.isLate = rec.isLate;
      record.lateMinutes = rec.lateMinutes;
      record.note.push(`원탭 응답: ${taps.join(', ')}`);
    }
    return record;
  });

  if (!wakeAuto) oneTap.push('WAKE_CONFIRM');
  for (const r of tripRecords) for (const x of r.oneTap) oneTap.push(`${r.title}:${x}`);
  void prepFromDepartMs;
  return {
    trips: tripRecords,
    wakeRecordedAt,
    wakeSource: wakeAuto ? 'USAGE' : 'BUTTON',
    actualPrepareMinutes: prepMin,
    oneTapCount: oneTap.length,
    misjudgeCount: tripRecords.reduce((n, r) => n + r.misjudge.filter((m) => m !== 'UNTRACKED').length, 0),
    oneTap,
  };
}

export function toDayRecord(world: WorldDay, truth: DayTruth, obs: Observation, plans: Record<string, PlanSummary | undefined>): DayRecord {
  const first = world.appts[0];
  const plan = first ? plans[first.id] : undefined;
  return {
    personaId: truth.personaId,
    day: truth.day,
    date: truth.date,
    weekday: truth.weekday,
    situation: world.situation,
    alarmWakeAt: truth.alarmWakeAt,
    alarmLevel: (plan?.level as 0 | 1 | 2 | undefined) ?? null,
    alarmOk: truth.alarmWakeAt != null,
    snoozes: truth.snoozes,
    getUpAt: truth.getUpAt,
    wakeRecordedAt: obs.wakeRecordedAt,
    wakeSource: obs.wakeSource,
    wakeConfirmed: obs.wakeSource === 'BUTTON',
    prepActual: truth.prepMin,
    actualPrepareMinutes: obs.actualPrepareMinutes,
    trips: obs.trips,
    late: obs.trips.some((t) => t.trulyLate),
    appLate: obs.trips.some((t) => t.isLate === true),
    oneTapCount: obs.oneTapCount,
    misjudgeCount: obs.misjudgeCount,
  };
}

export { addMin, diffMin };
