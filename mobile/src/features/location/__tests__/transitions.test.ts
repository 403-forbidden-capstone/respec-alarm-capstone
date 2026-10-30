import { describe, expect, it } from '@jest/globals';

import { diffRegions, HOME_REGION_ID, planRegions, type ParticipantInput, type RegionPlan } from '../regions';
import {
  forgetDetection,
  initialGeoState,
  interpretSignals,
  noteRegistered,
  parseGeoState,
  resolvePending,
  restoreDetection,
  type GeoAction,
  type GeoSignal,
  type GeoState,
} from '../transitions';

const HOME = { lat: 37.5445, lng: 127.056 };
const SEJONG_HALL = { lat: 37.5502, lng: 127.0731 }; // 세종대 안 건물 (시험용)
const CAFE = { lat: 37.54, lng: 127.07 };
const NEAR_HOME = { lat: 37.5465, lng: 127.058 }; // 집에서 약 280m
const GANGNAM = { lat: 37.4979, lng: 127.0276 };

const at = (hhmm: string) => Date.parse(`2025-05-22T${hhmm}:00+09:00`);
const sig = (regionId: string, type: GeoSignal['type'], hhmm: string): GeoSignal => ({ regionId, type, at: at(hhmm) });

const CLASS: ParticipantInput = { participantId: 'class', appointmentAt: at('09:00'), departAt: at('08:20'), dest: SEJONG_HALL, origin: null };
const LUNCH: ParticipantInput = { participantId: 'lunch', appointmentAt: at('13:00'), departAt: at('12:30'), dest: CAFE, origin: null };

const PLAN = planRegions({ home: HOME, participants: [CLASS, LUNCH], now: at('08:00') });
const DEST = PLAN.regions.find((r) => r.destOf.includes('class'))!.id;

// 06:00에 등록, 06:01에 첫 신호(집 안 · 목적지 밖)를 받은 상태
function booted(plan: RegionPlan = PLAN): GeoState {
  const registered = noteRegistered(initialGeoState(), diffRegions([], plan.regions), at('06:00'));
  const first = plan.regions.map((r) => ({ regionId: r.id, type: r.home ? 'ENTER' : 'EXIT', at: at('06:01') }) as GeoSignal);
  return interpretSignals(registered, first, plan, at('06:01')).state;
}

// 신호를 차례로 넣고 나온 판정을 모음 — [신호들, now] 한 묶음씩
function run(state: GeoState, steps: [GeoSignal[], string][], plan: RegionPlan = PLAN) {
  const actions: GeoAction[] = [];
  let current = state;
  for (const [signals, now] of steps) {
    const result = interpretSignals(current, signals, plan, at(now));
    actions.push(...result.actions);
    current = result.state;
  }
  return { state: current, actions };
}

const act = (type: string, participantId: string, hhmm: string) => ({ type, participantId, at: at(hhmm) });

describe('등록 직후 첫 신호 ("이미 안 · 밖")', () => {
  it('상태만 씀 — 도착 · 출발 아님', () => {
    const registered = noteRegistered(initialGeoState(), diffRegions([], PLAN.regions), at('07:30'));
    const result = interpretSignals(registered, [sig(HOME_REGION_ID, 'EXIT', '07:31'), sig(DEST, 'ENTER', '07:31')], PLAN, at('07:31'));
    expect(result.actions).toEqual([]);
    expect(result.state.regions[HOME_REGION_ID].inside).toBe(false);
    expect(result.state.regions[DEST].inside).toBe(true);
  });

  it('다시 등록하면(바뀐 영역) 또 오는 "이미 안"도 상태만', () => {
    const moved = { ...PLAN, regions: PLAN.regions.map((r) => (r.home ? { ...r, radiusM: 300 } : r)) };
    const diff = diffRegions(PLAN.regions, moved.regions);
    expect(diff.remove).toEqual([HOME_REGION_ID]);
    const again = noteRegistered(booted(), diff, at('07:00'));
    expect(again.regions[HOME_REGION_ID]).toEqual({ inside: null, registeredAt: at('07:00'), lastAt: null });
    expect(interpretSignals(again, [sig(HOME_REGION_ID, 'ENTER', '07:01')], moved, at('07:01')).actions).toEqual([]);
  });

  it('첫 신호를 놓쳐 등록하고 10분 넘게 지나 온 신호는 진짜 드나듦', () => {
    const registered = noteRegistered(initialGeoState(), diffRegions([], PLAN.regions), at('08:00'));
    expect(interpretSignals(registered, [sig(DEST, 'ENTER', '08:05')], PLAN, at('08:05')).actions).toEqual([]);
    expect(interpretSignals(registered, [sig(DEST, 'ENTER', '08:45')], PLAN, at('08:45')).actions).toEqual([act('ARRIVE', 'class', '08:45')]);
  });

  it('등록을 알리지 않은 영역의 첫 신호는 상태만, 계획에 없는 영역 신호는 버림', () => {
    const result = interpretSignals(initialGeoState(), [sig(HOME_REGION_ID, 'EXIT', '08:10'), sig('rnope', 'ENTER', '08:11')], PLAN, at('08:11'));
    expect(result.actions).toEqual([]);
    expect(result.state.regions[HOME_REGION_ID].inside).toBe(false);
    expect(result.state.regions.rnope).toBeUndefined();
  });

  it('등록 전 시각의 신호(이전 등록 때 것)는 버림', () => {
    const registered = noteRegistered(booted(), { add: PLAN.regions.slice(0, 1), remove: [HOME_REGION_ID] }, at('08:00'));
    expect(interpretSignals(registered, [sig(HOME_REGION_ID, 'EXIT', '07:59')], PLAN, at('08:01')).state.regions[HOME_REGION_ID].inside).toBeNull();
  });
});

