// 지오펜스 신호 해석 — 받은 이탈 · 진입을 출발 · 도착 판정으로 (7.13.7 · 핵심선별 A · D79)
//   상태(GeoState)는 JSON 그대로 폰에 보관 → 백그라운드에서 깰 때마다 이어 씀. 넣은 상태는 고치지 않고 새 상태를 돌려줌, 같은 입력이면 같은 결과
//   · 등록 직후 첫 신호("이미 안" ENTER · "이미 밖" EXIT)는 상태만 씀 — 도착 · 출발 아님
//   · 집 · 출발지 이탈 → 출발 후보 DEPART_PENDING(감지 안내만 바로) → 5분(T_dwell) 안에 다시 들어오면 버림 DEPART_CANCEL, 지나면 확정 DEPART
//     받는 쪽 A(JS 작업)는 타이머가 없어서 다음 신호 · 앱 열 때(resolvePending) 확정
//   · 목적지 진입 → 도착 ARRIVE. 그 참여 조건의 출발이 대기 중이면 먼저 확정 (도착했으면 나간 것)
//   · 위치로 확정한 출발 뒤 도착 전에 그 출발지(집)에 다시 들어오면 그 출발을 지움 RETRACT_DEPART → 다음 이탈을 기다림 (D79 기본안 A)
//       약속 시작 뒤 귀가는 다녀온 것으로 보고 지우지 않음 — 가까운 약속(D78)은 도착 감지가 없어 저녁 귀가가 아침 출발을 지우지 않게 (근거 없음, 작성자 판단)
//   · 판정 시각 = 신호 시각 (받는 쪽이 신호를 받은 때 — OS 전달 지연 포함, 보통 2분 · 최대 6분). 출발 = 이탈 시각, 도착 = 진입 시각 (7.13.7)
//   · 같은 신호가 다시 와도 한 번만 — 영역별 마지막 신호 시각 이전 · 같은 시각은 버리고, 이미 안인데 또 진입 · 이미 밖인데 또 이탈도 버림
//   좌표는 다루지 않음 — 영역 id · 시각만
import { attachDestEnter, attachHomeExit, attachOriginExit, type Taken } from './attach';
import { DWELL_MINUTES, INITIAL_SIGNAL_GRACE_MINUTES, KEEP_RECORD_HOURS, minutesMs } from './constants';
import type { MonitoredRegion, RegionDiff, RegionPlan } from './regions';

// 받는 쪽(expo-location 작업 · Kotlin 리시버)이 이 모양으로 바꿔 넘김. at = 신호를 받은 시각 (ms)
export type GeoSignal = { regionId: string; type: 'ENTER' | 'EXIT'; at: number };

// DEPART_PENDING  이탈 순간 — 소리 없는 감지 안내만, DB 안 씀 (at = 이탈 시각)
// DEPART_CANCEL   5분 안 재진입 — 안내 지움 (at = 그 이탈 시각)
// DEPART          출발 확정 — departed_at = at(이탈 시각), 출처 LOCATION
// ARRIVE          도착 — arrived_at = at(진입 시각), 출처 LOCATION
// RETRACT_DEPART  도착 전 귀가 — 위치로 쓴 출발 지움 (at = 지울 출발 시각. 저장된 값이 같고 출처가 LOCATION일 때만 지움)
export type GeoActionType = 'DEPART_PENDING' | 'DEPART_CANCEL' | 'DEPART' | 'ARRIVE' | 'RETRACT_DEPART';
export type GeoAction = { type: GeoActionType; participantId: string; at: number };

// inside null = 모름 (등록 직후 첫 신호 전)
export type RegionTrack = { inside: boolean | null; registeredAt: number | null; lastAt: number | null };
export type Detection = { participantId: string; at: number; appointmentAt: number };
export type DepartureDetection = Detection & { regionId: string }; // regionId = 이탈한 영역
export type VoidedDetection = Detection & { kind: 'DEPART' | 'ARRIVE' };

export type GeoState = {
  v: 1;
  regions: Record<string, RegionTrack>;
  pending: DepartureDetection[]; // 5분 대기 중인 출발 후보
  departed: DepartureDetection[]; // 위치로 확정한 출발
  arrived: Detection[]; // 위치로 잡은 도착
  voided: VoidedDetection[]; // 지운 판정 — 계획(DB를 읽은 때)에 아직 남아 있어도 없는 것으로 봄
};

