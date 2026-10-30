// 지오펜스 신호 해석 — 받은 이탈 · 진입을 출발 · 도착 판정으로 (7.13.7 · 핵심선별 A · L6 안건후보: 집 이탈 약속 붙이기)
//   상태(GeoState)는 JSON 그대로 폰에 보관 → 백그라운드에서 깰 때마다 이어 씀. 넣은 상태는 고치지 않고 새 상태를 돌려줌, 같은 입력이면 같은 결과
//     보관한 값은 parseGeoState로 읽음 (옛 모양 · 깨진 값이면 빈 상태). 아래 함수들도 받은 상태를 parseGeoState로 한 번 거름
//   · 등록 직후 첫 신호("이미 안" ENTER · "이미 밖" EXIT)는 상태만 씀 — 도착 · 출발 아님
//   · 집 · 출발지 이탈 → 출발 후보 DEPART_PENDING(감지 안내만 바로) → 5분(T_dwell) 안에 다시 들어오면 버림 DEPART_CANCEL, 지나면 확정 DEPART
//     받는 쪽 A(JS 작업)는 타이머가 없어서 다음 신호 · 앱 열 때(resolvePending) 확정
//     같은 길(그 출발지 약속의 출발이 이탈 앞뒤 30분 안에 이미 있음, 원탭 "출발했어요" 등)이면 아무 약속에도 안 붙임 — attach.ts isSameTrip
//     출발 후보는 붙일 약속(오늘 · 그 출발지에서 출발 · 아직 출발이 없음 · 창이 안 끝남 · 감지하는 약속)이 있을 때만 — 없으면 상태만 (attach.ts)
//   · 목적지 진입 → 도착 ARRIVE, 바로 확정 (지각도 바로 판정 — participantTimes). 그 참여 조건의 출발이 대기 중이면 먼저 확정 (도착했으면 나간 것)
//     500m 안 가까운 약속도 도착을 잡음 — 끄는 것은 이동시간만 (D68, regions.ts)
//   · 위치로 확정한 출발 뒤 도착 전 · 약속 시작 전에 그 출발지(집 · 집 아닌 출발지)에 다시 들어오면(귀가) DB 출발은 그대로 둠 — 그 뒤 다시 안 나가면 그게 출발
//       폰 상태에서만 그 출발을 "다음 이탈로 바뀔 수 있음"(voided)으로 두어 다음 이탈을 같은 약속에 다시 붙임 → DEPART_PENDING → DEPART
//       → participantTimes가 더 늦은 위치 출발로 바꾸고, 앞 출발의 위치 기록 줄은 '확인할 기록'으로 남음
//       7.13.7 "출발이 여러 번 잡힘 — 약속 전 마지막 출발을 진짜 출발로, 앞의 출발은 '확인할 기록'" + 지형님 10/29 흐름 확인(#240). 귀가 자체는 알림 · 기록 없음
//       약속 시작 뒤 귀가는 다녀온 것으로 보고 그대로 — 그 뒤 외출이 지난 약속의 출발을 바꾸지 않고 다음 약속에 붙게
//   · [아니에요]로 지운 판정(forgetDetection)도 voided — 다음 이탈 · 진입을 다시 받음. 5초 안에 되돌리면(undoReject) restoreDetection이 voided에서 뺌
//     (안 빼면 되돌린 값이 없는 것으로 보여, 약속 전 한 번 더 나갈 때 되돌린 출발을 더 늦은 값으로 덮음). 원탭은 자동 값이 없을 때만 대신 쓰는 길 (원탭 알림 건너뛰기는 PR 6)
//   · 판정 시각 = 신호 시각 (받는 쪽이 신호를 받은 때 — OS 전달 지연 포함, 보통 2분 · 최대 6분). 출발 = 이탈 시각, 도착 = 진입 시각 (7.13.7)
//   · 신호 거르기 — 영역별로 마지막으로 본 신호보다 이른 신호 · 같은 신호 되풀이는 버림. 같은 시각이면 이탈 → 진입 순
//       이미 안인데 또 진입은 상태만(새 정보 없음), 이미 밖인데 또 이탈은 그사이 진입을 놓친 것 → 새 이탈로 받음
//   좌표는 다루지 않음 — 영역 id · 시각만
import { attachDestEnter, attachHomeExit, attachOriginExit, isSameTrip, type KnownDeparture, type Taken } from './attach';
import { DWELL_MINUTES, INITIAL_SIGNAL_GRACE_MINUTES, KEEP_RECORD_HOURS, minutesMs } from './constants';
import type { MonitoredRegion, RegionDiff, RegionPlan, TrackedParticipant } from './regions';

