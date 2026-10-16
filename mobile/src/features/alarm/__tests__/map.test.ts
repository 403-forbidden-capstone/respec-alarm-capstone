import { describe, expect, it } from '@jest/globals';

import { formatTime } from '@/lib/format';
import { alarmChain } from '@shared/calc/chain.ts';

import { pickNextAlarm, toAlarmTime, toAppointment, type AlarmRow, type AppointmentRows } from '../map';

// 목업 첫 화면과 같은 일정: 10시 팀 주간회의 (이동 50 · 여유 10 · 준비 60 · 준비 전 활동 30) -> 기상 8:00 · 준비 8:30 · 출발 9:00 · 도착 목표 9:50 (한국 시각)
const kstTime = (hhmm: string) => `2025-05-22T${hhmm}:00+09:00`;
const alarmRow = (id: string, type: AlarmRow['alarm_type'], hhmm: string, overrides: Partial<AlarmRow> = {}): AlarmRow => ({
  alarm_id: id,
  alarm_type: type,
  scheduled_at: kstTime(hhmm),
  intensity: 'NORMAL',
  sound_key: 'theme_default',
  is_enabled: true,
  ...overrides,
});

function meeting(overrides: Partial<AppointmentRows> = {}): AppointmentRows {
  return {
    appointment: { appointment_id: 'appt-1', title: '팀 주간회의', appointment_at: kstTime('10:00'), dest_name: '세종대학교', importance: 'NORMAL', recurrence_rule: null },
    participant: { origin_name: '집', transport_type: 'TRANSIT', est_travel_minutes: 50, travel_source: 'API', prepare_minutes: 60, buffer_minutes: 10 },
    alarms: [alarmRow('a-arrive', 'ARRIVE', '09:50'), alarmRow('a-dep', 'DEPARTURE', '09:00'), alarmRow('a-prep', 'PREPARE', '08:30'), alarmRow('a-wake', 'WAKE', '08:00')],
    groupName: '캡스톤팀',
    items: ['노트북', '회의 자료'],
    ...overrides,
  };
}

