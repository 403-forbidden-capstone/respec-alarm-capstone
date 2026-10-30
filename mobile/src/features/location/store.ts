// 위치 감지의 폰 보관함 (AsyncStorage) — 판정 기억 · 계획 · 등록한 영역 · 아직 못 쓴 기록
//   좌표(영역 중심)는 이 폰 안에서만 둠. 서버 · 로그에는 시각 · 출처만 (7.13.7 저장 범위) — 여기서도 좌표를 로그로 남기지 않음
//   읽을 때는 깨진 값 · 옛 모양에 너그럽게(빈 값으로), 저장소 자체 오류는 던짐 — 못 읽은 걸 빈 값으로 보고 덮어쓰지 않게
//   고치는 쪽은 lock.ts의 withLock 안에서만 (읽기 → 바꾸기 → 저장이 겹치지 않게)
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { MonitoredRegion, RegionPlan, TrackedParticipant } from './regions';
import { parseGeoState, type GeoAction, type GeoState } from './transitions';

const DATA_KEYS = {
  state: 'location:v1:state', // 판정 기억 (transitions GeoState)
  plan: 'location:v1:plan', // 지금 감시 중인 계획 (RegionPlan) — 신호를 해석할 때 씀
  regions: 'location:v1:regions', // 폰 OS에 실제로 등록한 영역 — 다음 등록 때 바뀐 것만 가리려고 (diffRegions)
  actions: 'location:v1:actions', // 서버에 아직 못 쓴 기록 (DEPART · ARRIVE)
} as const;
// 자동 기록 켬 · 끔 — 로그아웃해도 그대로 둠 (꺼 둔 스위치가 다시 로그인하면 켜지지 않게). 스위치 화면은 뒤 PR
const AUTO_KEY = 'location:v1:auto';

// 서버에 쓰는 기록만 보관 (DEPART_PENDING · DEPART_CANCEL은 안내용이라 보관하지 않음)
export type WriteAction = GeoAction & { type: 'DEPART' | 'ARRIVE' };
export const isWriteAction = (action: GeoAction): action is WriteAction =>
  action.type === 'DEPART' || action.type === 'ARRIVE';

// 오래 못 쓴 기록이 끝없이 쌓이지 않게 — 넘으면 오래된 것부터 버림 (근거 없음 — 작성자 판단, 하루 한두 건이라 넉넉한 값)
export const MAX_QUEUED_ACTIONS = 100;

export const emptyPlan = (): RegionPlan => ({ regions: [], participants: [], untracked: [] });

// ── 읽기 ──
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const numOrNull = (x: unknown): number | null => (isNum(x) ? x : null);
const listOf = <T>(raw: unknown, parse: (x: unknown) => T | null): T[] => (Array.isArray(raw) ? raw.map(parse).filter((x): x is T => x != null) : []);
const stringsOf = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);

function parseRegion(raw: unknown): MonitoredRegion | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !isNum(raw.lat) || !isNum(raw.lng) || !isNum(raw.radiusM) || typeof raw.home !== 'boolean') return null;
  return { id: raw.id, lat: raw.lat, lng: raw.lng, radiusM: raw.radiusM, home: raw.home, originOf: stringsOf(raw.originOf), destOf: stringsOf(raw.destOf) };
}

function parseTracked(raw: unknown): TrackedParticipant | null {
  if (!isRecord(raw) || typeof raw.participantId !== 'string' || !isNum(raw.appointmentAt) || !isNum(raw.departAt)) return null;
  if (typeof raw.fromHome !== 'boolean' || typeof raw.near !== 'boolean') return null;
  return {
    participantId: raw.participantId,
    appointmentAt: raw.appointmentAt,
    departAt: raw.departAt,
    fromHome: raw.fromHome,
    near: raw.near,
    departedAt: numOrNull(raw.departedAt),
    arrivedAt: numOrNull(raw.arrivedAt),
  };
}

function parseAction(raw: unknown): WriteAction | null {
  if (!isRecord(raw) || typeof raw.participantId !== 'string' || !isNum(raw.at)) return null;
  const action: GeoAction = { type: raw.type as GeoAction['type'], participantId: raw.participantId, at: raw.at };
  return isWriteAction(action) ? action : null;
}

// 보관한 글자 → 값. 없거나 JSON이 깨졌으면 null (저장소 오류는 그대로 던짐)
async function readJson(key: string): Promise<unknown> {
  const text = await AsyncStorage.getItem(key);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function loadState(): Promise<GeoState> {
  return parseGeoState(await readJson(DATA_KEYS.state));
}

export async function loadPlan(): Promise<RegionPlan> {
  const raw = await readJson(DATA_KEYS.plan);
  if (!isRecord(raw)) return emptyPlan();
  return { regions: listOf(raw.regions, parseRegion), participants: listOf(raw.participants, parseTracked), untracked: listOf(raw.untracked, parseTracked) };
}

export async function loadRegions(): Promise<MonitoredRegion[]> {
  return listOf(await readJson(DATA_KEYS.regions), parseRegion);
}

export async function loadActions(): Promise<WriteAction[]> {
  return listOf(await readJson(DATA_KEYS.actions), parseAction);
}

// ── 쓰기 ──
export type Change = {
  state?: GeoState;
  plan?: RegionPlan;
  regions?: readonly MonitoredRegion[];
  append?: readonly WriteAction[]; // 쓸 기록 뒤에 더함
  actions?: readonly WriteAction[]; // 쓸 기록 통째로 바꿈 (append와 같이 못 씀)
};

// 바꿀 것을 한 번에 저장 — 상태가 앞서 나갔는데 그 상태가 만든 쓸 기록이 빠지는 일이 없게 (앱이 중간에 꺼져도)
export async function commit(change: Change): Promise<void> {
  const pairs: [string, string][] = [];
  if (change.state) pairs.push([DATA_KEYS.state, JSON.stringify(change.state)]);
  if (change.plan) pairs.push([DATA_KEYS.plan, JSON.stringify(change.plan)]);
  if (change.regions) pairs.push([DATA_KEYS.regions, JSON.stringify(change.regions)]);
  if (change.actions) {
    pairs.push([DATA_KEYS.actions, JSON.stringify(change.actions.slice(-MAX_QUEUED_ACTIONS))]);
  } else if (change.append?.length) {
    pairs.push([DATA_KEYS.actions, JSON.stringify([...(await loadActions()), ...change.append].slice(-MAX_QUEUED_ACTIONS))]);
  }
  if (pairs.length) await AsyncStorage.multiSet(pairs);
}

// 로그아웃 — 판정 기억 · 계획 · 등록 목록 · 못 쓴 기록을 지움 (다음 계정에 섞이지 않게). 자동 기록 스위치는 그대로
export async function clearLocationStore(): Promise<void> {
  await AsyncStorage.multiRemove(Object.values(DATA_KEYS));
}

// ── 자동 기록 스위치 (기본 켬) ──
export async function getLocationAuto(): Promise<boolean> {
  return (await AsyncStorage.getItem(AUTO_KEY)) !== 'false';
}

export async function setLocationAuto(on: boolean): Promise<void> {
  await AsyncStorage.setItem(AUTO_KEY, on ? 'true' : 'false');
}
