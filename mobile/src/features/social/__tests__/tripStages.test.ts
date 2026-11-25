import { describe, expect, it } from '@jest/globals';

import { setScenarioTime } from '@/lib/clock';
import { memberState, mockWakeRow, myTrip } from '@/mocks/calc';
import { db, kst, TRIP_SHARERS } from '@/mocks/data';

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
const PREP_STARTED = '2026-10-19T22:25:00.000Z'; // 오전 7:25
const DEPARTED = '2026-10-19T23:15:00.000Z'; // 오전 8:15
const ARRIVED = '2026-10-20T00:48:00.000Z'; // 오전 9:48

describe('wakeStateOf — 준비 중 · 출발 · 도착 (11/19)', () => {
  it('도착 시각이 있으면 도착이 먼저', () => {
    expect(wakeStateOf(row({ departed_at: DEPARTED, arrived_at: ARRIVED, trip_visible: true }), true)).toEqual({ stage: 'ARRIVED', text: '도착 · 오전 9:48', dot: 'ok', woke: true });
  });

  it('출발 시각만 있으면 이동 중', () => {
    expect(wakeStateOf(row({ departed_at: DEPARTED, trip_visible: true }), true)).toEqual({ stage: 'DEPARTED', text: '이동 중 · 오전 8:15 출발', dot: 'mid', woke: true });
  });

  it('기상 확인 전이어도 출발 · 도착 시각이 있으면 그것을 보임', () => {
    expect(wakeStateOf(row({ wake_status: 'RINGING', wake_confirmed_at: null, departed_at: DEPARTED }), true).stage).toBe('DEPARTED');
    expect(wakeStateOf(row({ wake_status: 'DISMISSED', wake_confirmed_at: null, arrived_at: ARRIVED }), true).stage).toBe('ARRIVED');
  });

  it('준비 시작 체크가 있으면 준비 중 — 기상 완료보다 위, 출발보다 아래', () => {
    expect(wakeStateOf(row({ trip_visible: true, prepare_started_at: PREP_STARTED }), true)).toEqual({ stage: 'PREPARING', text: '준비 중 · 오전 7:25 시작', dot: 'mid', woke: true });
    expect(wakeStateOf(row({ trip_visible: true, prepare_started_at: PREP_STARTED, wake_confirmed_at: null }), true).stage).toBe('PREPARING');
    expect(wakeStateOf(row({ trip_visible: true, prepare_started_at: PREP_STARTED, departed_at: DEPARTED }), true).stage).toBe('DEPARTED');
    expect(wakeStateOf(row({ trip_visible: true, prepare_started_at: PREP_STARTED, departed_at: DEPARTED, arrived_at: ARRIVED }), true).stage).toBe('ARRIVED');
  });

  it('준비 시작 체크 전에는 출발 · 도착 공유를 켰어도 기상 완료 (짐작으로 준비 중을 만들지 않음)', () => {
    expect(wakeStateOf(row({ trip_visible: true }), true)).toEqual({ stage: 'WOKE', text: '기상 완료 · 오전 7:11', dot: 'ok', woke: true });
    expect(wakeStateOf(row({ trip_visible: false }), true)).toEqual({ stage: 'WOKE', text: '기상 완료 · 오전 7:11', dot: 'ok', woke: true });
  });

  it('기상 알람이 없는 날 — 출발 · 도착 공유 + 준비 알람 시각이 있으면 준비 알람, 아니면 알람 없음', () => {
    const noWake = { wake_status: 'NO_ALARM', wake_alarm_at: null, wake_confirmed_at: null };
    expect(wakeStateOf(row({ ...noWake, trip_visible: true, prepare_alarm_at: '2026-10-20T08:10:00.000Z' }), true)).toEqual({ stage: 'PREP_SCHEDULED', text: '준비 알람 오후 5:10', dot: null, woke: false });
    expect(wakeStateOf(row({ ...noWake, trip_visible: false }), true)).toMatchObject({ stage: 'NO_ALARM', text: '알람 없음' });
    expect(wakeStateOf(row({ ...noWake, trip_visible: true }), true).text).toBe('알람 없음');
    // 준비 시작 체크가 생기면 준비 중
    expect(wakeStateOf(row({ ...noWake, trip_visible: true, prepare_alarm_at: '2026-10-20T08:10:00.000Z', prepare_started_at: '2026-10-20T08:12:00.000Z' }), true).text).toBe('준비 중 · 오후 5:12 시작');
  });

  it('아직 · 알람 울림은 출발 · 도착 공유와 상관없이 그대로', () => {
    expect(wakeStateOf(row({ wake_status: 'RINGING', wake_confirmed_at: null, trip_visible: true }), true).text).toBe('알람 울리는 중');
    expect(wakeStateOf(row({ wake_status: 'SCHEDULED', wake_confirmed_at: null, trip_visible: true }), true).text).toBe('취침 중 · 오전 8:50 알람');
  });
});