describe('DB 행 → 약속 (toAppointment)', () => {
  it('목업의 팀 주간회의와 같은 모양: 알람은 기상 · 준비 · 출발 · 도착 목표 순', () => {
    const a = toAppointment(meeting());
    expect(a).toMatchObject({
      id: 'appt-1',
      title: '팀 주간회의',
      place: '세종대학교',
      origin: '집',
      transport: 'TRANSIT',
      travelMinutes: 50,
      travelSource: '길찾기',
      bufferMinutes: 10,
      beforePrepMinutes: 30,
      prepMinutes: 60,
      predictedPrepMinutes: 60,
      importance: 'NORMAL',
      repeatLabel: '반복 없음',
      recurrenceRule: null,
      groupName: '캡스톤팀',
      items: ['노트북', '회의 자료'],
      withWake: true,
      enabled: true,
      level: 1,
    });
    expect(a.alarms.map((x) => `${x.kind} ${formatTime(x.at)} ${x.id}`)).toEqual([
      'WAKE 오전 8:00 a-wake',
      'PREPARE 오전 8:30 a-prep',
      'DEPARTURE 오전 9:00 a-dep',
      'ARRIVE 오전 9:50 a-arrive',
    ]);
  });

  it('저장된 알람 시각이 공용 계산(alarmChain)과 같은 규칙으로 나온 값임 — 예시 행이 서버 계산과 어긋나지 않는지', () => {
    const a = toAppointment(meeting());
    const chain = alarmChain({ at: a.at, travelMinutes: a.travelMinutes, bufferMinutes: a.bufferMinutes, prepareMinutes: a.prepMinutes, beforePrepareMinutes: a.beforePrepMinutes, withWake: a.withWake });
    expect(a.alarms.map((x) => [x.kind, x.at.getTime()])).toEqual(chain.map((x) => [x.kind, x.at.getTime()]));
  });

  it('기상 알람이 없으면(그날 첫 일정이 아님) 준비 전 활동 0, 반복 규칙은 화면 글자로', () => {
    const rows = meeting({
      appointment: { ...meeting().appointment, recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE' },
      alarms: [alarmRow('a-prep', 'PREPARE', '08:30'), alarmRow('a-dep', 'DEPARTURE', '09:00'), alarmRow('a-arrive', 'ARRIVE', '09:50')],
    });
    const a = toAppointment(rows);
    expect(a).toMatchObject({ withWake: false, beforePrepMinutes: 0, repeatLabel: '매주 월 · 수', recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO,WE' });
    expect(a.alarms.map((x) => x.kind)).toEqual(['PREPARE', 'DEPARTURE', 'ARRIVE']);
  });

  it('도착 목표는 늘 켜짐, 알람을 모두 끄면 일정도 꺼짐', () => {
    const off = (row: AlarmRow): AlarmRow => ({ ...row, is_enabled: false });
    const a = toAppointment(meeting({ alarms: meeting().alarms.map(off) }));
    expect(a.enabled).toBe(false);
    expect(a.alarms.find((x) => x.kind === 'ARRIVE')?.enabled).toBe(true);
    expect(a.alarms.filter((x) => x.kind !== 'ARRIVE').every((x) => !x.enabled)).toBe(true);
  });

  it('출발지 · 이동시간이 없으면 집 · 0분, 이동 출처는 화면 글자로', () => {
    const base = meeting().participant;
    expect(toAppointment(meeting({ participant: { ...base, origin_name: null, est_travel_minutes: null } }))).toMatchObject({ origin: '집', travelMinutes: 0 });
    expect(toAppointment(meeting({ participant: { ...base, travel_source: 'MANUAL' } })).travelSource).toBe('직접 입력');
    expect(toAppointment(meeting({ participant: { ...base, travel_source: 'CACHED' } })).travelSource).toBe('내 실측 이동시간');
  });

  it('강도 단계는 배경음 칸에서, 모르는 값이면 강도 칸에서', () => {
    const strong = meeting({ alarms: [alarmRow('w', 'WAKE', '08:00', { intensity: 'STRONG', sound_key: 'theme_urgent' })] });
    expect(toAppointment(strong).level).toBe(2);
    const unknownSound = meeting({ alarms: [alarmRow('w', 'WAKE', '08:00', { intensity: 'SOFT', sound_key: null })] });
    expect(toAppointment(unknownSound).level).toBe(0);
  });

  it('루틴 알람은 약속 알람 목록에 넣지 않음', () => {
    expect(toAlarmTime(alarmRow('r', 'ROUTINE', '07:00'))).toBeNull();
  });
});

describe('다음 알람 고르기 (pickNextAlarm)', () => {
  const morning = Date.parse(kstTime('07:55'));

  it('지금 이후 켜진 알람 중 가장 이른 것 (도착 목표 제외)', () => {
    const next = pickNextAlarm([toAppointment(meeting())], morning);
    expect(next?.alarm.kind).toBe('WAKE');
    expect(next && formatTime(next.alarm.at)).toBe('오전 8:00');
    expect(next?.appointment.title).toBe('팀 주간회의');
  });

  it('지난 알람과 꺼진 종류는 건너뜀', () => {
    const rows = meeting({ alarms: [alarmRow('a-wake', 'WAKE', '08:00', { is_enabled: false }), alarmRow('a-prep', 'PREPARE', '08:30'), alarmRow('a-dep', 'DEPARTURE', '09:00')] });
    const afterPrepare = Date.parse(kstTime('08:31'));
    expect(pickNextAlarm([toAppointment(rows)], morning)?.alarm.kind).toBe('PREPARE');
    expect(pickNextAlarm([toAppointment(rows)], afterPrepare)?.alarm.kind).toBe('DEPARTURE');
  });

  it('도착 목표뿐이거나 모두 지났으면 없음', () => {
    expect(pickNextAlarm([toAppointment(meeting())], Date.parse(kstTime('09:01')))).toBeNull(); // 남은 건 도착 목표뿐
    expect(pickNextAlarm([], morning)).toBeNull();
  });

  it('여러 약속 중 가장 이른 알람', () => {
    const later = meeting({ appointment: { ...meeting().appointment, appointment_id: 'appt-2', title: '저녁 약속' }, alarms: [alarmRow('b-wake', 'WAKE', '07:58')] });
    expect(pickNextAlarm([toAppointment(meeting()), toAppointment(later)], morning)?.appointment.title).toBe('저녁 약속');
  });
});
