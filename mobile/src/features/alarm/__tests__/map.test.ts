import { describe, expect, it } from '@jest/globals';

import { formatTime } from '@/lib/format';
import { alarmChain } from '@shared/calc/chain.ts';

import {
  autoTimesOf,
  beforePrepareOf,
  listBySeries,
  listOnePerSeries,
  onePerSeries,
  pickNextAlarm,
  STANDALONE_TITLE,
  toAlarmTime,
  toAppointment,
  toAppointmentDetail,
  toIntensity,
  toOccurrences,
  toScheduleItem,
  toStandaloneAppointment,
  type AlarmRow,
  type AppointmentRows,
  type StandaloneRow,
} from '../map';

// 목업 첫 화면과 같은 일정: 10시 팀 주간회의 (이동 50 · 여유 10 · 준비 60 · 준비 전 활동 30) -> 기상 8:00 · 준비 8:30 · 출발 9:00 · 도착 목표 9:50 (한국 시각)
const kstTime = (hhmm: string) => `2025-05-22T${hhmm}:00+09:00`;
const alarmRow = (id: string, type: AlarmRow['alarm_type'], hhmm: string, overrides: Partial<AlarmRow> = {}): AlarmRow => ({
  alarm_id: id,
  alarm_type: type,
  scheduled_at: kstTime(hhmm),
  intensity: 'NORMAL',
  voice_tone: 'NEUTRAL',
  sound_key: 'theme_default',
  vibration: null,
  is_enabled: true,
  time_source: 'AUTO',
  intensity_source: 'AUTO',
  ...overrides,
});

function meeting(overrides: Partial<AppointmentRows> = {}): AppointmentRows {
  return {
    appointment: { appointment_id: 'appt-1', title: '팀 주간회의', appointment_at: kstTime('10:00'), dest_name: '세종대학교', importance: 'NORMAL', recurrence_rule: null },
    participant: { participant_id: 'p-1', origin_name: '집', transport_type: 'TRANSIT', est_travel_minutes: 50, travel_source: 'API', prepare_minutes: 60, buffer_minutes: 10 },
    alarms: [alarmRow('a-arrive', 'ARRIVE', '09:50'), alarmRow('a-dep', 'DEPARTURE', '09:00'), alarmRow('a-prep', 'PREPARE', '08:30'), alarmRow('a-wake', 'WAKE', '08:00')],
    groupName: '캡스톤팀',
    items: ['노트북', '회의 자료'],
    ...overrides,
  };
}