describe('출발 — 5분 대기 (T_dwell)', () => {
  it('이탈 순간 후보 안내, 5분 안에 다시 들어오면 버림', () => {
    const { actions } = run(booted(), [
      [[sig(HOME_REGION_ID, 'EXIT', '08:10')], '08:10'],
      [[sig(HOME_REGION_ID, 'ENTER', '08:14')], '08:14'],
    ]);
    expect(actions).toEqual([act('DEPART_PENDING', 'class', '08:10'), act('DEPART_CANCEL', 'class', '08:10')]);
  });

  it('5분이 지나면 앱 열 때(resolvePending) 확정 — 출발 시각은 이탈 시각, 한 번만', () => {
    const pending = run(booted(), [[[sig(HOME_REGION_ID, 'EXIT', '08:10')], '08:10']]).state;
    expect(resolvePending(pending, at('08:15') - 1).actions).toEqual([]);
    const confirmed = resolvePending(pending, at('08:15'));
    expect(confirmed.actions).toEqual([act('DEPART', 'class', '08:10')]);
    expect(resolvePending(confirmed.state, at('08:30')).actions).toEqual([]);
  });

  it('다음 신호가 오면 그 시각 기준으로 먼저 확정한 뒤 신호를 봄 (목적지 진입 → 출발 · 도착)', () => {
    const { actions } = run(booted(), [
      [[sig(HOME_REGION_ID, 'EXIT', '08:10')], '08:10'],
      [[sig(DEST, 'ENTER', '08:45')], '08:45'],
    ]);
    expect(actions).toEqual([act('DEPART_PENDING', 'class', '08:10'), act('DEPART', 'class', '08:10'), act('ARRIVE', 'class', '08:45')]);
  });

  it('5분 안에 목적지에 들어오면 출발도 바로 확정', () => {
    const { actions } = run(booted(), [[[sig(HOME_REGION_ID, 'EXIT', '08:10'), sig(DEST, 'ENTER', '08:13')], '08:13']]);
    expect(actions).toEqual([act('DEPART_PENDING', 'class', '08:10'), act('DEPART', 'class', '08:10'), act('ARRIVE', 'class', '08:13')]);
  });

  it('붙일 약속이 없는 외출은 상태만', () => {
    const evening = run(booted(), [[[sig(HOME_REGION_ID, 'EXIT', '21:00')], '21:00']]);
    expect(evening.actions).toEqual([]);
    expect(evening.state.regions[HOME_REGION_ID].inside).toBe(false);
  });
});

describe('집 이탈 출발 감지 안내(DEPART_PENDING)는 붙일 약속이 있을 때만', () => {
  it('약속 없는 날 집 이탈 → 액션 없음 (다른 날 약속에도 안 붙음)', () => {
    const empty = planRegions({ home: HOME, participants: [], now: at('08:00') });
    expect(run(booted(empty), [[[sig(HOME_REGION_ID, 'EXIT', '08:10')], '08:20']], empty).actions).toEqual([]);
    const tomorrow = planRegions({ home: HOME, participants: [{ ...CLASS, appointmentAt: CLASS.appointmentAt + 24 * 3_600_000, departAt: CLASS.departAt + 24 * 3_600_000 }], now: at('08:00') });
    expect(run(booted(tomorrow), [[[sig(HOME_REGION_ID, 'EXIT', '08:10')], '08:20']], tomorrow).actions).toEqual([]);
  });

  it('오늘 약속이 이미 도착(출발 · 도착 다 있음)이면 액션 없음', () => {
    const done = planRegions({ home: HOME, participants: [{ ...CLASS, departedAt: at('08:10'), arrivedAt: at('08:45') }], now: at('09:30') });
    expect(run(booted(done), [[[sig(HOME_REGION_ID, 'EXIT', '09:30')], '09:40']], done).actions).toEqual([]);
  });

  it('도착만 있고 한참 뒤(30분 넘게) 나간 외출도 그 약속에 안 붙음 — 다음 약속이 없으면 액션 없음', () => {
    const arrivedOnly = planRegions({ home: HOME, participants: [{ ...CLASS, arrivedAt: at('08:45') }], now: at('09:30') });
    expect(run(booted(arrivedOnly), [[[sig(HOME_REGION_ID, 'EXIT', '09:16')], '09:30']], arrivedOnly).actions).toEqual([]);
  });
});