describe('이동 중은 약속 + 60분까지만 (trip_appointment_at)', () => {
  const APPT = '2026-10-20T01:00:00.000Z'; // 오전 10:00
  const at = (iso: string) => new Date(iso);
  const departed = row({ departed_at: DEPARTED, trip_visible: true, trip_appointment_at: APPT });

  it('약속 + 60분 전에는 이동 중, 그 뒤엔 출발 시각만', () => {
    expect(wakeStateOf(departed, true, at('2026-10-20T01:59:00.000Z')).text).toBe('이동 중 · 오전 8:15 출발');
    expect(wakeStateOf(departed, true, at('2026-10-20T02:00:00.000Z')).text).toBe('출발 · 오전 8:15');
  });

  it('도착 기록 없이 밤이 된 경우 — 이동 중이 안 붙고, 요약에서는 기상 완료로 셈', () => {
    const night = at('2026-10-20T13:00:00.000Z');
    expect(wakeStateOf(departed, true, night)).toMatchObject({ stage: 'DEPARTED', text: '출발 · 오전 8:15' });
    expect(tripCountsOf([departed], night)).toBeNull(); // 도착도 이동 중도 없으니 요약은 오늘 n명 기상 완료
    expect(tripCountsOf([departed, row({ user_id: 'b', arrived_at: ARRIVED, departed_at: DEPARTED, trip_visible: true })], night)).toEqual({ arrived: 1, moving: 0, preparing: 0, woke: 1 });
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

describe('기상 완료 셈 · G01 요약 줄', () => {
  const rows = [
    row({ user_id: 'a', arrived_at: ARRIVED, departed_at: DEPARTED, trip_visible: true }),
    row({ user_id: 'b', departed_at: DEPARTED, trip_visible: true }),
    row({ user_id: 'c', departed_at: DEPARTED, trip_visible: true }),
    row({ user_id: 'd', trip_visible: true }),
    row({ user_id: 'f', trip_visible: true, prepare_started_at: PREP_STARTED }),
    row({ user_id: 'e', wake_status: 'RINGING', wake_confirmed_at: null }),
  ];

  it('준비 중 · 출발 · 도착도 기상 완료로 셈', () => {
    expect(wokeCountOf(rows)).toBe(5);
    expect(wokeCountOf([])).toBeNull();
  });

  it('누군가 도착 · 이동 중 · 준비 중이 보이면 0이 아닌 것만 도착 · 이동 중 · 준비 중 · 기상 완료', () => {
    const trip = tripCountsOf(rows);
    expect(trip).toEqual({ arrived: 1, moving: 2, preparing: 1, woke: 1 });
    expect(groupWakeLine(5, trip)).toBe('도착 1 · 이동 중 2 · 준비 중 1 · 기상 완료 1');
    expect(groupWakeLine(3, { arrived: 0, moving: 2, preparing: 0, woke: 1 })).toBe('이동 중 2 · 기상 완료 1');
    expect(groupWakeLine(2, { arrived: 2, moving: 0, preparing: 0, woke: 0 })).toBe('도착 2');
    expect(groupWakeLine(2, { arrived: 0, moving: 0, preparing: 1, woke: 1 })).toBe('준비 중 1 · 기상 완료 1');
  });

  it('출발 · 도착이 아무도 안 보이면 지금처럼 오늘 n명 기상 완료, 약속 없는 날은 줄 없음', () => {
    const none = [row({ trip_visible: true }), row({ user_id: 'z' })]; // 준비 시작 체크 전의 기상 완료
    expect(tripCountsOf(none)).toBeNull();
    expect(groupWakeLine(wokeCountOf(none), tripCountsOf(none))).toBe('오늘 2명 기상 완료');
    expect(groupWakeLine(null, null)).toBeNull();
  });
});

describe('G03 오늘의 흐름 (dayLinesOf)', () => {
  it('준비 시작이 기상 확인과 출발 사이, 기상 없는 날은 준비 알람부터', () => {
    const none = { alarmAt: null, confirmedAt: null, departedAt: null, arrivedAt: null };
    const full = { alarmAt: new Date('2026-10-19T22:00:00.000Z'), confirmedAt: new Date('2026-10-19T22:11:00.000Z'), prepareStartedAt: new Date(PREP_STARTED), departedAt: new Date(DEPARTED), arrivedAt: new Date(ARRIVED) };
    expect(dayLinesOf(full, new Date('2026-10-20T03:00:00.000Z')).map((l) => l.label)).toEqual(['알람 울림', '기상 확인', '준비 시작', '출발', '도착']);
    const afternoon = new Date('2026-10-20T08:10:00.000Z'); // 오후 5:10
    expect(dayLinesOf({ ...none, prepareAlarmAt: afternoon }, new Date('2026-10-20T07:00:00.000Z')).map((l) => l.label)).toEqual(['준비 알람 예정']);
    expect(dayLinesOf({ ...none, prepareAlarmAt: afternoon, prepareStartedAt: new Date('2026-10-20T08:12:00.000Z') }, new Date('2026-10-20T08:30:00.000Z')).map((l) => l.label)).toEqual(['준비 알람', '준비 시작']);
    // 기상 알람이 있는 날엔 준비 알람 줄을 따로 안 둠
    expect(dayLinesOf({ ...full, prepareAlarmAt: afternoon }, new Date('2026-10-20T03:00:00.000Z')).map((l) => l.label)).not.toContain('준비 알람');
  });

  it('아는 것만 시간순', () => {
    const all = {
      alarmAt: new Date('2026-10-19T23:50:00.000Z'),
      confirmedAt: new Date('2026-10-19T22:11:00.000Z'),
      departedAt: new Date(DEPARTED),
      arrivedAt: new Date(ARRIVED),
    };
    const after = new Date('2026-10-20T03:00:00.000Z'); // 알람 시각 이후
    expect(dayLinesOf(all, after).map((l) => l.label)).toEqual(['기상 확인', '출발', '알람 울림', '도착']);
    // 알람 시각이 아직 안 지났으면 '알람 예정'
    const before = new Date('2026-10-19T20:00:00.000Z');
    expect(dayLinesOf({ ...all, confirmedAt: null, departedAt: null, arrivedAt: null }, before).map((l) => l.label)).toEqual(['알람 예정']);
    expect(dayLinesOf({ alarmAt: new Date(DEPARTED), confirmedAt: null, departedAt: null, arrivedAt: null }, after).map((l) => l.label)).toEqual(['알람 울림']);
    expect(dayLinesOf({ alarmAt: null, confirmedAt: null, departedAt: null, arrivedAt: null })).toEqual([]);
  });
});

describe('출발 · 도착 공유 스위치 (F03)', () => {
  const base = { viewAlarm: false, editAlarm: false, viewWake: true, viewTrip: false };

  it('그룹 관계에만 있음, 설명 · 칩 글자', () => {
    expect(permissionsFor('friend').some((p) => p.key === 'viewTrip')).toBe(false);
    expect(permissionsFor('group').at(-1)).toMatchObject({ key: 'viewTrip', name: '출발 · 도착 공유', description: '준비 시작 · 출발 · 도착 시각이 보여요.' });
    expect(permissionNames({ ...base, viewTrip: true })).toEqual(['내 기상 공개', TRIP_PERMISSION.chip]);
  });

  it('기상 공유가 꺼져 있으면 못 켬, 기상 공유를 끄면 같이 꺼짐', () => {
    expect(togglePermission({ ...base, viewWake: false }, 'viewTrip', true).viewTrip).toBe(false);
    expect(togglePermission(base, 'viewTrip', true).viewTrip).toBe(true);
    expect(togglePermission({ ...base, viewTrip: true }, 'viewWake', false)).toMatchObject({ viewWake: false, viewTrip: false });
  });
});

describe('웹 미리보기 이동 중 · 도착 장면 (가짜 데이터)', () => {
  it('도착 09:50 장면 — 내 출발 · 도착 공유를 켜면 나 도착 · 수연 출발 · 지형 준비 중 · 준성 이동 중(기상 알람을 직접 끈 사람)', () => {
    setScenarioTime('arrived');
    try {
      const t = kst(22, 590);
      const stage = (id: string, trip: boolean) => wakeStateOf(mockWakeRow(id, t, trip) ?? undefined, true).stage;
      expect(['me', 'sy', 'jh', 'js'].map((id) => stage(id, true))).toEqual(['ARRIVED', 'DEPARTED', 'PREPARING', 'DEPARTED']);
      expect(stage('me', false)).toBe('WOKE'); // 내 스위치가 꺼져 있으면 기상에서 멈춤
      expect(myTrip(t).arriveAt).toEqual(kst(22, 588));
    } finally {
      setScenarioTime('morning');
    }
  });

  it('장면별 멤버 줄 글자 — 아침 7:55 · 이동 중 9:10 · 도착 9:50 (수연 · 준성은 늘 출발 · 도착 공유, 지형은 이동 중 · 도착 장면에서만)', () => {
    const texts = (scene: 'morning' | 'moving' | 'arrived', t: Date) => {
      setScenarioTime(scene);
      try {
        return ['sy', 'jh', 'js'].map((id) => wakeStateOf(mockWakeRow(id, t, scene !== 'morning' || TRIP_SHARERS.includes(id)) ?? undefined, true).text);
      } finally {
        setScenarioTime('morning');
      }
    };
    expect(texts('morning', kst(22, 475))).toEqual(['준비 중 · 오전 7:38 시작', '기상 완료 · 오전 7:30', '준비 알람 오전 8:40']);
    expect(texts('moving', kst(22, 550))).toEqual(['준비 중 · 오전 7:38 시작', '준비 중 · 오전 8:00 시작', '준비 중 · 오전 8:42 시작']);
    expect(texts('arrived', kst(22, 590))).toEqual(['이동 중 · 오전 9:20 출발', '준비 중 · 오전 8:00 시작', '이동 중 · 오전 9:15 출발']);
  });

  it('이동 중 09:10 장면 — 나는 출발했고 아직 도착 전', () => {
    setScenarioTime('moving');
    try {
      expect(myTrip(kst(22, 550))).toEqual({ wakeAt: kst(22, 431), departAt: kst(22, 535), arriveAt: null });
    } finally {
      setScenarioTime('morning');
    }
  });

  it('평소 아침 장면은 그대로 — 기상 완료에서 멈춤', () => {
    expect(db.me.departAt).toBeNull();
    expect(memberState('sy', kst(22, 475)).stage).toBe('WOKE'); // memberState는 공유를 안 켠 줄 — 준비 시작 체크가 안 보임
  });
});

describe('G03 공유 범위 글자 (wakeScopeOf)', () => {
  it('출발 · 도착이 보이는 사람은 제목 · 설명에 출발 · 도착 범위, 아닌 사람은 지금 그대로', () => {
    expect(wakeScopeOf('수연', '캡스톤팀', true)).toMatchObject({ title: '기상 여부 · 알람 시각 · 준비 시작 · 출발 · 도착 시각' });
    expect(wakeScopeOf('수연', '캡스톤팀', true).body).toContain('공개한 범위');
    expect(wakeScopeOf('수연', '캡스톤팀', false).title).toBe('기상 여부와 알람 시각');
    expect(wakeScopeOf('수연', '캡스톤팀', false).body).not.toContain('출발');
  });
});
