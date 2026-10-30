import { describe, expect, it } from '@jest/globals';

import { MAX_REGIONS, UNKNOWN_RADIUS_M } from '../constants';
import { distanceM, toLatLng } from '../geo';
import { detectionWindow, diffRegions, HOME_REGION_ID, planRegions, plannedDepartAt, type MonitoredRegion, type ParticipantInput } from '../regions';

// 시드 좌표 (supabase/seed/data.mjs) — 집 · 세종대(캠퍼스 대표 좌표)
const HOME = { lat: 37.5445, lng: 127.056 };
const SEJONG = { lat: 37.5509, lng: 127.0736 };
const GANGNAM = { lat: 37.4979, lng: 127.0276 };
const NEAR_HOME = { lat: 37.5465, lng: 127.058 }; // 집에서 약 280m

// 5월 22일 한국 시각
const at = (hhmm: string) => Date.parse(`2025-05-22T${hhmm}:00+09:00`);

const participant = (over: Partial<ParticipantInput> = {}): ParticipantInput => ({
  participantId: 'p1',
  appointmentAt: at('09:00'),
  departAt: at('08:20'),
  dest: SEJONG,
  origin: null,
  ...over,
});

describe('거리 (하버사인)', () => {
  it('시드 집 → 세종대 약 1.7km, 같은 곳 0, 방향 상관없음', () => {
    const d = distanceM(HOME, SEJONG);
    expect(d).toBeGreaterThan(1650);
    expect(d).toBeLessThan(1750);
    expect(distanceM(HOME, HOME)).toBe(0);
    expect(distanceM(SEJONG, HOME)).toBeCloseTo(d, 6);
  });

  it('좌표는 위도 · 경도가 둘 다 있고 범위 안일 때만', () => {
    expect(toLatLng({ lat: 37.5, lng: 127 })).toEqual({ lat: 37.5, lng: 127 });
    expect(toLatLng({ lat: 37.5, lng: null })).toBeNull();
    expect(toLatLng({ lat: Number.NaN, lng: 127 })).toBeNull();
    expect(toLatLng({ lat: 95, lng: 127 })).toBeNull();
    expect(toLatLng(null)).toBeNull();
  });
});

