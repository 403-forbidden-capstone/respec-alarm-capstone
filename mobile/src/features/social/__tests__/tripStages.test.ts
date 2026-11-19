import { describe, expect, it } from '@jest/globals';

import { setScenarioTime } from '@/lib/clock';
import { memberState, mockWakeRow, myTrip } from '@/mocks/calc';
import { db, kst } from '@/mocks/data';

import { tripCountsOf, wakeStateOf, wokeCountOf, type WakeRow } from '../map';
import { permissionNames, togglePermission } from '../permissions';
import { permissionsFor, TRIP_PERMISSION } from '../types';
import { dayLinesOf, groupWakeLine, wakeScopeOf } from '../wakeTexts';

// 시각은 한국 시간 — UTC 22:11 = 다음 날 오전 7:11
const row = (over: Partial<WakeRow> = {}): WakeRow => ({
  user_id: 'u1',
  is_me: false,
  wake_alarm_at: '2026-10-19T23:50:00.000Z',
  wake_confirmed_at: '2026-10-19T22:11:00.000Z',
  wake_status: 'CONFIRMED',
  departed_at: null,
  arrived_at: null,
  trip_visible: false,
  trip_appointment_at: null,
  ...over,
});
const DEPARTED = '2026-10-19T23:15:00.000Z'; // 오전 8:15
const ARRIVED = '2026-10-20T00:48:00.000Z'; // 오전 9:48

describe('wakeStateOf — 준비 중 · 출발 · 도착 (11/19)', () => {
  it('도착 시각이 있으면 도착이 먼저', () => {
    expect(wakeStateOf(row({ departed_at: DEPARTED, arrived_at: ARRIVED, trip_visible: true }), true)).toEqual({ stage: 'ARRIVED', text: '도착했어요 오전 9:48', dot: 'ok', woke: true });
  });

  it('출발 시각만 있으면 이동 중', () => {
    expect(wakeStateOf(row({ departed_at: DEPARTED, trip_visible: true }), true)).toEqual({ stage: 'DEPARTED', text: '출발했어요 오전 8:15 · 이동 중', dot: 'ok', woke: true });
  });

  it('기상 확인 전이어도 출발 · 도착 시각이 있으면 그것을 보임', () => {
    expect(wakeStateOf(row({ wake_status: 'RINGING', wake_confirmed_at: null, departed_at: DEPARTED }), true).stage).toBe('DEPARTED');
    expect(wakeStateOf(row({ wake_status: 'DISMISSED', wake_confirmed_at: null, arrived_at: ARRIVED }), true).stage).toBe('ARRIVED');
  });

  it('일어났고 출발 · 도착 공유가 켜져 있으면 준비 중, 아니면 일어났어요에서 멈춤', () => {
    expect(wakeStateOf(row({ trip_visible: true }), true)).toEqual({ stage: 'PREPARING', text: '준비 중 · 오전 7:11 기상', dot: 'ok', woke: true });
    expect(wakeStateOf(row({ trip_visible: false }), true)).toEqual({ stage: 'WOKE', text: '일어났어요 오전 7:11', dot: 'ok', woke: true });
    expect(wakeStateOf(row({ trip_visible: true, wake_confirmed_at: null }), true).text).toBe('준비 중');
  });

  it('아직 · 울렸어요는 출발 · 도착 공유와 상관없이 그대로', () => {
    expect(wakeStateOf(row({ wake_status: 'RINGING', wake_confirmed_at: null, trip_visible: true }), true).text).toBe('울렸어요');
    expect(wakeStateOf(row({ wake_status: 'SCHEDULED', wake_confirmed_at: null, trip_visible: true }), true).text).toBe('오전 8:50 알람');
  });
});