describe("도착 전 귀가 → DB 출발은 그대로, 다음 이탈이 오면 그쪽으로 (7.13.7 약속 전 마지막 출발 · 앞 출발은 '확인할 기록')", () => {
  it('확정된 출발 뒤 도착 전에 집에 들어오면 액션 없음(지우지 않음), 다음 이탈을 같은 약속에 다시 붙임', () => {
    const { actions, state } = run(booted(), [
      [[sig(HOME_REGION_ID, 'EXIT', '07:00')], '07:10'],
      [[sig(HOME_REGION_ID, 'ENTER', '07:40')], '07:40'],
      [[sig(HOME_REGION_ID, 'EXIT', '08:20')], '08:20'],
      [[sig(DEST, 'ENTER', '08:50')], '08:50'],
    ]);
    expect(actions).toEqual([
      act('DEPART_PENDING', 'class', '07:00'),
      act('DEPART', 'class', '07:00'),
      act('DEPART_PENDING', 'class', '08:20'),
      act('DEPART', 'class', '08:20'), // participantTimes가 더 늦은 위치 출발로 바꿈
      act('ARRIVE', 'class', '08:50'),
    ]);
    expect(state.departed.map((d) => d.at)).toEqual([at('08:20')]);
  });

  it('귀가 뒤 다시 안 나가면 그 출발이 그대로 출발 — 액션 없음', () => {
    const { actions, state } = run(booted(), [
      [[sig(HOME_REGION_ID, 'EXIT', '07:00')], '07:10'],
      [[sig(HOME_REGION_ID, 'ENTER', '07:40')], '09:30'],
    ]);
    expect(actions).toEqual([act('DEPART_PENDING', 'class', '07:00'), act('DEPART', 'class', '07:00')]);
    expect(state.voided).toEqual([{ kind: 'DEPART', participantId: 'class', at: at('07:00'), appointmentAt: at('09:00') }]);
  });

  it('계획(DB를 읽은 때)에 그 출발이 남아 있어도(DB는 그대로) 다음 이탈을 다시 붙임 — 같은 길로도 안 셈', () => {
    const first = run(booted(), [
      [[sig(HOME_REGION_ID, 'EXIT', '07:00')], '07:10'],
      [[sig(HOME_REGION_ID, 'ENTER', '07:20')], '07:20'],
    ]);
    const stale = planRegions({ home: HOME, participants: [{ ...CLASS, departedAt: at('07:00') }, LUNCH], now: at('07:25') });
    // 07:00 출발과 30분 안이지만 같은 길이 아님 — 귀가로 자리를 내준 출발
    expect(run(first.state, [[[sig(HOME_REGION_ID, 'EXIT', '07:25')], '07:30']], stale).actions).toEqual([act('DEPART_PENDING', 'class', '07:25'), act('DEPART', 'class', '07:25')]);
  });

  it('도착 뒤 귀가는 지우지 않음, 다음 외출은 다음 약속에', () => {
    const { actions } = run(booted(), [
      [[sig(HOME_REGION_ID, 'EXIT', '08:10')], '08:10'],
      [[sig(DEST, 'ENTER', '08:45')], '08:45'],
      [[sig(DEST, 'EXIT', '08:55'), sig(HOME_REGION_ID, 'ENTER', '08:58')], '08:58'],
      [[sig(HOME_REGION_ID, 'EXIT', '12:30')], '12:30'],
    ]);
    expect(actions).toEqual([
      act('DEPART_PENDING', 'class', '08:10'),
      act('DEPART', 'class', '08:10'),
      act('ARRIVE', 'class', '08:45'),
      act('DEPART_PENDING', 'lunch', '12:30'),
    ]);
  });

  it('약속 시작 뒤 귀가는 그대로 — 그 뒤 외출은 지난 약속의 출발을 바꾸지 않고 다음 약속에', () => {
    const { actions, state } = run(booted(), [
      [[sig(HOME_REGION_ID, 'EXIT', '08:10')], '08:20'],
      [[sig(HOME_REGION_ID, 'ENTER', '09:05')], '09:05'], // 약속(9:00) 시작 뒤 귀가 — 도착 감지는 놓침
      [[sig(HOME_REGION_ID, 'EXIT', '12:30')], '12:30'],
    ]);
    expect(actions).toEqual([act('DEPART_PENDING', 'class', '08:10'), act('DEPART', 'class', '08:10'), act('DEPART_PENDING', 'lunch', '12:30')]);
    expect(state.voided).toEqual([]);
  });

  it('[아니에요]로 지운 출발(forgetDetection)은 그 판정만 voided — 다음 이탈을 다시 받아 새 출발로 확정', () => {
    const confirmed = run(booted(), [[[sig(HOME_REGION_ID, 'EXIT', '07:00')], '07:10']]).state;
    const forgotten = forgetDetection(confirmed, { kind: 'DEPART', participantId: 'class', at: at('07:00'), appointmentAt: at('09:00') });
    expect(forgotten.departed).toEqual([]);
    expect(forgotten.voided).toEqual([{ kind: 'DEPART', participantId: 'class', at: at('07:00'), appointmentAt: at('09:00') }]);
    const { actions } = run(forgotten, [
      [[sig(HOME_REGION_ID, 'ENTER', '07:30')], '07:30'],
      [[sig(HOME_REGION_ID, 'EXIT', '08:20')], '08:25'],
    ]);
    expect(actions).toEqual([act('DEPART_PENDING', 'class', '08:20'), act('DEPART', 'class', '08:20')]);
  });

  it('[아니에요]로 지운 도착(forgetDetection)은 그 판정만 voided — 다시 진입하면 새 ARRIVE, 출발은 그대로', () => {
    const arrived = run(booted(), [
      [[sig(HOME_REGION_ID, 'EXIT', '08:10')], '08:10'],
      [[sig(DEST, 'ENTER', '08:45')], '08:45'],
    ]).state;
    const forgotten = forgetDetection(arrived, { kind: 'ARRIVE', participantId: 'class', at: at('08:45'), appointmentAt: at('09:00') });
    expect(forgotten.arrived).toEqual([]);
    expect(forgotten.voided).toEqual([{ kind: 'ARRIVE', participantId: 'class', at: at('08:45'), appointmentAt: at('09:00') }]);
    expect(forgotten.departed.map((d) => d.participantId)).toEqual(['class']);
    const { actions } = run(forgotten, [[[sig(DEST, 'EXIT', '08:47'), sig(DEST, 'ENTER', '08:50')], '08:50']]);
    expect(actions).toEqual([act('ARRIVE', 'class', '08:50')]);
  });

  it('[아니에요]로 지운 도착이 계획(DB를 읽은 때)에 남아 있어도 다시 진입하면 새 ARRIVE', () => {
    const arrived = run(booted(), [
      [[sig(HOME_REGION_ID, 'EXIT', '08:10')], '08:10'],
      [[sig(DEST, 'ENTER', '08:45')], '08:45'],
    ]).state;
    const forgotten = forgetDetection(arrived, { kind: 'ARRIVE', participantId: 'class', at: at('08:45'), appointmentAt: at('09:00') });
    const stale = { ...PLAN, participants: PLAN.participants.map((p) => (p.participantId === 'class' ? { ...p, departedAt: at('08:10'), arrivedAt: at('08:45') } : p)) };
    expect(run(forgotten, [[[sig(DEST, 'EXIT', '08:47'), sig(DEST, 'ENTER', '08:50')], '08:50']], stale).actions).toEqual([act('ARRIVE', 'class', '08:50')]);
  });

  it('같은 판정을 두 번 지워도 지운 기록은 하나', () => {
    const detection = { kind: 'DEPART' as const, participantId: 'class', at: at('07:00'), appointmentAt: at('09:00') };
    const twice = forgetDetection(forgetDetection(booted(), detection), detection);
    expect(twice.voided).toEqual([detection]);
  });
});

