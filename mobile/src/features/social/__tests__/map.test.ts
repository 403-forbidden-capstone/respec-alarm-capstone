import { describe, expect, it } from '@jest/globals';

import {
  appointmentLabel,
  groupSharedCards,
  HIDDEN_STATE,
  initialOf,
  NO_APPOINTMENT_STATE,
  personFromProfile,
  shareTags,
  sinceLabel,
  toMemberAlarm,
  upcomingCards,
  wakeAlarmCard,
  wakeStateOf,
  wakeTimeline,
  wokeCountOf,
  type SharedAlarmRow,
  type SharedApptRow,
  type WakeRow,
} from '../map';

// 시각은 한국 시간으로 보임 (lib/format) — UTC 22:30 = 다음 날 오전 7:30
const wakeRow = (over: Partial<WakeRow> = {}): WakeRow => ({
  user_id: 'u1',
  is_me: false,
  wake_alarm_at: '2026-10-19T22:30:00.000Z',
  rang_at: null,
  snooze_count: 0,
  dismissed_at: null,
  wake_confirmed_at: null,
  missed_at: null,
  wake_status: 'SCHEDULED',
  ...over,
});

describe('사람 · 그룹 글자', () => {
  it('닉네임 하나로 이름 · 짧은 이름 · 첫 글자, 아이디는 @를 붙임', () => {
    expect(personFromProfile({ user_id: 'u', nickname: '수연', handle: 'etion', profile_image_url: null })).toEqual({
      id: 'u',
      name: '수연',
      short: '수연',
      initial: '수',
      handle: '@etion',
    });
    expect(personFromProfile({ user_id: 'u', nickname: '지형', handle: null, profile_image_url: null }).handle).toBeNull();
  });

  it('첫 글자는 이모지 같은 두 칸짜리도 한 글자로', () => {
    expect(initialOf('  캡스톤팀')).toBe('캡');
    expect(initialOf('😀웃음')).toBe('😀');
    expect(initialOf('')).toBe('?');
  });

  it('그룹을 만든 달 (한국 시간 기준)', () => {
    expect(sinceLabel('2026-03-05T00:00:00.000Z')).toBe('2026년 3월부터 함께하는 중');
    expect(sinceLabel('2026-02-28T16:00:00.000Z')).toBe('2026년 3월부터 함께하는 중'); // 한국은 이미 3월 1일
  });
});

describe('wakeStateOf — 기상까지만 (D59)', () => {
  it('상태마다 글자 · 점 · 기상 여부', () => {
    expect(wakeStateOf(wakeRow({ wake_status: 'CONFIRMED', wake_confirmed_at: '2026-10-19T22:35:00.000Z' }), true)).toEqual({
      text: '기상 완료 · 오전 7:35',
      dot: 'ok',
      woke: true,
    });
    expect(wakeStateOf(wakeRow({ wake_status: 'RINGING' }), true)).toMatchObject({ text: '알람 울리는 중', dot: 'zz', woke: false });
    expect(wakeStateOf(wakeRow({ wake_status: 'DISMISSED' }), true)).toMatchObject({ text: '알람 해제 · 기상 확인 전', woke: false });
    expect(wakeStateOf(wakeRow({ wake_status: 'MISSED' }), true)).toMatchObject({ text: '기상 미확인', woke: false });
    expect(wakeStateOf(wakeRow({ wake_status: 'SCHEDULED' }), true)).toMatchObject({ text: '취침 중 · 알람 7:30', woke: false });
    expect(wakeStateOf(wakeRow({ wake_status: 'NO_ALARM', wake_alarm_at: null }), true)).toMatchObject({ text: '오늘은 기상 알람이 없어요' });
  });

  it('준비 · 출발 · 도착 같은 단계는 만들지 않음', () => {
    const texts = ['CONFIRMED', 'MISSED', 'DISMISSED', 'RINGING', 'SCHEDULED', 'NO_ALARM'].map((wake_status) => wakeStateOf(wakeRow({ wake_status }), true).text);
    expect(texts.join(' ')).not.toMatch(/준비|출발|도착/);
  });

  it('그날 행이 하나도 없으면 그 그룹 약속이 없는 날, 행이 없는 멤버는 볼 수 없음 (D57)', () => {
    expect(wakeStateOf(undefined, false)).toBe(NO_APPOINTMENT_STATE);
    expect(wakeStateOf(wakeRow(), false)).toBe(NO_APPOINTMENT_STATE);
    expect(wakeStateOf(undefined, true)).toBe(HIDDEN_STATE);
  });

  it('오늘 기상한 사람 수는 기상 확인이 된 사람만', () => {
    const rows = [wakeRow({ wake_status: 'CONFIRMED' }), wakeRow({ wake_status: 'DISMISSED' }), wakeRow({ wake_status: 'CONFIRMED' }), wakeRow({ wake_status: 'MISSED' })];
    expect(wokeCountOf(rows)).toBe(2);
    expect(wokeCountOf([])).toBe(0);
  });
});