describe('이동 중은 약속 + 60분까지만 (trip_appointment_at)', () => {
  const APPT = '2026-10-20T01:00:00.000Z'; // 오전 10:00
  const at = (iso: string) => new Date(iso);
  const departed = row({ departed_at: DEPARTED, trip_visible: true, trip_appointment_at: APPT });

  it('약속 + 60분 전에는 이동 중, 그 뒤엔 출발했어요 시각만', () => {
    expect(wakeStateOf(departed, true, at('2026-10-20T01:59:00.000Z')).text).toBe('출발했어요 오전 8:15 · 이동 중');
    expect(wakeStateOf(departed, true, at('2026-10-20T02:00:00.000Z')).text).toBe('출발했어요 오전 8:15');
  });

  it('도착 기록 없이 밤이 된 경우 — 이동 중이 안 붙고, 요약에서는 일어남으로 셈', () => {
    const night = at('2026-10-20T13:00:00.000Z');
    expect(wakeStateOf(departed, true, night)).toMatchObject({ stage: 'DEPARTED', text: '출발했어요 오전 8:15' });
    expect(tripCountsOf([departed], night)).toBeNull(); // 도착도 이동 중도 없으니 요약은 오늘 n명 일어남
    expect(tripCountsOf([departed, row({ user_id: 'b', arrived_at: ARRIVED, departed_at: DEPARTED, trip_visible: true })], night)).toEqual({ arrived: 1, moving: 0, woke: 1 });
  });

  it('약속 둘인 날 — 기준은 출발 · 도착 기록이 가장 최근인 약속(서버가 준 시각): 오전 약속 도착 뒤 오후 약속으로 출발하면 오후 약속 + 60분', () => {
    const afternoon = row({ departed_at: '2026-10-20T05:00:00.000Z', trip_visible: true, trip_appointment_at: '2026-10-20T08:00:00.000Z' }); // 오후 2:00 출발 · 오후 5:00 약속
    expect(wakeStateOf(afternoon, true, at('2026-10-20T07:00:00.000Z')).text).toContain('이동 중'); // 오후 4:00
    expect(wakeStateOf(afternoon, true, at('2026-10-20T09:10:00.000Z')).text).not.toContain('이동 중'); // 오후 6:10
  });

  it('약속 시각을 모르면(옛 값) 이동 중으로 봄', () => {
    expect(wakeStateOf(row({ departed_at: DEPARTED, trip_visible: true }), true, at('2026-10-20T13:00:00.000Z')).text).toContain('이동 중');
  });
});

describe('일어남 셈 · G01 요약 줄', () => {
  const rows = [
    row({ user_id: 'a', arrived_at: ARRIVED, departed_at: DEPARTED, trip_visible: true }),
    row({ user_id: 'b', departed_at: DEPARTED, trip_visible: true }),
    row({ user_id: 'c', departed_at: DEPARTED, trip_visible: true }),
    row({ user_id: 'd', trip_visible: true }),
    row({ user_id: 'e', wake_status: 'RINGING', wake_confirmed_at: null }),
  ];

  it('준비 중 · 출발 · 도착도 일어남으로 셈', () => {
    expect(wokeCountOf(rows)).toBe(4);
    expect(wokeCountOf([])).toBeNull();
  });

  it('누군가 출발 · 도착이 보이면 0이 아닌 것만 도착 · 이동 중 · 일어남', () => {
    const trip = tripCountsOf(rows);
    expect(trip).toEqual({ arrived: 1, moving: 2, woke: 1 });
    expect(groupWakeLine(4, trip)).toBe('도착 1 · 이동 중 2 · 일어남 1');
    expect(groupWakeLine(3, { arrived: 0, moving: 2, woke: 1 })).toBe('이동 중 2 · 일어남 1');
    expect(groupWakeLine(2, { arrived: 2, moving: 0, woke: 0 })).toBe('도착 2');
  });

  it('출발 · 도착이 아무도 안 보이면 지금처럼 오늘 n명 일어남, 약속 없는 날은 줄 없음', () => {
    const none = [row({ trip_visible: true }), row({ user_id: 'z' })];
    expect(tripCountsOf(none)).toBeNull();
    expect(groupWakeLine(wokeCountOf(none), tripCountsOf(none))).toBe('오늘 2명 일어남');
    expect(groupWakeLine(null, null)).toBeNull();
  });
});