describe('[아니에요] 되돌리기 (restoreDetection)', () => {
  const detection = { kind: 'DEPART' as const, participantId: 'class', at: at('07:00'), appointmentAt: at('09:00') };
  // 07:00 출발을 [아니에요]로 지웠다 5초 안에 되돌려 DB 출발이 돌아온 뒤 다시 읽은 계획
  const classOnly = (departedAt?: number) => planRegions({ home: HOME, participants: [{ ...CLASS, departedAt }], now: at('07:50') });

  it('forgetDetection → restoreDetection — 이후 약속 전 한 번 더 나가도 이미 출발이 있어 새 DEPART를 안 냄', () => {
    const plan = classOnly(at('07:00'));
    const confirmed = run(booted(plan), [[[sig(HOME_REGION_ID, 'EXIT', '07:00')], '07:10']], plan).state;
    const forgotten = forgetDetection(confirmed, detection);
    const restored = restoreDetection(forgotten, detection);
    expect(restored.voided).toEqual([]);

    // 지운 채로는 되돌린 출발이 없는 것으로 보여 약속 전 외출이 다시 붙음 (이 시험이 막으려는 것)
    expect(run(forgotten, [[[sig(HOME_REGION_ID, 'EXIT', '08:00')], '08:10']], plan).actions).toEqual([act('DEPART_PENDING', 'class', '08:00'), act('DEPART', 'class', '08:00')]);
    // 되돌렸으면 이미 출발이 있음 — 이탈은 아무 약속에도 안 붙음
    expect(run(restored, [[[sig(HOME_REGION_ID, 'EXIT', '08:00')], '08:10']], plan).actions).toEqual([]);
  });

  it('두 번 불러도 · 없는 판정이어도 같은 결과, 다른 항목은 그대로, 넣은 상태는 안 고침', () => {
    const other = { kind: 'ARRIVE' as const, participantId: 'class', at: at('08:45'), appointmentAt: at('09:00') };
    const both = forgetDetection(forgetDetection(booted(), detection), other);
    const once = restoreDetection(both, detection);
    expect(once.voided).toEqual([other]);
    expect(restoreDetection(once, detection)).toEqual(once);
    expect(both.voided).toHaveLength(2);
    expect(restoreDetection(booted(), detection)).toEqual(booted());
  });

  it('보관한 값이 깨졌으면 parseGeoState처럼 거름', () => {
    expect(restoreDetection({ v: 2 } as unknown as GeoState, detection)).toEqual(initialGeoState());
    const dirty = { ...booted(), voided: [detection, { kind: 'OTHER', participantId: 'x', at: 1, appointmentAt: 2 }] } as unknown as GeoState;
    expect(restoreDetection(dirty, detection).voided).toEqual([]);
  });
});