describe('감시 목록 (planRegions)', () => {
  it('집은 약속이 없어도 늘 감시 (D68), 반경 = 칸 값 → 없으면 200m, 범위 밖이면 100~500으로', () => {
    expect(planRegions({ home: HOME, participants: [], now: at('03:00') }).regions).toEqual([
      { id: HOME_REGION_ID, ...HOME, radiusM: 200, home: true, originOf: [], destOf: [] },
    ]);
    expect(planRegions({ home: { ...HOME, radiusM: 300 }, participants: [], now: 0 }).regions[0].radiusM).toBe(300);
    expect(planRegions({ home: { ...HOME, radiusM: 50 }, participants: [], now: 0 }).regions[0].radiusM).toBe(100);
    expect(planRegions({ home: { ...HOME, radiusM: 900 }, participants: [], now: 0 }).regions[0].radiusM).toBe(500);
  });

  it('집 좌표가 없으면 집 감시 없음', () => {
    expect(planRegions({ home: { lat: null, lng: null }, participants: [], now: 0 }).regions).toEqual([]);
    expect(planRegions({ home: null, participants: [], now: 0 }).regions).toEqual([]);
  });

  it('목적지는 감시 시간창(출발 예정 60분 전 ~ 약속 60분 후) 안에서만 — 양 끝 포함', () => {
    const plan = (now: number) => planRegions({ home: HOME, participants: [participant()], now }).regions;
    expect(plan(at('07:19'))).toHaveLength(1); // 집만
    expect(plan(at('07:20'))).toHaveLength(2);
    expect(plan(at('10:00'))).toHaveLength(2);
    expect(plan(at('10:01'))).toHaveLength(1);
    const dest = plan(at('08:00'))[1];
    expect(dest).toMatchObject({ ...SEJONG, radiusM: UNKNOWN_RADIUS_M, home: false, originOf: [], destOf: ['p1'] });
  });

  it('aheadMinutes를 주면 창이 열리기 그만큼 전부터 미리 등록', () => {
    expect(planRegions({ home: HOME, participants: [participant()], now: at('06:30'), aheadMinutes: 60 }).regions).toHaveLength(2);
    expect(planRegions({ home: HOME, participants: [participant()], now: at('06:19'), aheadMinutes: 60 }).regions).toHaveLength(1);
  });

  it('출발지 좌표가 없으면 집에서 출발', () => {
    const plan = planRegions({ home: HOME, participants: [participant({ origin: { lat: null, lng: null } })], now: at('08:00') });
    expect(plan.regions.map((r) => r.destOf)).toEqual([[], ['p1']]);
    expect(plan.participants[0]).toMatchObject({ fromHome: true, near: false });
  });

  it('목적지 좌표가 없으면 그 약속은 감지하지 않음 — 집 아닌 출발지도 감시 안 함, 판정 목록 대신 untracked (7.13.7)', () => {
    const noDest = participant({ participantId: 'nodest', dest: { lat: null, lng: null }, origin: GANGNAM, departedAt: at('08:20') });
    const plan = planRegions({ home: HOME, participants: [noDest, participant({ participantId: 'home', dest: null })], now: at('08:00') });
    expect(plan.regions.map((r) => r.id)).toEqual([HOME_REGION_ID]);
    expect(plan.participants).toEqual([]);
    expect(plan.untracked.map((p) => [p.participantId, p.fromHome, p.departedAt])).toEqual([
      ['home', true, null],
      ['nodest', false, at('08:20')],
    ]);
  });

  it('출발 좌표가 없으면(집 좌표 없음 · 출발지 비움) 그 약속은 감지하지 않음 — 도착도 (7.13.7)', () => {
    const plan = planRegions({ participants: [participant({ participantId: 'noorigin' }), participant({ participantId: 'away', origin: GANGNAM })], now: at('08:00') });
    expect(plan.untracked.map((p) => p.participantId)).toEqual(['noorigin']);
    expect(plan.participants.map((p) => p.participantId)).toEqual(['away']);
    expect(plan.regions.some((r) => r.destOf.includes('noorigin'))).toBe(false);
  });

  it('저장된 출발지가 집 좌표(집 반경 안)면 집에서 출발 — 영역을 따로 만들지 않음', () => {
    const plan = planRegions({ home: HOME, participants: [participant({ origin: { lat: HOME.lat + 0.0005, lng: HOME.lng } })], now: at('08:00') });
    expect(plan.regions.filter((r) => r.originOf.length)).toEqual([]);
    expect(plan.participants[0].fromHome).toBe(true);
  });

  it('집 아닌 출발지는 창 안에서 따로 감시, 반경은 모르는 곳 기본값', () => {
    const plan = planRegions({ home: HOME, participants: [participant({ origin: GANGNAM })], now: at('08:00') });
    expect(plan.regions.map((r) => [r.originOf, r.destOf])).toEqual([
      [[], []],
      [['p1'], []],
      [[], ['p1']],
    ]);
    expect(plan.regions[1]).toMatchObject({ ...GANGNAM, radiusM: UNKNOWN_RADIUS_M });
    expect(plan.participants[0].fromHome).toBe(false);
  });

  it('집 좌표가 없어도 출발지 좌표가 있으면 그 출발지를 감시', () => {
    const plan = planRegions({ home: null, participants: [participant({ origin: GANGNAM })], now: at('08:00') });
    expect(plan.regions.map((r) => r.originOf.length + r.destOf.length)).toEqual([1, 1]);
  });

  it('출발지 ~ 목적지 500m 안이어도 목적지를 감시 — 도착 감지를 살림, near는 이동시간만 끔 (D68 · 안건후보 D78 정리)', () => {
    const plan = planRegions({ home: HOME, participants: [participant({ dest: NEAR_HOME })], now: at('08:00') });
    expect(plan.regions.map((r) => [r.id === HOME_REGION_ID, r.destOf])).toEqual([
      [true, []],
      [false, ['p1']],
    ]);
    expect(plan.participants[0]).toMatchObject({ fromHome: true, near: true });
    // 집 아닌 출발지끼리 가까워도 같음 — 출발지 · 목적지 다 감시
    const close = planRegions({ home: HOME, participants: [participant({ origin: GANGNAM, dest: { lat: GANGNAM.lat + 0.002, lng: GANGNAM.lng } })], now: at('08:00') });
    expect(close.regions.map((r) => [r.originOf, r.destOf])).toEqual([
      [[], []],
      [['p1'], []],
      [[], ['p1']],
    ]);
    expect(close.participants[0].near).toBe(true);
  });

  it('반경은 저장된 칸 값(dest_radius_m), 없으면 200m', () => {
    const plan = planRegions({ home: HOME, participants: [participant({ dest: { ...SEJONG, radiusM: 300 } })], now: at('08:00') });
    expect(plan.regions[1].radiusM).toBe(300);
  });

  it('도착이 이미 기록된 약속은 감시하지 않음, 출발만 있으면 감시', () => {
    expect(planRegions({ home: HOME, participants: [participant({ arrivedAt: at('08:50') })], now: at('09:00') }).regions).toHaveLength(1);
    expect(planRegions({ home: HOME, participants: [participant({ departedAt: at('08:20') })], now: at('08:30') }).regions).toHaveLength(2);
  });

  it('같은 좌표의 약속은 한 영역으로, 반경은 큰 쪽', () => {
    const plan = planRegions({
      home: HOME,
      participants: [participant({ participantId: 'b', appointmentAt: at('09:30'), dest: { ...SEJONG, radiusM: 150 } }), participant({ participantId: 'a', dest: { ...SEJONG, radiusM: 300 } })],
      now: at('08:00'),
    });
    expect(plan.regions).toHaveLength(2);
    expect(plan.regions[1]).toMatchObject({ radiusM: 300, destOf: ['a', 'b'] });
  });

  it(`상한 ${MAX_REGIONS}개 — 집 먼저, 나머지는 이른 약속 순`, () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      participant({ participantId: `p${String(i).padStart(2, '0')}`, appointmentAt: at('09:00') + i * 60_000, dest: { lat: 37.6 + i * 0.01, lng: 127.1 } }),
    );
    const plan = planRegions({ home: HOME, participants: [...many].reverse(), now: at('08:00') });
    expect(plan.regions).toHaveLength(MAX_REGIONS);
    expect(plan.regions[0].id).toBe(HOME_REGION_ID);
    expect(plan.regions.slice(1).map((r) => r.destOf[0])).toEqual(many.slice(0, MAX_REGIONS - 1).map((p) => p.participantId));
    expect(plan.participants).toHaveLength(25); // 붙이기용 목록은 그대로
  });

  it('같은 입력이면 같은 id — 순서가 달라도, 다시 계획해도. id는 짧고 좌표가 바뀌면 바뀜', () => {
    const list = [participant({ participantId: 'a', origin: GANGNAM }), participant({ participantId: 'b', appointmentAt: at('09:30'), dest: { lat: 37.56, lng: 127.08 } })];
    const first = planRegions({ home: HOME, participants: list, now: at('08:00') });
    const again = planRegions({ home: HOME, participants: [...list].reverse(), now: at('08:00') });
    expect(again).toEqual(first);
    for (const r of first.regions) expect(r.id.length).toBeLessThanOrEqual(13);
    const moved = planRegions({ home: HOME, participants: [participant({ dest: { lat: SEJONG.lat + 0.001, lng: SEJONG.lng } })], now: at('08:00') });
    const base = planRegions({ home: HOME, participants: [participant()], now: at('08:00') });
    expect(moved.regions[1].id).not.toBe(base.regions[1].id);
    // 참여 조건 id가 달라도 같은 곳이면 같은 id
    expect(planRegions({ home: HOME, participants: [participant({ participantId: 'z' })], now: at('08:00') }).regions[1].id).toBe(base.regions[1].id);
  });

  it('출발 예정 = 약속 − 여유 − 이동, 창 = 그 60분 전 ~ 약속 60분 후', () => {
    expect(plannedDepartAt({ appointmentAt: at('09:00'), travelMinutes: 30, bufferMinutes: 10 })).toBe(at('08:20'));
    expect(plannedDepartAt({ appointmentAt: at('09:00'), travelMinutes: null, bufferMinutes: 10 })).toBe(at('08:50'));
    expect(detectionWindow({ departAt: at('08:20'), appointmentAt: at('09:00') })).toEqual({ start: at('07:20'), end: at('10:00') });
  });
});