describe('G03 오늘의 흐름 (dayLinesOf)', () => {
  it('아는 것만 시간순', () => {
    const lines = dayLinesOf({
      alarmAt: new Date('2026-10-19T23:50:00.000Z'),
      confirmedAt: new Date('2026-10-19T22:11:00.000Z'),
      departedAt: new Date(DEPARTED),
      arrivedAt: new Date(ARRIVED),
    });
    expect(lines.map((l) => l.label)).toEqual(['일어났어요', '출발했어요', '알람', '도착했어요']);
    expect(dayLinesOf({ alarmAt: new Date(DEPARTED), confirmedAt: null, departedAt: null, arrivedAt: null }).map((l) => l.label)).toEqual(['알람']);
    expect(dayLinesOf({ alarmAt: null, confirmedAt: null, departedAt: null, arrivedAt: null })).toEqual([]);
  });
});

describe('출발 · 도착 공유 스위치 (F03)', () => {
  const base = { viewAlarm: false, editAlarm: false, viewWake: true, viewTrip: false };

  it('그룹 관계에만 있음, 설명 · 칩 글자', () => {
    expect(permissionsFor('friend').some((p) => p.key === 'viewTrip')).toBe(false);
    expect(permissionsFor('group').at(-1)).toMatchObject({ key: 'viewTrip', name: '출발 · 도착 공유', description: '이 그룹 일정의 출발 · 도착 시각이 보여요. 장소는 안 보여요.' });
    expect(permissionNames({ ...base, viewTrip: true })).toEqual(['기상 상태 조회', TRIP_PERMISSION.chip]);
  });

  it('기상 공유가 꺼져 있으면 못 켬, 기상 공유를 끄면 같이 꺼짐', () => {
    expect(togglePermission({ ...base, viewWake: false }, 'viewTrip', true).viewTrip).toBe(false);
    expect(togglePermission(base, 'viewTrip', true).viewTrip).toBe(true);
    expect(togglePermission({ ...base, viewTrip: true }, 'viewWake', false)).toMatchObject({ viewWake: false, viewTrip: false });
  });
});

describe('웹 미리보기 이동 중 · 도착 장면 (가짜 데이터)', () => {
  it('도착 09:50 장면 — 내 출발 · 도착 공유를 켜면 나 도착 · 수연 출발 · 지형 준비 중 · 준성 울렸어요', () => {
    setScenarioTime('arrived');
    try {
      const t = kst(22, 590);
      const stage = (id: string, trip: boolean) => wakeStateOf(mockWakeRow(id, t, trip) ?? undefined, true).stage;
      expect(['me', 'sy', 'jh', 'js'].map((id) => stage(id, true))).toEqual(['ARRIVED', 'DEPARTED', 'PREPARING', 'RANG']);
      expect(stage('me', false)).toBe('WOKE'); // 내 스위치가 꺼져 있으면 기상에서 멈춤
      expect(myTrip(t).arriveAt).toEqual(kst(22, 588));
    } finally {
      setScenarioTime('morning');
    }
  });

  it('이동 중 09:10 장면 — 나는 출발했고 아직 도착 전', () => {
    setScenarioTime('moving');
    try {
      expect(myTrip(kst(22, 550))).toEqual({ wakeAt: kst(22, 431), departAt: kst(22, 535), arriveAt: null });
    } finally {
      setScenarioTime('morning');
    }
  });

  it('평소 아침 장면은 그대로 — 일어났어요에서 멈춤', () => {
    expect(db.me.departAt).toBeNull();
    expect(memberState('sy', kst(22, 475)).stage).toBe('WOKE');
  });
});

describe('G03 공유 범위 글자 (wakeScopeOf)', () => {
  it('출발 · 도착이 보이는 사람은 제목 · 설명에 출발 · 도착 범위, 아닌 사람은 지금 그대로', () => {
    expect(wakeScopeOf('수연', '캡스톤팀', true)).toMatchObject({ title: '기상 여부 · 알람 시각 · 출발 · 도착 시각' });
    expect(wakeScopeOf('수연', '캡스톤팀', true).body).toContain('출발 · 도착 공유를 켠');
    expect(wakeScopeOf('수연', '캡스톤팀', false).title).toBe('기상 여부와 알람 시각');
    expect(wakeScopeOf('수연', '캡스톤팀', false).body).not.toContain('출발');
  });
});