const atOf = (a: ReturnType<typeof toAppointment>, kind: string) => a.alarms.find((x) => x.kind === kind);
const hm = (d: Date | undefined) => (d ? formatTime(d) : undefined);

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

  it('실제 준비는 기상~출발에서 준비 전 활동을 뺀 값 (준비 알람 ~ 출발) — "P80 여유"가 음수로 나오지 않게', () => {
    const a = toAppointment(meeting());
    expect(a.prepMinutes).toBe(30);
    expect(a.prepMinutes + a.beforePrepMinutes).toBe(a.predictedPrepMinutes);
  });

  it('저장된 알람 시각이 공용 계산(alarmChain)과 같은 규칙으로 나온 값임 — 예시 행이 서버 계산과 어긋나지 않는지', () => {
    const a = toAppointment(meeting());
    const chain = alarmChain({ at: a.at, travelMinutes: a.travelMinutes, bufferMinutes: a.bufferMinutes, prepareMinutes: a.predictedPrepMinutes, beforePrepareMinutes: a.beforePrepMinutes, withWake: a.withWake });
    expect(a.alarms.map((x) => [x.kind, x.at.getTime()])).toEqual(chain.map((x) => [x.kind, x.at.getTime()]));
    expect(a.alarms.every((x) => x.auto == null)).toBe(true); // 직접 고른 시각이 없으면 auto 없음
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

  it('강도 단계는 알람 순서와 상관없이 기상 알람에서 읽음 (DB가 돌려주는 순서에 기대지 않음)', () => {
    const wake = alarmRow('w', 'WAKE', '08:00', { sound_key: 'theme_urgent', intensity: 'STRONG' });
    const others = [alarmRow('a', 'ARRIVE', '09:50', { sound_key: 'theme_calm', intensity: 'SOFT' }), alarmRow('p', 'PREPARE', '08:30', { sound_key: 'theme_calm', intensity: 'SOFT' })];
    expect(toAppointment(meeting({ alarms: [...others, wake] })).level).toBe(2);
    expect(toAppointment(meeting({ alarms: [wake, ...others] })).level).toBe(2);
  });

  it('직접 고른 강도가 저장된 알람이 있으면 그 알람에서 읽음 — 제안 적용(S01)이 준비 알람만 바꿨어도 카드 단계가 따라감, H03과 같은 알람', () => {
    const wake = alarmRow('w', 'WAKE', '08:00');
    const prepare = alarmRow('p', 'PREPARE', '08:30', { sound_key: 'theme_urgent', intensity: 'STRONG', intensity_source: 'MANUAL' });
    for (const alarms of [[prepare, wake], [wake, prepare]]) {
      const rows = meeting({ alarms });
      expect(toAppointment(rows).level).toBe(2);
      expect(toIntensity(rows.alarms, 'NORMAL', 0).axes.sound).toEqual({ level: 2, manual: true });
    }
  });

  it('기상 알람이 없으면 첫 알람에서 읽음', () => {
    expect(toAppointment(meeting({ alarms: [alarmRow('p', 'PREPARE', '08:30', { sound_key: 'theme_urgent', intensity: 'STRONG' })] })).level).toBe(2);
    expect(toAppointment(meeting({ alarms: [] })).level).toBe(1);
  });

  it('루틴 알람은 약속 알람 목록에 넣지 않음', () => {
    expect(toAlarmTime(alarmRow('r', 'ROUTINE', '07:00'))).toBeNull();
  });
});