describe('원탭 출발 뒤 이탈 — 같은 길 (앞뒤 30분)', () => {
  it('원탭 출발(08:20) 뒤 08:24 집 이탈은 아무 약속에도 안 붙음 — 다음 약속에 안 감', () => {
    const plan = planRegions({ home: HOME, participants: [{ ...CLASS, departedAt: at('08:20') }, LUNCH], now: at('08:00') });
    expect(run(booted(plan), [[[sig(HOME_REGION_ID, 'EXIT', '08:24')], '08:30']], plan).actions).toEqual([]);
    // 30분이 넘으면 다른 외출 — 오늘 다음 약속에
    expect(run(booted(plan), [[[sig(HOME_REGION_ID, 'EXIT', '08:51')], '08:51']], plan).actions).toEqual([act('DEPART_PENDING', 'lunch', '08:51')]);
  });

  it('이탈보다 뒤에 누른 원탭 출발도 같은 길 (쌓아 둔 신호를 늦게 넣을 때)', () => {
    const plan = planRegions({ home: HOME, participants: [{ ...CLASS, departedAt: at('08:30') }, LUNCH], now: at('08:40') });
    expect(run(booted(plan), [[[sig(HOME_REGION_ID, 'EXIT', '08:24')], '08:40']], plan).actions).toEqual([]);
  });

  it('집 아닌 출발지도 같음 — 그곳에서 출발하는 다른 약속에 안 붙음', () => {
    const first: ParticipantInput = { participantId: 'study', appointmentAt: at('15:00'), departAt: at('14:00'), dest: SEJONG_HALL, origin: GANGNAM, departedAt: at('14:00') };
    const second: ParticipantInput = { participantId: 'club', appointmentAt: at('16:00'), departAt: at('15:00'), dest: SEJONG_HALL, origin: GANGNAM };
    const plan = planRegions({ home: HOME, participants: [first, second], now: at('14:00') });
    const ORIGIN = plan.regions.find((r) => r.originOf.includes('club'))!.id;
    expect(run(booted(plan), [[[sig(ORIGIN, 'ENTER', '13:00')], '13:00'], [[sig(ORIGIN, 'EXIT', '14:10')], '14:20']], plan).actions).toEqual([]);
  });
});