describe('등록 바꿀 것 (diffRegions)', () => {
  const region = (id: string, over: Partial<MonitoredRegion> = {}): MonitoredRegion => ({ id, lat: 37.5, lng: 127, radiusM: 200, home: false, originOf: [], destOf: [], ...over });

  it('같으면 아무것도 안 함, 쓰는 참여 조건만 바뀐 것도 그대로', () => {
    expect(diffRegions([region('a')], [region('a')])).toEqual({ add: [], remove: [] });
    expect(diffRegions([region('a', { destOf: ['p1'] })], [region('a', { destOf: ['p1', 'p2'] })])).toEqual({ add: [], remove: [] });
  });

  it('새 영역은 add, 빠진 영역은 remove', () => {
    expect(diffRegions([region('a'), region('b')], [region('b'), region('c')])).toEqual({ add: [region('c')], remove: ['a'] });
  });

  it('중심 · 반경이 바뀌면 지우고 다시 등록', () => {
    expect(diffRegions([region('a')], [region('a', { radiusM: 300 })])).toEqual({ add: [region('a', { radiusM: 300 })], remove: ['a'] });
    expect(diffRegions([region('a')], [region('a', { lat: 37.6 })])).toEqual({ add: [region('a', { lat: 37.6 })], remove: ['a'] });
  });
});