describe('직접 고른 알람 시각의 자동값 (공용 역산으로 채움)', () => {
  const withRows = (rows: AlarmRow[]) => meeting({ alarms: rows });

  it('기상을 7:45로 직접 골랐으면 auto = 8:00, 따라 움직인 준비(자동)는 auto 없음 · 준비 전 활동은 두 알람 간격', () => {
    const rows = withRows([
      alarmRow('a-wake', 'WAKE', '07:45', { time_source: 'MANUAL' }),
      alarmRow('a-prep', 'PREPARE', '08:15'),
      alarmRow('a-dep', 'DEPARTURE', '09:00'),
      alarmRow('a-arrive', 'ARRIVE', '09:50'),
    ]);
    const a = toAppointment(rows);
    expect(hm(atOf(a, 'WAKE')?.auto)).toBe('오전 8:00');
    expect(hm(atOf(a, 'WAKE')?.at)).toBe('오전 7:45');
    expect(atOf(a, 'PREPARE')?.auto).toBeUndefined();
    expect(a.beforePrepMinutes).toBe(30);
  });

  it('출발을 8:55로 직접 골랐으면 auto = 9:00', () => {
    const a = toAppointment(
      withRows([alarmRow('a-wake', 'WAKE', '08:00'), alarmRow('a-prep', 'PREPARE', '08:30'), alarmRow('a-dep', 'DEPARTURE', '08:55', { time_source: 'MANUAL' }), alarmRow('a-arrive', 'ARRIVE', '09:50')]),
    );
    expect(hm(atOf(a, 'DEPARTURE')?.auto)).toBe('오전 9:00');
  });

  it('직접 고른 것으로 저장됐어도 자동값과 같은 시각이면 직접 고름이 아님 (alarmChain 규칙)', () => {
    const a = toAppointment(withRows([alarmRow('a-wake', 'WAKE', '08:00', { time_source: 'MANUAL' }), alarmRow('a-dep', 'DEPARTURE', '09:00')]));
    expect(atOf(a, 'WAKE')?.auto).toBeUndefined();
  });

  it('준비를 직접 골랐으면 간격이 준비 전 활동이 아니므로 기본 20분으로 자동값을 구함', () => {
    const rows = withRows([alarmRow('a-wake', 'WAKE', '08:00'), alarmRow('a-prep', 'PREPARE', '08:40', { time_source: 'MANUAL' }), alarmRow('a-dep', 'DEPARTURE', '09:00')]);
    expect(beforePrepareOf(rows.alarms)).toBe(20);
    expect(hm(autoTimesOf(rows).PREPARE)).toBe('오전 8:20');
  });

  it('직접 고른 시각이 없으면 계산하지 않음', () => {
    expect(autoTimesOf(meeting())).toEqual({});
  });

  it('따로 울리는 기상(wake_detached, #624): 준비가 기상을 따라가지 않는 일정 — 간격이 240분 안쪽이어도 준비 전 활동 0, 기상은 직접 고름', () => {
    const base = meeting();
    const rows = { ...base, participant: { ...base.participant, wake_detached: true }, alarms: [alarmRow('a-wake', 'WAKE', '06:30', { time_source: 'MANUAL' }), alarmRow('a-prep', 'PREPARE', '08:00'), alarmRow('a-dep', 'DEPARTURE', '09:00')] };
    const a = toAppointment(rows);
    expect(a.withWake).toBe(false);
    expect(a.beforePrepMinutes).toBe(0);
    expect(a.prepMinutes).toBe(60);
    expect(hm(atOf(a, 'WAKE')?.auto)).toBe('오전 8:00'); // 기상 없는 계산의 준비 시각 — 직접 고른 기상으로 남음
    expect(toAppointment({ ...rows, participant: base.participant }).beforePrepMinutes).toBe(90); // 표시가 없으면 간격을 준비 전 활동으로
  });

  it('간격이 240분을 넘으면 준비 전 활동이 아님 — 따로 울리는 기상(#624: 기상 08:00 직접 고름, 준비 13:45 자동)', () => {
    const lone = [alarmRow('a-wake', 'WAKE', '08:00', { time_source: 'MANUAL' }), alarmRow('a-prep', 'PREPARE', '13:45')];
    expect(beforePrepareOf(lone)).toBe(0);
    expect(beforePrepareOf([alarmRow('a-wake', 'WAKE', '08:00'), alarmRow('a-prep', 'PREPARE', '12:00')])).toBe(240);
  });

  it('기상 · 준비 중 하나만 있으면 준비 전 활동 0', () => {
    expect(beforePrepareOf([alarmRow('a-wake', 'WAKE', '08:00')])).toBe(0);
    expect(beforePrepareOf([alarmRow('a-prep', 'PREPARE', '08:30')])).toBe(0);
  });
});