describe('목적지 좌표 없는 약속 — 감지하지 않음 (7.13.7)', () => {
  const noDest: ParticipantInput = { ...CLASS, dest: { lat: null, lng: null } };

  it('그 약속에 출발을 붙이지 않고, 그 약속 몫의 집 이탈이 다음 약속에도 안 붙음', () => {
    const plan = planRegions({ home: HOME, participants: [noDest, LUNCH], now: at('08:00') });
    const { actions } = run(booted(plan), [
      [[sig(HOME_REGION_ID, 'EXIT', '08:20')], '08:30'],
      [[sig(HOME_REGION_ID, 'ENTER', '11:00')], '11:00'],
      [[sig(HOME_REGION_ID, 'EXIT', '12:30')], '12:30'], // 그 약속 창(10:00)이 끝난 뒤 외출은 다음 약속에
    ], plan);
    expect(actions).toEqual([act('DEPART_PENDING', 'lunch', '12:30')]);
  });

  it('그 약속에 누른 원탭 출발도 같은 길로 셈', () => {
    const plan = planRegions({ home: HOME, participants: [{ ...noDest, departedAt: at('08:20') }, LUNCH], now: at('08:00') });
    expect(run(booted(plan), [[[sig(HOME_REGION_ID, 'EXIT', '08:24')], '08:30']], plan).actions).toEqual([]);
  });
});

describe('집 아닌 출발지', () => {
  const study: ParticipantInput = { participantId: 'study', appointmentAt: at('15:00'), departAt: at('14:00'), dest: SEJONG_HALL, origin: GANGNAM };
  const plan = planRegions({ home: HOME, participants: [study], now: at('14:00') });
  const ORIGIN = plan.regions.find((r) => r.originOf.includes('study'))!.id;

  it('출발지 이탈 → 그 약속의 출발, 5분 안 재진입은 버림', () => {
    const state = booted(plan);
    expect(run(state, [[[sig(ORIGIN, 'ENTER', '13:00')], '13:00'], [[sig(ORIGIN, 'EXIT', '14:05')], '14:20']], plan).actions).toEqual([
      act('DEPART_PENDING', 'study', '14:05'),
      act('DEPART', 'study', '14:05'),
    ]);
    expect(run(state, [[[sig(ORIGIN, 'ENTER', '13:00')], '13:00'], [[sig(ORIGIN, 'EXIT', '14:05'), sig(ORIGIN, 'ENTER', '14:08')], '14:20']], plan).actions).toEqual([
      act('DEPART_PENDING', 'study', '14:05'),
      act('DEPART_CANCEL', 'study', '14:05'),
    ]);
  });

  it('확정된 출발 뒤 약속 시작 전 · 도착 전에 출발지에 다시 들어오면 그대로 두고, 다음 이탈을 새 출발로 (7.13.7 약속 전 마지막 출발)', () => {
    const steps: [GeoSignal[], string][] = [
      [[sig(ORIGIN, 'ENTER', '13:00')], '13:00'],
      [[sig(ORIGIN, 'EXIT', '14:05')], '14:20'],
      [[sig(ORIGIN, 'ENTER', '14:30')], '14:30'],
      [[sig(ORIGIN, 'EXIT', '14:40')], '14:50'],
    ];
    expect(run(booted(plan), steps, plan).actions).toEqual([
      act('DEPART_PENDING', 'study', '14:05'),
      act('DEPART', 'study', '14:05'),
      act('DEPART_PENDING', 'study', '14:40'),
      act('DEPART', 'study', '14:40'),
    ]);
  });

  it('집 이탈은 집 아닌 곳에서 출발하는 약속에 안 붙음', () => {
    expect(run(booted(plan), [[[sig(HOME_REGION_ID, 'EXIT', '13:00')], '13:30']], plan).actions).toEqual([]);
  });
});