// 받는 쪽(expo-location 작업 · Kotlin 리시버)이 이 모양으로 바꿔 넘김. at = 신호를 받은 시각 (ms)
export type GeoSignal = { regionId: string; type: 'ENTER' | 'EXIT'; at: number };

// DEPART_PENDING  이탈 순간 — 소리 없는 감지 안내만, DB 안 씀 (at = 이탈 시각)
// DEPART_CANCEL   5분 안 재진입 — 안내 지움 (at = 그 이탈 시각)
// DEPART          출발 확정 — departed_at = at(이탈 시각), 출처 LOCATION. 같은 약속에 위치 출발이 이미 있으면 더 늦은 쪽으로 바뀜 (participantTimes)
// ARRIVE          도착 — arrived_at = at(진입 시각), 출처 LOCATION
export type GeoActionType = 'DEPART_PENDING' | 'DEPART_CANCEL' | 'DEPART' | 'ARRIVE';
export type GeoAction = { type: GeoActionType; participantId: string; at: number };

// inside null = 모름 (등록 직후 첫 신호 전). lastAt = 마지막으로 본 신호 시각 — 있으면 inside도 앎
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
  // 없는 것으로 볼 판정 — 계획(DB를 읽은 때)에 남아 있어도 붙이기 · 같은 길 판정에서 셈하지 않음
  //   [아니에요]로 지운 판정(DB에서도 지움) · 귀가로 다음 이탈에 자리를 내준 출발(DB에는 남음 — 다음 이탈이 오면 그쪽으로 바뀜)
  voided: VoidedDetection[];
};

export type StepResult = { state: GeoState; actions: GeoAction[] };

const DWELL_MS = minutesMs(DWELL_MINUTES);
const GRACE_MS = minutesMs(INITIAL_SIGNAL_GRACE_MINUTES);
const KEEP_MS = minutesMs(KEEP_RECORD_HOURS * 60);
const TYPE_ORDER = { EXIT: 0, ENTER: 1 } as const;

export function initialGeoState(): GeoState {
  return { v: 1, regions: {}, pending: [], departed: [], arrived: [], voided: [] };
}

// ── 보관한 상태 읽기 ──
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const numOrNull = (x: unknown): number | null => (isNum(x) ? x : null);
const listOf = <T>(raw: unknown, parse: (x: unknown) => T | null): T[] => (Array.isArray(raw) ? raw.map(parse).filter((x): x is T => x != null) : []);

function parseTrack(raw: unknown): RegionTrack | null {
  if (!isRecord(raw)) return null;
  const inside = typeof raw.inside === 'boolean' ? raw.inside : null;
  return { inside, registeredAt: numOrNull(raw.registeredAt), lastAt: inside == null ? null : numOrNull(raw.lastAt) };
}

function parseDetection(raw: unknown): Detection | null {
  if (!isRecord(raw) || typeof raw.participantId !== 'string' || !isNum(raw.at) || !isNum(raw.appointmentAt)) return null;
  return { participantId: raw.participantId, at: raw.at, appointmentAt: raw.appointmentAt };
}

function parseDeparture(raw: unknown): DepartureDetection | null {
  const base = parseDetection(raw);
  if (!base || !isRecord(raw) || typeof raw.regionId !== 'string') return null;
  return { ...base, regionId: raw.regionId };
}

function parseVoided(raw: unknown): VoidedDetection | null {
  const base = parseDetection(raw);
  if (!base || !isRecord(raw) || (raw.kind !== 'DEPART' && raw.kind !== 'ARRIVE')) return null;
  return { ...base, kind: raw.kind };
}

// 폰에 보관한 값(JSON.parse 결과)을 상태로 — 비었거나 깨졌거나 모르는 판(v)이면 빈 상태, v1은 빠진 칸을 채우고 모양이 틀린 항목은 뺌
//   늘 새 객체를 돌려줌 (넣은 값은 안 고침)
export function parseGeoState(raw: unknown): GeoState {
  if (!isRecord(raw) || raw.v !== 1) return initialGeoState();
  const tracks = isRecord(raw.regions) ? Object.entries(raw.regions) : [];
  const regions = Object.fromEntries(
    tracks.flatMap(([id, value]) => {
      const track = parseTrack(value);
      return track ? [[id, track] as const] : [];
    }),
  );
  return {
    v: 1,
    regions,
    pending: listOf(raw.pending, parseDeparture),
    departed: listOf(raw.departed, parseDeparture),
    arrived: listOf(raw.arrived, parseDetection),
    voided: listOf(raw.voided, parseVoided),
  };
}

