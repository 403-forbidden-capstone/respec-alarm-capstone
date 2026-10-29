import { describe, expect, it } from '@jest/globals';

import { attachDestEnter, attachHomeExit, attachOriginExit, isSameTrip, type Taken } from '../attach';
import type { MonitoredRegion, TrackedParticipant } from '../regions';

// 한국 시각 (날짜 · 시각)
const kst = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+09:00`);
const at = (hhmm: string) => kst('2025-05-22', hhmm);

const tracked = (participantId: string, appointmentAt: number, over: Partial<TrackedParticipant> = {}): TrackedParticipant => ({
  participantId,
  appointmentAt,
  departAt: appointmentAt - 40 * 60_000,
  fromHome: true,
  near: false,
  departedAt: null,
  arrivedAt: null,
  ...over,
});

const none: Taken = { departed: new Set(), arrived: new Set() };
const taken = (departed: string[] = [], arrived: string[] = []): Taken => ({ departed: new Set(departed), arrived: new Set(arrived) });
const region = (over: Partial<MonitoredRegion>): MonitoredRegion => ({ id: 'r1', lat: 37.5, lng: 127, radiusM: 200, home: false, originOf: [], destOf: [], ...over });

describe('집 이탈 → 오늘 첫 약속 (L6 안건후보: 집 이탈 약속 붙이기 기본안 A)', () => {
  const morning = tracked('class', at('09:00'));
  const lunch = tracked('lunch', at('13:00'));
  const list = [lunch, morning];

  it('여러 약속이면 약속 시각이 이른 것 — 창이 열리기 한참 전 외출도 붙임', () => {
    expect(attachHomeExit(list, at('06:00'), none)).toBe('class');
    expect(attachHomeExit(list, at('08:20'), none)).toBe('class');
  });

  it('이미 출발 · 도착한 약속은 건너뜀', () => {
    expect(attachHomeExit(list, at('08:20'), taken(['class']))).toBe('lunch');
    expect(attachHomeExit(list, at('10:30'), taken([], ['class']))).toBe('lunch');
    expect(attachHomeExit(list, at('12:00'), taken(['class', 'lunch']))).toBeNull();
  });

  it('창이 끝난 약속(약속 60분 후 지남)은 건너뜀 — 끝 시각은 포함', () => {
    expect(attachHomeExit(list, at('10:00'), none)).toBe('class');
    expect(attachHomeExit(list, at('10:01'), none)).toBe('lunch');
  });

  it('집 아닌 곳에서 출발하는 약속에는 안 붙임', () => {
    expect(attachHomeExit([tracked('fromSchool', at('09:00'), { fromHome: false }), lunch], at('08:00'), none)).toBe('lunch');
  });

  it('오늘 = 한국 날짜 — 전날 밤 외출은 내일 약속에 안 붙고, 자정 넘은 외출은 그날 약속에 붙음', () => {
    expect(attachHomeExit(list, kst('2025-05-21', '23:30'), none)).toBeNull();
    expect(attachHomeExit(list, kst('2025-05-22', '00:30'), none)).toBe('class');
  });

  it('같은 시각이면 출발 예정 → id 순', () => {
    const a = tracked('a', at('09:00'), { departAt: at('08:30') });
    const b = tracked('b', at('09:00'), { departAt: at('08:00') });
    expect(attachHomeExit([a, b], at('07:00'), none)).toBe('b');
    expect(attachHomeExit([tracked('y', at('09:00')), tracked('x', at('09:00'))], at('07:00'), none)).toBe('x');
  });
});

describe('집 아닌 출발지 이탈 → 그곳에서 출발하는 약속', () => {
  const study = tracked('study', at('15:00'), { fromHome: false, departAt: at('14:30') });
  const dinner = tracked('dinner', at('18:00'), { fromHome: false, departAt: at('17:30') });
  const school = region({ originOf: ['study', 'dinner'] });

  it('창 안에서 아직 출발 안 한 첫 약속 하나', () => {
    expect(attachOriginExit(school, [dinner, study], at('14:25'), none)).toBe('study');
    expect(attachOriginExit(school, [dinner, study], at('17:00'), taken(['study']))).toBe('dinner');
  });

  it('창 밖(출발 예정 60분 전보다 이름)이면 안 붙임', () => {
    expect(attachOriginExit(school, [study], at('13:29'), none)).toBeNull();
    expect(attachOriginExit(school, [study], at('13:30'), none)).toBe('study');
  });

  it('그 출발지를 쓰지 않는 약속에는 안 붙임', () => {
    expect(attachOriginExit(region({ originOf: ['other'] }), [study], at('14:25'), none)).toBeNull();
  });
});

describe('목적지 진입 → 그곳이 목적지인 약속', () => {
  const first = tracked('first', at('10:00'));
  const second = tracked('second', at('10:30'));
  const later = tracked('later', at('15:00'));
  const hall = region({ destOf: ['first', 'second', 'later'] });

  it('창 안 · 아직 도착 안 한 것 모두 (같은 건물 연달아 있는 약속)', () => {
    expect(attachDestEnter(hall, [later, second, first], at('09:40'), none)).toEqual(['first', 'second']);
    expect(attachDestEnter(hall, [later, second, first], at('09:40'), taken([], ['first']))).toEqual(['second']);
    expect(attachDestEnter(hall, [later, second, first], at('14:00'), none)).toEqual(['later']);
  });

  it('출발 여부와 상관없이 도착은 받음, 창 밖은 안 받음', () => {
    expect(attachDestEnter(hall, [first], at('09:40'), taken(['first']))).toEqual(['first']);
    expect(attachDestEnter(hall, [first], at('08:19'), none)).toEqual([]);
  });

  it('가까운 약속(L6 안건후보: 가까운 약속 감지)은 도착 감지 안 함', () => {
    expect(attachDestEnter(hall, [tracked('first', at('10:00'), { near: true })], at('09:50'), none)).toEqual([]);
  });
});

describe('같은 길 (isSameTrip) — 그 출발지 약속의 출발이 이탈 앞뒤 30분 안에 이미 있음', () => {
  const home = region({ id: 'home', home: true });
  const morning = tracked('class', at('09:00'));
  const lunch = tracked('lunch', at('13:00'));
  const dep = (participantId: string, hhmm: string) => ({ participantId, at: at(hhmm) });

  it('집: 오늘 약속 중 출발지 = 집의 출발이 앞뒤 30분 안이면 같은 길 — 양 끝 포함', () => {
    expect(isSameTrip(home, [morning, lunch], [dep('class', '08:20')], at('08:24'))).toBe(true);
    expect(isSameTrip(home, [morning, lunch], [dep('class', '08:20')], at('08:50'))).toBe(true);
    expect(isSameTrip(home, [morning, lunch], [dep('class', '08:20')], at('08:51'))).toBe(false);
    expect(isSameTrip(home, [morning, lunch], [dep('class', '08:20')], at('07:50'))).toBe(true); // 출발을 누른 게 이탈보다 뒤
    expect(isSameTrip(home, [morning, lunch], [], at('08:24'))).toBe(false);
  });

  it('집: 집 아닌 곳에서 출발하는 약속의 출발은 안 셈', () => {
    const fromSchool = tracked('fromSchool', at('09:00'), { fromHome: false });
    expect(isSameTrip(home, [fromSchool, lunch], [dep('fromSchool', '08:20')], at('08:24'))).toBe(false);
  });

  it('집 아닌 출발지: 그곳에서 출발하는 참여 조건만', () => {
    const school = region({ originOf: ['study'] });
    const study = tracked('study', at('15:00'), { fromHome: false });
    expect(isSameTrip(school, [study, morning], [dep('study', '14:00')], at('14:10'))).toBe(true);
    expect(isSameTrip(school, [study, morning], [dep('class', '14:00')], at('14:10'))).toBe(false);
  });
});