describe('중복 · 재전달 · 같은 입력 같은 결과', () => {
  const exit = sig(HOME_REGION_ID, 'EXIT', '08:10');

  it('같은 신호가 묶음 안에 두 번 와도 한 번만', () => {
    expect(run(booted(), [[[exit, { ...exit }], '08:10']]).actions).toEqual([act('DEPART_PENDING', 'class', '08:10')]);
  });

  it('조금 늦게 또 온 이탈(이미 밖)은 새 이탈이지만 같은 길이라 판정 없음, 마지막 신호보다 이른 옛 신호는 버림', () => {
    const first = run(booted(), [[[exit], '08:10']]);
    expect(run(first.state, [[[sig(HOME_REGION_ID, 'EXIT', '08:11')], '08:11']]).actions).toEqual([]);
    expect(run(first.state, [[[sig(HOME_REGION_ID, 'ENTER', '08:09')], '08:12']]).actions).toEqual([]);
  });

  it('같은 시각 이탈 → 진입은 둘 다 봄 — 후보 안내 뒤 바로 버림, 섞여 와도 같음, 다시 넣으면 판정 없음', () => {
    const batch = [sig(HOME_REGION_ID, 'ENTER', '08:10'), exit];
    const first = interpretSignals(booted(), batch, PLAN, at('08:10'));
    expect(first.actions).toEqual([act('DEPART_PENDING', 'class', '08:10'), act('DEPART_CANCEL', 'class', '08:10')]);
    expect(first.state.regions[HOME_REGION_ID].inside).toBe(true);
    expect(interpretSignals(booted(), [...batch].reverse(), PLAN, at('08:10'))).toEqual(first);
    const again = interpretSignals(first.state, batch, PLAN, at('08:10'));
    expect(again.actions).toEqual([]);
    expect(again.state).toEqual(first.state);
  });

  it('이탈을 본 뒤 다음 묶음에 같은 시각 진입이 와도 받음, 같은 이탈은 버림', () => {
    const { actions } = run(booted(), [
      [[exit], '08:10'],
      [[{ ...exit }, sig(HOME_REGION_ID, 'ENTER', '08:10')], '08:12'],
    ]);
    expect(actions).toEqual([act('DEPART_PENDING', 'class', '08:10'), act('DEPART_CANCEL', 'class', '08:10')]);
  });

  it('이미 밖인데 또 온 이탈 = 그사이 진입을 놓친 것 → 새 이탈로 받음', () => {
    const registered = noteRegistered(initialGeoState(), diffRegions([], PLAN.regions), at('06:00'));
    const outside = interpretSignals(registered, [sig(HOME_REGION_ID, 'EXIT', '06:01')], PLAN, at('06:01')).state; // 등록 때 이미 밖
    expect(outside.regions[HOME_REGION_ID].inside).toBe(false);
    expect(interpretSignals(outside, [sig(HOME_REGION_ID, 'EXIT', '08:20')], PLAN, at('08:20')).actions).toEqual([act('DEPART_PENDING', 'class', '08:20')]);
  });

  it('이미 안인데 또 온 진입은 상태만 — 도착을 두 번 쓰지 않음', () => {
    const { actions, state } = run(booted(), [
      [[sig(HOME_REGION_ID, 'ENTER', '07:00')], '07:00'],
      [[sig(DEST, 'ENTER', '08:45')], '08:45'],
      [[sig(DEST, 'ENTER', '08:50')], '08:50'],
    ]);
    expect(actions).toEqual([act('ARRIVE', 'class', '08:45')]);
    expect(state.regions[DEST]).toMatchObject({ inside: true, lastAt: at('08:50') });
  });

  it('처리한 묶음을 다시 넣으면 판정 없음 · 상태 그대로', () => {
    const signals = [exit, sig(DEST, 'ENTER', '08:45')];
    const first = interpretSignals(booted(), signals, PLAN, at('08:45'));
    const again = interpretSignals(first.state, signals, PLAN, at('08:45'));
    expect(again.actions).toEqual([]);
    expect(again.state).toEqual(first.state);
  });

  it('같은 상태 · 같은 신호면 같은 결과, 넣은 상태는 고치지 않음 · 순서가 섞여 와도 시각 순', () => {
    const state = booted();
    const snapshot = JSON.parse(JSON.stringify(state));
    const signals = [sig(DEST, 'ENTER', '08:45'), exit];
    const a = interpretSignals(state, signals, PLAN, at('08:45'));
    const b = interpretSignals(state, [...signals].reverse(), PLAN, at('08:45'));
    expect(a).toEqual(b);
    expect(a.actions.map((x) => x.type)).toEqual(['DEPART_PENDING', 'DEPART', 'ARRIVE']);
    expect(state).toEqual(snapshot);
    // 상태는 JSON으로 보관해도 그대로
    expect(JSON.parse(JSON.stringify(a.state))).toEqual(a.state);
  });

  it('약속 뒤 하루가 지나면 출발 · 도착 기억을 버림', () => {
    const done = run(booted(), [
      [[exit], '08:10'],
      [[sig(DEST, 'ENTER', '08:45')], '08:45'],
    ]).state;
    expect(done.departed).toHaveLength(1);
    const nextDay = resolvePending(done, at('09:00') + 24 * 60 * 60_000 + 1).state;
    expect([nextDay.departed, nextDay.arrived]).toEqual([[], []]);
  });
});