describe('일정 없는 알람 (D46)', () => {
  const row = (overrides: Partial<StandaloneRow> = {}): StandaloneRow => ({ ...alarmRow('s-1', 'WAKE', '07:00'), recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', ...overrides });

  it('제목은 서버와 같은 "알람", 시각 하나짜리 일정으로 그림', () => {
    const a = toStandaloneAppointment(row());
    expect(a).toMatchObject({ id: 's-1', title: '알람', standalone: true, enabled: true, withWake: true, repeatLabel: '평일', travelMinutes: 0, level: 1 });
    expect(STANDALONE_TITLE).toBe('알람');
    expect(a.alarms.map((x) => `${x.kind} ${formatTime(x.at)}`)).toEqual(['WAKE 오전 7:00']);
  });

  it('끈 알람은 일정도 꺼짐, 반복이 없으면 반복 없음', () => {
    expect(toStandaloneAppointment(row({ is_enabled: false, recurrence_rule: null }))).toMatchObject({ enabled: false, repeatLabel: '반복 없음' });
  });

  it('다음 알람 고르기에도 들어감', () => {
    const next = pickNextAlarm([toStandaloneAppointment(row())], Date.parse(kstTime('06:00')));
    expect(next?.appointment.title).toBe('알람');
    expect(next && formatTime(next.alarm.at)).toBe('오전 7:00');
  });
});

describe('하루 일정 한 줄 (toScheduleItem)', () => {
  const appointment = meeting().appointment;

  it('알람이 있으면 hasAlarm, 알람 없는 일정도 한 줄', () => {
    expect(toScheduleItem({ appointment, alarms: [{ alarm_type: 'WAKE' }, { alarm_type: 'ARRIVE' }] })).toMatchObject({ appointmentId: 'appt-1', title: '팀 주간회의', place: '세종대학교', importance: 'NORMAL', hasAlarm: true });
    expect(toScheduleItem({ appointment, alarms: [] }).hasAlarm).toBe(false);
  });
});

describe('알람 설정 읽기 (toAppointmentDetail · toIntensity)', () => {
  const manualStrong = (overrides: Partial<AlarmRow> = {}) =>
    alarmRow('a-wake', 'WAKE', '08:00', { intensity_source: 'MANUAL', sound_key: 'theme_urgent', voice_tone: 'NEUTRAL', intensity: 'NORMAL', ...overrides });

  it('직접 고른 강도(intensity_source = MANUAL)에서 자동 값과 다른 칸만 "직접 고름"', () => {
    const intensity = toIntensity([manualStrong()], 'NORMAL', 0);
    expect(intensity).toMatchObject({ auto: 1, importancePoint: 0, lateCount: 0, latePoint: 0 }); // 중요(NORMAL)는 올림 없음 (D69)
    expect(intensity.axes).toEqual({ sound: { level: 2, manual: true }, voice: { level: 1, manual: false }, vibration: { level: 1, manual: false } });
  });

  it('AUTO로 저장된 강도는 칸이 달라도 자동으로 봄 (지금 자동 값을 따라감)', () => {
    const intensity = toIntensity([alarmRow('a-wake', 'WAKE', '08:00', { sound_key: 'theme_urgent' })], 'NORMAL', 0);
    expect(intensity.axes.sound).toEqual({ level: 1, manual: false });
  });

  it('최근 4주 지각 2번 이상이면 자동 한 단계 위, 점수도 같이', () => {
    expect(toIntensity([], 'NORMAL', 2)).toMatchObject({ auto: 2, latePoint: 1, lateCount: 2 });
    expect(toIntensity([], 'LOW', 2)).toMatchObject({ auto: 2, latePoint: 1 }); // 기본 보통에서 한 단계 올림 (D69)
  });

  it('D69 기본 보통: 중요도 평소(LOW)도 중, 매우 중요(HIGH)만 한 단계 올려 강 — 중요도 올림 점수도 같이', () => {
    expect(toIntensity([], 'LOW', 0)).toMatchObject({ auto: 1, importancePoint: 0 });
    expect(toIntensity([], 'NORMAL', 0)).toMatchObject({ auto: 1, importancePoint: 0 });
    expect(toIntensity([], 'HIGH', 0)).toMatchObject({ auto: 2, importancePoint: 1 });
  });

  it('잠귀 무거움(HEAVY)이면 보통 일정도 곧바로 강, 매우 중요 · 지각이어도 최대 강 — 가벼움 · 보통 · 안 줌은 기본 보통', () => {
    expect(toIntensity([], 'NORMAL', 0, 'HEAVY')).toMatchObject({ auto: 2 });
    expect(toIntensity([], 'LOW', 0, 'HEAVY').axes.sound).toEqual({ level: 2, manual: false });
    expect(toIntensity([], 'HIGH', 2, 'HEAVY')).toMatchObject({ auto: 2, importancePoint: 1, latePoint: 1 });
    expect(toIntensity([], 'LOW', 0, 'NORMAL')).toMatchObject({ auto: 1 });
    expect(toIntensity([], 'LOW', 0)).toMatchObject({ auto: 1 });
    expect(toAppointmentDetail(meeting(), 0, 'HEAVY').intensity.auto).toBe(2);
    expect(toAppointmentDetail(meeting(), 0).intensity.auto).toBe(1);
    // 설정의 기본 말소리(강 = 2)는 말소리 축의 자동 값만 바꿈 (H03이 voiceAuto로 그림)
    expect(toIntensity([], 'NORMAL', 0, 'NORMAL', 2)).toMatchObject({ auto: 1, voiceAuto: 2, axes: { voice: { level: 2, manual: false }, sound: { level: 1, manual: false } } });
    expect(toIntensity([], 'NORMAL', 0)).toMatchObject({ voiceAuto: 1 });
  });

  it('HEAVY인 사람의 저장된 강 칸은 자동 값과 같아서 직접 고름이 아님 (잠귀를 반영한 자동 값과 비교)', () => {
    const intensity = toIntensity([manualStrong()], 'NORMAL', 0, 'HEAVY');
    expect(intensity.axes.sound).toEqual({ level: 2, manual: false });
    expect(intensity.axes.voice).toEqual({ level: 1, manual: true }); // 말소리 칸은 보통으로 저장돼 있어 자동(강)과 달라 직접 고름
  });

  it('직접 고른 약은 중요도 평소여도 그대로 약(직접 고름) — 약은 직접 고를 때만 나옴', () => {
    const soft = alarmRow('a-wake', 'WAKE', '08:00', { intensity_source: 'MANUAL', intensity: 'SOFT', sound_key: 'theme_calm', voice_tone: 'CALM', vibration: 'NONE' });
    const intensity = toIntensity([soft], 'LOW', 0);
    expect(intensity.auto).toBe(1);
    expect(intensity.axes).toEqual({ sound: { level: 0, manual: true }, voice: { level: 0, manual: true }, vibration: { level: 0, manual: true } });
  });

  it('기상 알람의 직접 값이 먼저, 없으면 다른 알람의 직접 값', () => {
    const rows = [alarmRow('a-dep', 'DEPARTURE', '09:00', { intensity_source: 'MANUAL', intensity: 'SOFT', sound_key: 'theme_calm', voice_tone: 'CALM', vibration: 'NONE' }), alarmRow('a-wake', 'WAKE', '08:00')];
    expect(toIntensity(rows, 'NORMAL', 0).axes.vibration).toEqual({ level: 0, manual: true });
  });

  it('진동 축은 vibration 칸만 읽음 — intensity(전체 세기)가 자동과 달라도 vibration이 비었으면 진동은 자동 (D1 A)', () => {
    const soundOnly = manualStrong({ intensity: 'STRONG' }); // 전체 세기만 강, 진동 칸은 NULL
    expect(toIntensity([soundOnly], 'NORMAL', 0).axes.vibration).toEqual({ level: 1, manual: false });
    const picked = manualStrong({ vibration: 'STRONG_CONTINUOUS' });
    expect(toIntensity([picked], 'NORMAL', 0).axes).toEqual({ sound: { level: 2, manual: true }, voice: { level: 1, manual: false }, vibration: { level: 2, manual: true } });
    // 고른 진동이 자동과 같은 단계면 자동으로 봄 (다른 축과 같은 규칙)
    expect(toIntensity([manualStrong({ vibration: 'SHORT_REPEAT' })], 'NORMAL', 0).axes.vibration).toEqual({ level: 1, manual: false });
  });

  it('H03 초안의 처음 모양: 직접 입력한 이동 · 직접 고른 시각만 값, 준비는 늘 자동(null)', () => {
    const rows = meeting({
      participant: { ...meeting().participant, travel_source: 'MANUAL', est_travel_minutes: 40 },
      alarms: [alarmRow('a-wake', 'WAKE', '07:45', { time_source: 'MANUAL' }), alarmRow('a-prep', 'PREPARE', '08:15'), alarmRow('a-dep', 'DEPARTURE', '09:00'), alarmRow('a-arrive', 'ARRIVE', '09:50')],
    });
    const detail = toAppointmentDetail(rows, 0);
    expect(detail.edits).toMatchObject({ bufferMinutes: 10, origin: '집', transport: 'TRANSIT', travelMinutes: 40, prepareMinutes: null });
    expect(hm(detail.edits.times.WAKE)).toBe('오전 7:45');
    expect(detail.edits.times.PREPARE).toBeUndefined();
    expect(detail.auto).toEqual({ travelMinutes: 40, predictedPrepMinutes: 60 });
  });

  it('길찾기로 구한 이동은 직접 입력이 아님 (edits.travelMinutes = null)', () => {
    expect(toAppointmentDetail(meeting(), 0).edits.travelMinutes).toBeNull();
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

describe('onePerSeries — H02 목록은 반복 묶음당 하나', () => {
  const at = (day: number) => ({ at: new Date(`2025-05-${String(day).padStart(2, '0')}T10:00:00+09:00`), day });
  const now = Date.parse('2025-05-22T07:55:00+09:00');
  const days = (entries: Parameters<typeof onePerSeries<ReturnType<typeof at>>>[0]) => onePerSeries(entries, now).map((x) => x.day).sort((a, b) => a - b);

  it('같은 묶음은 지금 이후 가장 가까운 회차 하나 — 지난 회차 · 먼 회차는 빠짐', () => {
    expect(days([15, 29, 22, 23].map((d) => ({ seriesId: 'S', item: at(d) })))).toEqual([22]);
  });

  it('묶음 번호가 없거나 서로 다르면 모두 그대로, 한 장뿐인 묶음은 지난 것도 그대로', () => {
    expect(days([{ seriesId: null, item: at(10) }, { seriesId: undefined, item: at(11) }, { seriesId: 'A', item: at(12) }, { seriesId: 'B', item: at(25) }])).toEqual([10, 11, 12, 25]);
  });

  it('묶음의 회차가 전부 지났으면 가장 최근 지난 회차 하나', () => {
    expect(days([8, 15, 12].map((d) => ({ seriesId: 'S', item: at(d) })))).toEqual([15]);
  });

  it('지금 시각과 같은 회차는 "이후"로 침', () => {
    expect(onePerSeries([{ seriesId: 'S', item: { at: new Date(now) } }, { seriesId: 'S', item: { at: new Date(now + 86_400_000) } }], now)).toEqual([{ at: new Date(now) }]);
  });
});

describe('listBySeries · listOnePerSeries — 카드의 "앞으로 회차가 걸림" 표시에 쓰는 남은 회차 수', () => {
  const at = (day: number) => ({ at: new Date(`2025-05-${String(day).padStart(2, '0')}T10:00:00+09:00`), day });
  const now = Date.parse('2025-05-22T07:55:00+09:00');

  it('묶음마다 가장 가까운 회차 하나와 지금 이후 남은 회차 수 — 지난 회차는 세지 않음', () => {
    const out = listBySeries([15, 22, 29, 30].map((d) => ({ seriesId: 'S', item: at(d) })), now);
    expect(out.map((x) => [x.item.day, x.upcoming])).toEqual([[22, 3]]);
  });

  it('묶음 번호가 없으면 0, 전부 지난 묶음도 0 (가장 최근 지난 회차 하나)', () => {
    const out = listBySeries([{ seriesId: null, item: at(10) }, ...[8, 15].map((d) => ({ seriesId: 'S', item: at(d) }))], now);
    expect(out.map((x) => [x.item.day, x.upcoming])).toEqual([
      [10, 0],
      [15, 0],
    ]);
  });

  it('counted를 주면 그 조건의 회차만 셈 — 보여 줄 회차 고르기는 그대로', () => {
    const out = listBySeries([22, 23, 24, 25].map((d) => ({ seriesId: 'S', item: at(d) })), now, (x) => x.day !== 23);
    expect(out.map((x) => [x.item.day, x.upcoming])).toEqual([[22, 3]]);
  });

  it('listOnePerSeries: 켜진 알람이 있는 회차만 세어 upcomingCount (꺼 둔 회차는 안 셈)', () => {
    const base = toAppointment(meeting());
    const row = (id: string, day: number, enabled: boolean) => ({ ...base, id, at: at(day).at, enabled });
    const out = listOnePerSeries([23, 24, 25].map((d) => ({ seriesId: 'S', item: row(`s-${d}`, d, d !== 24) })), now);
    expect(out.map((a) => [a.id, a.upcomingCount])).toEqual([['s-23', 2]]);
  });

  it('listOnePerSeries: 앞으로 회차가 둘 이상인 묶음에만 upcomingCount를 붙이고 시각 순으로', () => {
    const base = toAppointment(meeting());
    const row = (id: string, day: number) => ({ ...base, id, at: at(day).at });
    const out = listOnePerSeries(
      [
        { seriesId: 'S', item: row('s-29', 29) },
        { seriesId: 'S', item: row('s-26', 26) },
        { seriesId: 'S', item: row('s-23', 23) },
        { seriesId: 'T', item: row('t-24', 24) }, // 앞으로 한 장뿐인 묶음
        { seriesId: null, item: row('one', 25) },
      ],
      now,
    );
    expect(out.map((a) => [a.id, a.upcomingCount])).toEqual([
      ['s-23', 3],
      ['t-24', undefined],
      ['one', undefined],
    ]);
  });
});

describe('toOccurrences — H03 회차 목록 (지금 이후, 시각 순)', () => {
  const now = Date.parse('2025-05-22T07:55:00+09:00');
  const dayText = (day: number) => `2025-05-${String(day).padStart(2, '0')}`;
  const row = (id: string, day: number, alarms: [AlarmRow['alarm_type'], string, boolean?][]) => ({
    appointment: { appointment_id: id, appointment_at: `${dayText(day)}T10:00:00+09:00` },
    alarms: alarms.map(([alarm_type, hhmm, is_enabled = true]) => ({ alarm_type, scheduled_at: `${dayText(day)}T${hhmm}:00+09:00`, is_enabled })),
  });

  it('지난 회차는 빼고 시각 순, 회차마다 앞으로 가장 먼저 울릴 켜진 알람 시각', () => {
    const out = toOccurrences(
      [
        row('o-29', 29, [['WAKE', '08:00'], ['DEPARTURE', '09:00']]),
        row('o-15', 15, [['WAKE', '08:00']]),
        row('o-22', 22, [['WAKE', '07:30'], ['PREPARE', '08:30'], ['ARRIVE', '09:50']]), // 기상은 지났고 준비가 다음
      ],
      now,
    );
    expect(out.map((x) => [x.id, x.alarmAt ? formatTime(x.alarmAt) : null])).toEqual([
      ['o-22', '오전 8:30'],
      ['o-29', '오전 8:00'],
    ]);
  });

  it('도착 목표 · 꺼진 알람만 있으면 alarmAt은 null', () => {
    const out = toOccurrences([row('o-23', 23, [['WAKE', '08:00', false], ['ARRIVE', '09:50']]), row('o-24', 24, [])], now);
    expect(out.map((x) => [x.id, x.alarmAt])).toEqual([
      ['o-23', null],
      ['o-24', null],
    ]);
  });
});