export type StepResult = { state: GeoState; actions: GeoAction[] };

const DWELL_MS = minutesMs(DWELL_MINUTES);
const GRACE_MS = minutesMs(INITIAL_SIGNAL_GRACE_MINUTES);
const KEEP_MS = minutesMs(KEEP_RECORD_HOURS * 60);
const TYPE_ORDER = { EXIT: 0, ENTER: 1 } as const;

export function initialGeoState(): GeoState {
  return { v: 1, regions: {}, pending: [], departed: [], arrived: [], voided: [] };
}

function clone(state: GeoState): GeoState {
  return {
    v: 1,
    regions: Object.fromEntries(Object.entries(state.regions).map(([id, track]) => [id, { ...track }])),
    pending: state.pending.map((x) => ({ ...x })),
    departed: state.departed.map((x) => ({ ...x })),
    arrived: state.arrived.map((x) => ({ ...x })),
    voided: state.voided.map((x) => ({ ...x })),
  };
}

// 등록 · 해제를 상태에 반영 (diffRegions 결과대로 등록한 뒤) — 새로 등록한 영역은 "모름"으로 두고 첫 신호를 기다림, 해제한 영역은 잊음
export function noteRegistered(state: GeoState, diff: RegionDiff, at: number): GeoState {
  const next = clone(state);
  for (const id of diff.remove) delete next.regions[id];
  for (const region of diff.add) next.regions[region.id] = { inside: null, registeredAt: at, lastAt: null };
  return next;
}

// 사용자가 [아니에요]로 지운 판정 — 폰 기억에서도 지우고 다음 이탈 · 진입을 다시 받음 (PR6 정정 뒤 부름)
export function forgetDetection(state: GeoState, detection: VoidedDetection): GeoState {
  const next = clone(state);
  const other = (x: Detection) => x.participantId !== detection.participantId;
  if (detection.kind === 'DEPART') {
    next.pending = next.pending.filter(other);
    next.departed = next.departed.filter(other);
  } else {
    next.arrived = next.arrived.filter(other);
  }
  next.voided.push({ ...detection });
  return next;
}