// ── 상태 바꾸기 ──
const isVoided = (state: GeoState, kind: VoidedDetection['kind'], participantId: string, at: number) =>
  state.voided.some((v) => v.kind === kind && v.participantId === participantId && v.at === at);

function addVoided(state: GeoState, detection: VoidedDetection) {
  if (!isVoided(state, detection.kind, detection.participantId, detection.at)) state.voided.push({ ...detection });
}

// 등록 · 해제를 상태에 반영 (diffRegions 결과대로 등록한 뒤) — 새로 등록한 영역은 "모름"으로 두고 첫 신호를 기다림, 해제한 영역은 잊음
export function noteRegistered(state: GeoState, diff: RegionDiff, at: number): GeoState {
  const next = parseGeoState(state);
  for (const id of diff.remove) delete next.regions[id];
  for (const region of diff.add) next.regions[region.id] = { inside: null, registeredAt: at, lastAt: null };
  return next;
}

// 사용자가 [아니에요]로 지운 판정 — 폰 기억에서도 지우고 그 판정만 voided로 둠, 다음 이탈 · 진입을 다시 받아 자동으로 채움 (PR6 정정 뒤 부름). 두 번 불러도 한 번만 기록
export function forgetDetection(state: GeoState, detection: VoidedDetection): GeoState {
  const next = parseGeoState(state);
  const other = (x: Detection) => x.participantId !== detection.participantId;
  if (detection.kind === 'DEPART') {
    next.pending = next.pending.filter(other);
    next.departed = next.departed.filter(other);
  } else {
    next.arrived = next.arrived.filter(other);
  }
  addVoided(next, detection);
  return next;
}

// [아니에요]를 5초 안에 되돌렸을 때(undoReject) — 그 판정을 voided에서 뺌. DB 값이 돌아왔으니 다시 "있는 것"으로 셈 (PR6 되돌리기 뒤 부름)
//   voided만 고침: 돌아온 값은 DB를 다시 읽은 계획(planRegions)에 들어 있어 takenOf · departuresOf가 셈 — 계획을 새로 읽은 뒤 부르고, 안 읽었으면 다음 읽기까지 이탈이 새 출발로 붙을 수 있음
//   없는 판정이거나 두 번 불러도 같은 결과 (voided에 없으면 그대로)
export function restoreDetection(state: GeoState, detection: VoidedDetection): GeoState {
  const next = parseGeoState(state);
  next.voided = next.voided.filter((v) => !(v.kind === detection.kind && v.participantId === detection.participantId && v.at === detection.at));
  return next;
}