describe('G03 흐름 · 알람 카드', () => {
  it('울림 → 해제 → 확인을 시간순으로, 미루기 횟수는 출처 칸에', () => {
    const row = wakeRow({
      wake_status: 'CONFIRMED',
      rang_at: '2026-10-19T22:30:00.000Z',
      snooze_count: 2,
      dismissed_at: '2026-10-19T22:34:00.000Z',
      wake_confirmed_at: '2026-10-19T22:40:00.000Z',
    });
    expect(wakeTimeline(row).map((e) => [e.label, e.source])).toEqual([
      ['알람 울림', '자동 기록 · 미루기 2회'],
      ['알람 해제', '기상 미확정'],
      ['기상 확인', ''],
    ]);
  });

  it('미루지 않았으면 출처에 횟수를 안 적고, 미확인은 흐름 끝에', () => {
    const row = wakeRow({ wake_status: 'MISSED', rang_at: '2026-10-19T22:30:00.000Z', missed_at: '2026-10-19T23:30:00.000Z' });
    expect(wakeTimeline(row).map((e) => [e.label, e.source])).toEqual([
      ['알람 울림', '자동 기록'],
      ['기상 미확인', '자동 기록'],
    ]);
    expect(wakeTimeline(wakeRow())).toEqual([]);
  });

  it('알람 카드: 기상 한 줄만, 강도 · 준비는 비움 (기상 조회 권한으로는 못 읽음)', () => {
    const card = wakeAlarmCard(wakeRow(), '팀 주간회의 · 세종대학교 · 오전 10:00');
    expect(card).toMatchObject({ chain: [{ label: '기상' }], levelName: '', note: '', enabled: true, appointmentLabel: '팀 주간회의 · 세종대학교 · 오전 10:00' });
    expect(card?.chain[0].at.toISOString()).toBe('2026-10-19T22:30:00.000Z');
    expect(wakeAlarmCard(wakeRow({ wake_alarm_at: null }), '')).toBeNull();
  });

  it('약속 줄: 제목 · 장소 · 시각', () => {
    expect(appointmentLabel('팀 주간회의', '세종대학교', new Date('2026-10-20T01:00:00.000Z'))).toBe('팀 주간회의 · 세종대학교 · 오전 10:00');
  });
});