describe('500m 안 가까운 약속 — 도착도 감지, 끄는 것은 이동시간만 (D68 · 안건후보 D78 정리)', () => {
  const near: ParticipantInput = { participantId: 'near', appointmentAt: at('09:00'), departAt: at('08:50'), dest: NEAR_HOME, origin: null };
  const plan = planRegions({ home: HOME, participants: [near, LUNCH], now: at('08:00') });
  const NEAR_DEST = plan.regions.find((r) => r.destOf.includes('near'))!.id;

  it('집 이탈 → 출발, 목적지 진입 → 도착', () => {
    const { actions } = run(booted(plan), [
      [[sig(HOME_REGION_ID, 'EXIT', '08:50')], '08:50'],
      [[sig(NEAR_DEST, 'ENTER', '08:58')], '08:58'],
    ], plan);
    expect(actions).toEqual([act('DEPART_PENDING', 'near', '08:50'), act('DEPART', 'near', '08:50'), act('ARRIVE', 'near', '08:58')]);
  });

  it('반경이 겹쳐(또는 신호가 늦어) 목적지 진입이 집 이탈보다 먼저 와도 그 이탈은 그 약속의 출발 — 점심 약속에 안 감', () => {
    const { actions } = run(booted(plan), [
      [[sig(NEAR_DEST, 'ENTER', '08:52')], '08:52'],
      [[sig(HOME_REGION_ID, 'EXIT', '08:54')], '09:00'],
    ], plan);
    expect(actions).toEqual([act('ARRIVE', 'near', '08:52'), act('DEPART_PENDING', 'near', '08:54'), act('DEPART', 'near', '08:54')]);
  });
});

describe('보관한 상태 읽기 (parseGeoState)', () => {
  const departed = { participantId: 'class', regionId: HOME_REGION_ID, at: at('07:00'), appointmentAt: at('09:00') };
  // voided 칸이 없는 v1 값
  const old = { v: 1, regions: { [HOME_REGION_ID]: { inside: false, registeredAt: at('06:00'), lastAt: at('07:00') } }, pending: [], departed: [departed], arrived: [] };

  it('v1인데 빠진 칸은 채움, 넣은 값은 안 고침', () => {
    const parsed = parseGeoState(JSON.parse(JSON.stringify(old)));
    expect(parsed).toEqual({ ...old, voided: [] });
    expect(old).not.toHaveProperty('voided');
    // 읽은 상태로 바로 이어 씀 — 도착 전 귀가는 액션 없이 다음 이탈로 바뀔 수 있게 둠
    const back = interpretSignals(parsed, [sig(HOME_REGION_ID, 'ENTER', '07:40')], PLAN, at('07:40'));
    expect(back.actions).toEqual([]);
    expect(back.state.voided).toEqual([{ kind: 'DEPART', participantId: 'class', at: at('07:00'), appointmentAt: at('09:00') }]);
  });

  it('비었거나 깨졌거나 모르는 판이면 빈 상태', () => {
    for (const raw of [null, undefined, 'garbage', JSON.stringify(old), 42, [], { v: 99, regions: {} }, { v: '1' }]) {
      expect(parseGeoState(raw)).toEqual(initialGeoState());
    }
  });

  it('모양이 틀린 항목은 뺌 — 안팎을 모르면 마지막 신호 시각도 버림', () => {
    const raw = {
      v: 1,
      regions: { a: 'x', b: { inside: 'yes', registeredAt: 5, lastAt: 9 }, c: { inside: true, registeredAt: null, lastAt: 9 } },
      pending: [{ participantId: 1, at: 0, appointmentAt: 0, regionId: 'a' }, { ...departed, regionId: undefined }],
      departed: 'nope',
      arrived: [{ participantId: 'class', at: Number.NaN, appointmentAt: 0 }],
      voided: [{ ...departed, kind: 'OTHER' }, { ...departed, kind: 'ARRIVE' }],
    };
    expect(parseGeoState(raw)).toEqual({
      v: 1,
      regions: { b: { inside: null, registeredAt: 5, lastAt: null }, c: { inside: true, registeredAt: null, lastAt: 9 } },
      pending: [],
      departed: [],
      arrived: [],
      voided: [{ participantId: 'class', at: at('07:00'), appointmentAt: at('09:00'), kind: 'ARRIVE' }],
    });
  });

  it('해석 함수도 받은 상태를 거름 — 깨진 값이면 빈 상태에서 시작', () => {
    expect(resolvePending({ v: 99 } as unknown as GeoState, at('08:00'))).toEqual({ state: initialGeoState(), actions: [] });
  });
});