function sortSignals(signals: readonly GeoSignal[]): GeoSignal[] {
  return signals
    .filter((x) => typeof x.regionId === 'string' && Number.isFinite(x.at) && (x.type === 'ENTER' || x.type === 'EXIT'))
    .sort((a, b) => a.at - b.at || (a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : 0) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
}

// 영역 상태를 갱신하고, 진짜 드나듦이면 true (첫 신호 · 중복 · 옛 신호 · 같은 상태 되풀이는 false)
function moved(state: GeoState, signal: GeoSignal, planned: boolean): boolean {
  let track = state.regions[signal.regionId];
  if (!track) {
    if (!planned) return false; // 해제한 영역 · 모르는 영역의 늦은 신호
    track = { inside: null, registeredAt: null, lastAt: null }; // 등록을 알리지 않은 영역 — 첫 신호는 상태만
    state.regions[signal.regionId] = track;
  }
  if (track.lastAt != null && signal.at <= track.lastAt) return false;
  if (track.registeredAt != null && signal.at < track.registeredAt) return false; // 이전 등록 때 신호
  const was = track.inside;
  const initial = was === null && (track.registeredAt == null || signal.at - track.registeredAt <= GRACE_MS);
  track.inside = signal.type === 'ENTER';
  track.lastAt = signal.at;
  // 등록하고 한참 뒤의 첫 신호(was null)는 첫 알림을 놓친 것 — 진짜 드나듦으로 봄
  return !initial && was !== track.inside;
}

function takenOf(state: GeoState, plan: RegionPlan): Taken {
  const voided = (kind: VoidedDetection['kind'], participantId: string, at: number) =>
    state.voided.some((v) => v.kind === kind && v.participantId === participantId && v.at === at);
  const departed = new Set<string>();
  const arrived = new Set<string>();
  for (const p of plan.participants) {
    if (p.departedAt != null && !voided('DEPART', p.participantId, p.departedAt)) departed.add(p.participantId);
    if (p.arrivedAt != null && !voided('ARRIVE', p.participantId, p.arrivedAt)) arrived.add(p.participantId);
  }
  for (const x of [...state.pending, ...state.departed]) departed.add(x.participantId);
  for (const x of state.arrived) arrived.add(x.participantId);
  return { departed, arrived };
}

function confirm(state: GeoState, pending: DepartureDetection, actions: GeoAction[]) {
  state.pending = state.pending.filter((x) => x !== pending);
  state.departed.push({ ...pending });
  actions.push({ type: 'DEPART', participantId: pending.participantId, at: pending.at });
}

// 이탈 뒤 5분이 지난 후보를 확정
function confirmDue(state: GeoState, at: number, actions: GeoAction[]) {
  for (const pending of state.pending.filter((x) => at - x.at >= DWELL_MS)) confirm(state, pending, actions);
}

function onExit(state: GeoState, region: MonitoredRegion, at: number, plan: RegionPlan, actions: GeoAction[]) {
  const taken = takenOf(state, plan);
  const participantId = region.home ? attachHomeExit(plan.participants, at, taken) : attachOriginExit(region, plan.participants, at, taken);
  const participant = plan.participants.find((p) => p.participantId === participantId);
  if (!participant) return;
  state.pending.push({ participantId: participant.participantId, regionId: region.id, at, appointmentAt: participant.appointmentAt });
  actions.push({ type: 'DEPART_PENDING', participantId: participant.participantId, at });
}

function onEnter(state: GeoState, region: MonitoredRegion, at: number, plan: RegionPlan, actions: GeoAction[]) {
  // 5분 안 재진입 — 대기 중인 출발 후보 버림
  for (const pending of state.pending.filter((x) => x.regionId === region.id)) {
    actions.push({ type: 'DEPART_CANCEL', participantId: pending.participantId, at: pending.at });
  }
  state.pending = state.pending.filter((x) => x.regionId !== region.id);

  // 도착 전 · 약속 시작 전 귀가 — 위치로 잡은 출발 지움 (D79 기본안 A)
  const { arrived } = takenOf(state, plan);
  const retracted = state.departed.filter((d) => d.regionId === region.id && at < d.appointmentAt && !arrived.has(d.participantId));
  for (const d of retracted) {
    actions.push({ type: 'RETRACT_DEPART', participantId: d.participantId, at: d.at });
    state.voided.push({ kind: 'DEPART', participantId: d.participantId, at: d.at, appointmentAt: d.appointmentAt });
  }
  state.departed = state.departed.filter((d) => !retracted.includes(d));

  for (const participantId of attachDestEnter(region, plan.participants, at, takenOf(state, plan))) {
    const participant = plan.participants.find((p) => p.participantId === participantId);
    if (!participant) continue;
    const pending = state.pending.find((x) => x.participantId === participantId);
    if (pending) confirm(state, pending, actions);
    state.arrived.push({ participantId, at, appointmentAt: participant.appointmentAt });
    actions.push({ type: 'ARRIVE', participantId, at });
  }
}

// 약속 뒤 하루가 지난 기억은 버림 (대기 중 후보는 확정될 때까지 둠)
function prune(state: GeoState, now: number) {
  const fresh = (x: Detection) => now - x.appointmentAt <= KEEP_MS;
  state.departed = state.departed.filter(fresh);
  state.arrived = state.arrived.filter(fresh);
  state.voided = state.voided.filter(fresh);
}

// 신호 묶음 해석 — 시각 순으로 보고, 신호마다 그 시각까지 5분이 지난 후보를 먼저 확정. 끝나면 now 기준으로 한 번 더
//   plan = 지금 감시 중인 계획 (planRegions 결과를 폰에 보관한 것)
export function interpretSignals(state: GeoState, signals: readonly GeoSignal[], plan: RegionPlan, now: number): StepResult {
  const next = clone(state);
  const actions: GeoAction[] = [];
  const regions = new Map(plan.regions.map((r) => [r.id, r]));
  for (const signal of sortSignals(signals)) {
    confirmDue(next, signal.at, actions);
    const region = regions.get(signal.regionId);
    if (!moved(next, signal, region != null) || !region) continue;
    if (signal.type === 'EXIT') onExit(next, region, signal.at, plan, actions);
    else onEnter(next, region, signal.at, plan, actions);
  }
  confirmDue(next, now, actions);
  prune(next, now);
  return { state: next, actions };
}

// 신호 없이 확정만 — 앱을 열 때 · 백그라운드에서 깰 때 (받는 쪽 A는 5분 타이머가 없음)
export function resolvePending(state: GeoState, now: number): StepResult {
  const next = clone(state);
  const actions: GeoAction[] = [];
  confirmDue(next, now, actions);
  prune(next, now);
  return { state: next, actions };
}