describe('G04 공유받은 알람 카드', () => {
  const appt = (alarm_id: string, appointment_id: string, at: string, title = '팀 주간회의'): SharedApptRow => ({
    alarm_id,
    appointment_id,
    title,
    dest_name: '세종대학교',
    appointment_at: at,
  });
  const alarm = (alarm_id: string, alarm_type: SharedAlarmRow['alarm_type'], scheduled_at: string, over: Partial<SharedAlarmRow> = {}): SharedAlarmRow => ({
    alarm_id,
    alarm_type,
    scheduled_at,
    intensity: 'NORMAL',
    sound_key: 'theme_default',
    is_enabled: true,
    time_source: 'AUTO',
    ...over,
  });

  // 10월 20일 오전 10시 약속(= 01:00Z): 기상 7:30 · 준비 7:40 · 출발 8:50 · 도착 목표 9:50
  const appointments = [
    appt('w1', 'ap1', '2026-10-20T01:00:00.000Z'),
    appt('p1', 'ap1', '2026-10-20T01:00:00.000Z'),
    appt('d1', 'ap1', '2026-10-20T01:00:00.000Z'),
    appt('a1', 'ap1', '2026-10-20T01:00:00.000Z'),
  ];
  const alarms = [
    alarm('d1', 'DEPARTURE', '2026-10-19T23:50:00.000Z'),
    alarm('a1', 'ARRIVE', '2026-10-20T00:50:00.000Z'),
    alarm('w1', 'WAKE', '2026-10-19T22:30:00.000Z'),
    alarm('p1', 'PREPARE', '2026-10-19T22:40:00.000Z'),
  ];

  it('약속 하나가 카드 하나: 기상 · 준비 · 출발을 시각순으로, 도착 목표는 뺌', () => {
    const [card] = groupSharedCards(appointments, alarms);
    expect(card.alarms.map((a) => a.alarm_type)).toEqual(['WAKE', 'PREPARE', 'DEPARTURE']);
    expect(toMemberAlarm(card)).toMatchObject({
      id: 'ap1',
      levelName: '중',
      appointmentLabel: '팀 주간회의 · 세종대학교 · 오전 10:00',
      note: '준비 80분 · 출발부터 약속까지 70분',
      enabled: true,
    });
    expect(toMemberAlarm(card).chain.map((x) => x.label)).toEqual(['기상', '준비', '출발']);
  });

  it('권한이 없어 읽히지 않는 알람은 카드에서 빠지고, 알람이 하나도 안 읽히면 카드가 없음', () => {
    expect(groupSharedCards(appointments, alarms.filter((a) => a.alarm_type !== 'WAKE'))[0].alarms).toHaveLength(2);
    expect(groupSharedCards(appointments, [])).toEqual([]);
    expect(groupSharedCards(appointments, [alarm('a1', 'ARRIVE', '2026-10-20T00:50:00.000Z')])).toEqual([]);
  });

  it('카드 스위치는 묶음 전체 — 하나라도 켜져 있으면 켜짐, 모두 꺼져야 꺼짐', () => {
    const off = (ids: string[]) => alarms.map((a) => (ids.includes(a.alarm_id) ? { ...a, is_enabled: false } : a));
    expect(toMemberAlarm(groupSharedCards(appointments, off(['w1']))[0]).enabled).toBe(true);
    expect(toMemberAlarm(groupSharedCards(appointments, off(['w1', 'p1', 'd1']))[0]).enabled).toBe(false);
  });

  it('여러 약속은 약속 순서대로, 지난 약속은 거르되 꺼진 알람은 남김', () => {
    const more = [...appointments, appt('w2', 'ap0', '2026-10-18T01:00:00.000Z', '지난 수업')];
    const cards = groupSharedCards(more, [...alarms, alarm('w2', 'WAKE', '2026-10-17T22:30:00.000Z', { is_enabled: false })]);
    expect(cards.map((c) => c.appointmentId)).toEqual(['ap1', 'ap0']);
    const now = Date.parse('2026-10-19T12:00:00.000Z');
    expect(upcomingCards(cards, now).map((c) => c.appointmentId)).toEqual(['ap1']);
    const disabledUpcoming = groupSharedCards(appointments, alarms.map((a) => ({ ...a, is_enabled: false })));
    expect(upcomingCards(disabledUpcoming, now)).toHaveLength(1);
  });

  it('출발 알람이 없으면 준비 시간 메모는 비움', () => {
    const [card] = groupSharedCards(appointments, alarms.filter((a) => a.alarm_type !== 'DEPARTURE'));
    expect(toMemberAlarm(card).note).toBe('');
  });

  it('강도는 첫 알람의 배경음 칸으로, 모르면 강도 칸으로 읽음', () => {
    const strong = alarms.map((a) => ({ ...a, sound_key: 'theme_urgent', intensity: 'STRONG' as const }));
    expect(toMemberAlarm(groupSharedCards(appointments, strong)[0]).levelName).toBe('강');
    const unknownSound = alarms.map((a) => ({ ...a, sound_key: null, intensity: 'SOFT' as const }));
    expect(toMemberAlarm(groupSharedCards(appointments, unknownSound)[0]).levelName).toBe('약');
  });

  it('권한 꼬리표: 조회가 없으면 설정 꼬리표도 뺌, 같은 이름은 한 번만', () => {
    const row = (source: string, viewAlarm: boolean, editAlarm: boolean) => ({ source, viewAlarm, editAlarm });
    expect(shareTags([row('친구', true, true), row('캡스톤팀', true, false)])).toEqual(['조회 · 친구', '설정 · 친구', '조회 · 캡스톤팀']);
    expect(shareTags([row('친구', false, true)])).toEqual([]);
    expect(shareTags([row('팀', true, false), row('팀', true, false)])).toEqual(['조회 · 팀']);
  });
});