function sortSignals(signals: readonly GeoSignal[]): GeoSignal[] {
  return signals
    .filter((x) => typeof x.regionId === 'string' && Number.isFinite(x.at) && (x.type === 'ENTER' || x.type === 'EXIT'))
    .sort((a, b) => a.at - b.at || (a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : 0) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
}

// 마지막으로 본 신호 종류 — 본 신호마다 inside를 그 신호대로 쓰므로 지금 안팎과 같음
const lastTypeOf = (track: RegionTrack): GeoSignal['type'] => (track.inside ? 'ENTER' : 'EXIT');

// 영역 상태를 갱신하고, 진짜 드나듦이면 true
//   버림(false, 상태 그대로): 이전 등록 때 신호, (시각, 이탈 → 진입 순)으로 마지막으로 본 신호보다 앞이거나 같은 신호
//     — 옛 신호 · 같은 신호 되풀이. 같은 시각 이탈 뒤 진입은 받음
//   상태만(false): 등록 직후 첫 신호, 이미 안인데 또 진입
function moved(state: GeoState, signal: GeoSignal, planned: boolean): boolean {
  let track = state.regions[signal.regionId];
  if (!track) {
    if (!planned) return false; // 해제한 영역 · 모르는 영역의 늦은 신호
    track = { inside: null, registeredAt: null, lastAt: null }; // 등록을 알리지 않은 영역 — 첫 신호는 상태만
    state.regions[signal.regionId] = track;
  }
  if (track.registeredAt != null && signal.at < track.registeredAt) return false;
  if (track.lastAt != null && (signal.at < track.lastAt || (signal.at === track.lastAt && TYPE_ORDER[signal.type] <= TYPE_ORDER[lastTypeOf(track)]))) return false;
  const was = track.inside;
  const initial = was === null && (track.registeredAt == null || signal.at - track.registeredAt <= GRACE_MS);
  track.inside = signal.type === 'ENTER';
  track.lastAt = signal.at;
  if (initial) return false;
  // 이탈은 늘 받음 — 이미 밖이었으면 그사이 진입을 놓친 것. 등록하고 한참 뒤의 첫 신호(was null)도 첫 알림을 놓친 것
  return signal.type === 'EXIT' || was !== true;
}

// 판정 목록 + 감지 안 하는 약속 (붙이기 · 같은 길 판정용)
const everyone = (plan: RegionPlan): TrackedParticipant[] => [...plan.participants, ...plan.untracked];

// 이미 출발 · 도착이 있는 참여 조건 — 계획 때 DB 값(지운 것 빼고) + 위치로 잡은 것 · 대기 중인 것. 도착은 시각도 (attach.ts 출발 붙이기)
function takenOf(state: GeoState, plan: RegionPlan): Taken {
  const departed = new Set<string>();
  const arrived = new Map<string, number>();
  for (const p of everyone(plan)) {
    if (p.departedAt != null && !isVoided(state, 'DEPART', p.participantId, p.departedAt)) departed.add(p.participantId);
    if (p.arrivedAt != null && !isVoided(state, 'ARRIVE', p.participantId, p.arrivedAt)) arrived.set(p.participantId, p.arrivedAt);
  }
  for (const x of [...state.pending, ...state.departed]) departed.add(x.participantId);
  for (const x of state.arrived) arrived.set(x.participantId, x.at);
  return { departed, arrived };
}

// 이미 있는 출발 — 계획 때 DB 값(출처 무관, 지운 것 빼고) + 위치로 잡은 것 · 대기 중인 것
function departuresOf(state: GeoState, plan: RegionPlan): KnownDeparture[] {
  const recorded = everyone(plan).flatMap((p) =>
    p.departedAt != null && !isVoided(state, 'DEPART', p.participantId, p.departedAt) ? [{ participantId: p.participantId, at: p.departedAt }] : [],
  );
  return [...recorded, ...state.pending, ...state.departed];
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
  const all = everyone(plan);
  if (isSameTrip(region, all, departuresOf(state, plan), at)) return;
  const taken = takenOf(state, plan);
  const participantId = region.home ? attachHomeExit(all, at, taken) : attachOriginExit(region, plan.participants, at, taken);
  // 감지 안 하는 약속(목적지 좌표 없음)이 붙으면 판정 없이 끝 — 판정 목록에 없음
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

  // 도착 전 · 약속 시작 전 귀가 — DB 출발은 그대로, 폰에서만 다음 이탈로 바뀔 수 있게 둠 (7.13.7 약속 전 마지막 출발 · 앞 출발은 '확인할 기록')
  //   액션 없음 — DB를 안 바꾸고, 새 알림도 없음 (답에 따라 결과가 바뀌지 않으므로, 지형님 10/29 흐름 확인(#240))
  const { arrived } = takenOf(state, plan);
  const returned = state.departed.filter((d) => d.regionId === region.id && at < d.appointmentAt && !arrived.has(d.participantId));
  for (const d of returned) addVoided(state, { kind: 'DEPART', participantId: d.participantId, at: d.at, appointmentAt: d.appointmentAt });
  state.departed = state.departed.filter((d) => !returned.includes(d));

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
//   부르는 쪽이 지킬 것
//     · 보관해 둔 신호(오프라인 · 앱이 꺼진 동안 쌓인 것)와 새 신호를 한 묶음으로 합쳐 넣음 — 순서는 이 함수가 시각 순으로 맞춤
//       묶음끼리는 다시 맞추지 않음: 앞 묶음에서 본 신호보다 이른 신호가 뒤 묶음에 오면 옛 신호로 버림
//     · 상태 읽기(parseGeoState) → 이 함수 → 저장은 한 번에 하나씩 (백그라운드 작업 · 앱 화면이 겹치지 않게 차례로). 겹치면 한쪽 결과가 사라짐
export function interpretSignals(state: GeoState, signals: readonly GeoSignal[], plan: RegionPlan, now: number): StepResult {
  const next = parseGeoState(state);
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
//   보관해 둔 신호가 남아 있으면 먼저 interpretSignals로 넣은 뒤에 부름 — 그 사이 재진입을 못 본 채 출발을 확정하지 않게
//   상태 읽기 → 저장은 interpretSignals와 같이 한 번에 하나씩
export function resolvePending(state: GeoState, now: number): StepResult {
  const next = parseGeoState(state);
  const actions: GeoAction[] = [];
  confirmDue(next, now, actions);
  prune(next, now);
  return { state: next, actions };
}
