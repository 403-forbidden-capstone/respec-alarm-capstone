import { describe, expect, it } from '@jest/globals';

import { dayKey, formatTime } from '@/lib/format';

import { weekDays } from '../calendar';
import {
  actualRow,
  actualRows,
  recordRows,
  alarmPatch,
  factsOf,
  isApplicableValue,
  isPlanned,
  isUuid,
  latestCoaching,
  plannedRow,
  SUGGESTION_REASON,
  toSuggestion,
  valueText,
  wakeRowsOf,
  type EventRow,
  type PlannedAlarmRow,
  type RecordRow,
  type SuggestionRow,
  type SuggestionTarget,
} from '../map';

// 2026-10-19 월요일 한국 시간 7:20 = 2026-10-18T22:20Z
const record = (date: string, patch: Partial<RecordRow> = {}): RecordRow => ({
  record_date: date,
  sleep_at: null,
  wake_reported_at: null,
  wake_confirmed_at: null,
  actual_prepare_minutes: null,
  routine_done_rate: null,
  sleep_satisfaction: null,
  condition_note: null,
  data_source: 'ALARM',
  ...patch,
});

describe('factsOf — daily_records 한 줄 → 달력 점 사실', () => {
  it('기상 확인 · 준비 실측 · 그 밖의 기록을 나눠 봄', () => {
    expect(factsOf(record('2026-10-19', { wake_confirmed_at: '2026-10-18T22:30:00Z', actual_prepare_minutes: 40 }), false)).toEqual({
      woke: true,
      prepared: true,
      journal: false,
      any: true,
    });
    expect(factsOf(record('2026-10-17', { wake_confirmed_at: '2026-10-17T00:30:00Z' }), false)).toMatchObject({ woke: true, prepared: false, any: true });
    expect(factsOf(record('2026-10-17', { condition_note: '피곤' }), false)).toMatchObject({ woke: false, prepared: false, any: true });
  });

  it('행이 없거나 빈 행이면 기록 없음, 일기만 있어도 일기 표시', () => {
    expect(factsOf(undefined, false)).toEqual({ woke: false, prepared: false, journal: false, any: false });
    expect(factsOf(record('2026-10-17'), false).any).toBe(false);
    expect(factsOf(undefined, true).journal).toBe(true);
  });
});

describe('wakeRowsOf — 주간 요약에 넣을 날', () => {
  const days = weekDays(new Date('2026-10-19T00:00:00Z')); // 10/19 월 ~ 10/25 일
  const alarm = (iso: string) => iso;

  it('기상 확인과 그날 기상 알람이 둘 다 있는 날만, 점수는 알람 + 10분 안이면 88 · 넘으면 61', () => {
    const rows = wakeRowsOf(
      days,
      [
        record('2026-10-19', { wake_confirmed_at: '2026-10-18T22:29:00Z' }), // 7:29, 알람 7:20 → 9분
        record('2026-10-20', { wake_confirmed_at: '2026-10-19T22:31:00Z' }), // 7:31, 알람 7:20 → 11분
        record('2026-10-21', { wake_confirmed_at: '2026-10-20T22:20:00Z' }), // 기상 알람 없음
        record('2026-10-22'), // 기상 확인 없음
      ],
      [alarm('2026-10-18T22:20:00Z'), alarm('2026-10-19T22:20:00Z'), alarm('2026-10-21T22:20:00Z')],
    );
    expect(rows.map((r) => [dayKey(r.date), r.wake, r.score])).toEqual([
      ['2026-10-19', 449, 88],
      ['2026-10-20', 451, 61],
    ]);
  });

  it('그날 기상 알람이 여럿이면 가장 이른 알람이 목표', () => {
    const rows = wakeRowsOf(days, [record('2026-10-19', { wake_confirmed_at: '2026-10-18T22:40:00Z' })], ['2026-10-18T23:30:00Z', '2026-10-18T22:20:00Z']);
    expect(rows.map((r) => r.score)).toEqual([61]); // 7:40 − 7:20 = 20분
  });
});

describe('latestCoaching — 그 주 AI 코칭', () => {
  it('가장 최근 일기의 코칭, 비었으면 빈 글자', () => {
    expect(
      latestCoaching([
        { record_date: '2026-10-19', coaching_insight: '월요일 코칭' },
        { record_date: '2026-10-21', coaching_insight: '  수요일 코칭 ' },
        { record_date: '2026-10-22', coaching_insight: '' },
      ]),
    ).toBe('수요일 코칭');
    expect(latestCoaching([])).toBe('');
    expect(latestCoaching([{ record_date: '2026-10-19', coaching_insight: null }])).toBe('');
  });
});

describe('일간 — 설정한 값', () => {
  const row = (patch: Partial<PlannedAlarmRow> = {}): PlannedAlarmRow => ({
    alarm_id: 'a1',
    alarm_type: 'WAKE',
    scheduled_at: '2026-10-18T22:20:00Z',
    is_enabled: true,
    appointment_participants: { appointments: { title: '수업' } },
    routines: null,
    ...patch,
  });

  it('종류별 이름 · 출처는 약속(없으면 루틴 · 일정 없는 알람) 이름', () => {
    expect(plannedRow(row(), null)).toEqual({ at: new Date('2026-10-18T22:20:00Z'), label: '기상 알람', source: '수업' });
    expect(plannedRow(row({ alarm_type: 'ARRIVE' }), null).label).toBe('도착 목표');
    expect(plannedRow(row({ alarm_type: 'ROUTINE', appointment_participants: null, routines: { title: '저녁 루틴' } }), null)).toMatchObject({ label: '루틴 알람', source: '저녁 루틴' });
    expect(plannedRow(row({ appointment_participants: null }), null).source).toBe('일정 없는 알람');
  });

  it('오늘이면 지난 알람에 past 표시, 지난 날은 표시 없음', () => {
    const nowMs = Date.parse('2026-10-18T22:30:00Z');
    expect(plannedRow(row(), nowMs).past).toBe(true);
    expect(plannedRow(row({ scheduled_at: '2026-10-19T00:00:00Z' }), nowMs).past).toBe(false);
    expect('past' in plannedRow(row(), null)).toBe(false);
  });

  it('꺼 둔 알람은 도착 목표까지 빼고 켜진 알람만 넣음 (일정을 통째로 꺼 둔 날 도착 목표만 남지 않게)', () => {
    expect(isPlanned({ is_enabled: false })).toBe(false);
    expect(isPlanned({ is_enabled: true })).toBe(true);
    const rows = [
      { alarm_type: 'WAKE', is_enabled: false },
      { alarm_type: 'PREPARE', is_enabled: false },
      { alarm_type: 'ARRIVE', is_enabled: false },
    ];
    expect(rows.filter(isPlanned)).toEqual([]);
    expect([{ alarm_type: 'WAKE', is_enabled: true }, { alarm_type: 'ARRIVE', is_enabled: true }].filter(isPlanned)).toHaveLength(2);
  });
});

describe('일간 — 실제로 일어난 일', () => {
  const event = (patch: Partial<EventRow> & Pick<EventRow, 'event_type'>): EventRow => ({
    event_id: 1,
    event_at: '2026-10-18T22:20:00Z',
    snooze_minutes: null,
    input_source: null,
    alarms: { alarm_type: 'WAKE', appointment_participants: null },
    ...patch,
  });
  const text = (e: EventRow) => {
    const r = actualRow(e);
    return r && `${formatTime(r.at)} ${r.label} · ${r.source}`;
  };

  it('서버가 now()로 채운 마이크로초 시각(놓침 기록의 event_at 등)도 읽음', () => {
    expect(text(event({ event_type: 'TRIGGERED', event_at: '2026-10-18T22:20:30.123456+00:00' }))).toBe('오전 7:20 기상 알람 울림 · 자동');
    expect(actualRow(event({ event_type: 'TRIGGERED', event_at: '2026-10-18T22:20:30.123456+00:00' }))?.at.getTime()).toBe(Date.UTC(2026, 9, 18, 22, 20, 30, 123));
  });

  it('울림 · 해제 · 미루기 · 놓침은 폰이 남긴 기록이라 자동 (가짜 데이터와 같은 글자)', () => {
    expect(text(event({ event_type: 'TRIGGERED' }))).toBe('오전 7:20 기상 알람 울림 · 자동');
    expect(text(event({ event_type: 'DISMISSED', event_at: '2026-10-18T22:23:00Z', input_source: 'BUTTON' }))).toBe('오전 7:23 기상 알람 해제 · 자동');
    expect(text(event({ event_type: 'SNOOZED', snooze_minutes: 10 }))).toBe('오전 7:20 기상 알람 10분 미루기 · 자동');
    expect(text(event({ event_type: 'SNOOZED' }))).toBe('오전 7:20 기상 알람 미루기 · 자동');
    expect(text(event({ event_type: 'MISSED' }))).toBe('오전 7:20 기상 알람 놓침 · 자동');
  });

  it('기상 확인 · 원탭 응답은 어떻게 남았는지(input_source)를 출처로', () => {
    expect(text(event({ event_type: 'WAKE_CONFIRMED', input_source: 'USAGE' }))).toBe('오전 7:20 기상 확인 · 자동 판정');
    expect(text(event({ event_type: 'WAKE_CONFIRMED', input_source: 'BUTTON' }))).toBe('오전 7:20 기상 확인 · 직접 응답');
    expect(text(event({ event_type: 'WAKE_CONFIRMED' }))).toBe('오전 7:20 기상 확인 · 자동');
    const dep = { alarms: { alarm_type: 'DEPARTURE' as const, appointment_participants: null } };
    expect(text(event({ event_type: 'ACKNOWLEDGED', input_source: 'LOCATION', ...dep }))).toBe('오전 7:20 집 출발 · 자동 · 지오펜스');
    expect(text(event({ event_type: 'ACKNOWLEDGED', input_source: 'BUTTON', alarms: { alarm_type: 'PREPARE', appointment_participants: null } }))).toBe('오전 7:20 준비 시작 · 직접 응답');
    expect(text(event({ event_type: 'ACKNOWLEDGED', input_source: 'BUTTON', alarms: { alarm_type: 'ROUTINE', appointment_participants: null } }))).toBe('오전 7:20 루틴 단계 완료 · 직접 응답');
  });

  it('도착은 지각 여부까지', () => {
    const arrive = (p: { is_late: boolean | null; late_minutes: number | null } | null) =>
      text(event({ event_type: 'ARRIVAL_CONFIRMED', input_source: 'BUTTON', alarms: { alarm_type: 'ARRIVE', appointment_participants: p } }));
    expect(arrive({ is_late: false, late_minutes: null })).toBe('오전 7:20 도착 · 지각 아님 · 직접 응답');
    expect(arrive({ is_late: true, late_minutes: 3 })).toBe('오전 7:20 도착 · 3분 지각 · 직접 응답');
    expect(arrive({ is_late: true, late_minutes: null })).toBe('오전 7:20 도착 · 지각 · 직접 응답');
    expect(arrive({ is_late: null, late_minutes: null })).toBe('오전 7:20 도착 · 직접 응답');
    expect(arrive(null)).toBe('오전 7:20 도착 · 직접 응답');
  });

  it('평가(FEEDBACK)는 일어난 일에 안 넣고, 알람 정보가 없어도 줄은 만듦', () => {
    expect(actualRow(event({ event_type: 'FEEDBACK' }))).toBeNull();
    expect(text(event({ event_type: 'DISMISSED', alarms: null }))).toBe('오전 7:20 알람 해제 · 자동');
  });

  it('생활 기록에만 있는 기상 확인 · 알람 해제는 일간에도 보임 (달력 점이 생활 기록으로 찍히니까) — 출처는 data_source', () => {
    const woke = record('2026-10-17', { wake_confirmed_at: '2026-10-17T00:30:00Z', wake_reported_at: '2026-10-17T00:25:00Z', data_source: 'MANUAL' });
    expect(recordRows(woke, []).map((r) => `${formatTime(r.at)} ${r.label} · ${r.source}`)).toEqual(['오전 9:25 기상 알람 해제 · 직접 입력', '오전 9:30 기상 확인 · 직접 입력']);
    expect(recordRows(record('2026-10-17', { wake_confirmed_at: '2026-10-17T00:30:00Z', data_source: 'AI' }), [])[0].source).toBe('AI 대화');
    expect(recordRows(record('2026-10-17', { wake_confirmed_at: '2026-10-17T00:30:00Z', data_source: 'ALARM' }), [])[0].source).toBe('자동');
    expect(recordRows(undefined, [])).toEqual([]);
    expect(recordRows(record('2026-10-17'), [])).toEqual([]); // 시각이 없으면 줄도 없음
  });

  it('울림 기록에 같은 일이 있으면 생활 기록 줄은 더하지 않음 (두 줄로 겹치지 않게)', () => {
    const woke = record('2026-10-19', { wake_confirmed_at: '2026-10-18T22:31:00Z', wake_reported_at: '2026-10-18T22:23:00Z' });
    const rows = actualRows(
      [
        event({ event_id: 1, event_type: 'DISMISSED', event_at: '2026-10-18T22:23:00Z' }),
        event({ event_id: 2, event_type: 'WAKE_CONFIRMED', event_at: '2026-10-18T22:31:00Z', input_source: 'USAGE' }),
      ],
      woke,
    );
    expect(rows.map((r) => `${r.label} · ${r.source}`)).toEqual(['기상 알람 해제 · 자동', '기상 확인 · 자동 판정']);
    // 한쪽만 있으면 있는 것만 더하고 시각순으로 섞음
    const half = actualRows([event({ event_id: 1, event_type: 'DISMISSED', event_at: '2026-10-18T22:23:00Z' })], woke);
    expect(half.map((r) => r.label)).toEqual(['기상 알람 해제', '기상 확인']);
  });

  it('시각순, 같은 시각이면 기록 번호순', () => {
    const rows = actualRows([
      event({ event_id: 3, event_type: 'WAKE_CONFIRMED', event_at: '2026-10-18T22:30:00Z' }),
      event({ event_id: 2, event_type: 'DISMISSED', event_at: '2026-10-18T22:20:00Z' }),
      event({ event_id: 1, event_type: 'TRIGGERED', event_at: '2026-10-18T22:20:00Z' }),
      event({ event_id: 4, event_type: 'FEEDBACK', event_at: '2026-10-18T22:31:00Z' }),
    ]);
    expect(rows.map((r) => r.label)).toEqual(['기상 알람 울림', '기상 알람 해제', '기상 확인']);
  });
});

describe('S01 제안 (DB 종류: 말소리 · 배경음 · 진동)', () => {
  const target = (patch: Partial<SuggestionTarget> = {}): SuggestionTarget => ({
    alarm_id: 'alarm-1',
    alarm_type: 'WAKE',
    scheduled_at: '2026-10-18T22:20:00Z',
    appointment_participants: { appointments: { appointment_id: 'appt-1', title: '수업', appointment_at: '2026-10-19T00:00:00Z' } },
    routines: null,
    ...patch,
  });
  const row = (patch: Partial<SuggestionRow> = {}): SuggestionRow => ({
    suggestion_id: 'sug-1',
    suggestion_type: 'VOICE_TONE',
    current_value: 'CALM',
    suggested_value: 'DIRECT',
    result_value: null,
    status: 'PENDING',
    target_alarm_id: 'alarm-1',
    ...patch,
  });

  it('값은 약 · 중 · 강 글자로, 제목 · 요약은 홈 카드에 그대로 씀', () => {
    const s = toSuggestion(row(), target())!;
    expect(s.title).toBe('기상 알람의 말소리를 바꿔 볼까요?');
    expect(s.summary).toBe('차분 · 다정 → 직설형');
    expect(s.reason).toBe(SUGGESTION_REASON);
    expect(s.change).toEqual({
      kind: 'VOICE_TONE',
      axis: '말소리',
      target: '10월 19일 (월) 수업 · 기상 알람',
      current: '차분 · 다정',
      suggested: '직설형',
      result: null,
    });
    expect([s.id, s.status, s.applied, s.deltas, s.appointment.id, s.appointment.title]).toEqual(['sug-1', 'PENDING', null, [], 'appt-1', '수업']);
    // 시각 칸은 대상 알람 시각으로 채움 — 화면은 안 씀
    expect([formatTime(s.currentWake), formatTime(s.proposedWake), s.minutes, s.bounds]).toEqual(['오전 7:20', '오전 7:20', 0, { earlier: 0, later: 0 }]);
  });

  it('배경음 · 진동 제목에 받침에 맞는 조사', () => {
    expect(toSuggestion(row({ suggestion_type: 'SOUND', current_value: 'theme_default', suggested_value: 'theme_calm' }), target())?.title).toBe('기상 알람의 배경음을 바꿔 볼까요?');
    const intensity = toSuggestion(row({ suggestion_type: 'INTENSITY', current_value: 'NORMAL', suggested_value: 'STRONG' }), target({ alarm_type: 'PREPARE' }))!;
    expect(intensity.title).toBe('준비 알람의 진동을 바꿔 볼까요?');
    expect(intensity.summary).toBe('짧게 반복 → 강하게 연속');
  });

  it('적용한 제안은 적용한 값과 applied를 가짐', () => {
    const s = toSuggestion(row({ status: 'APPLIED', result_value: 'DIRECT' }), target())!;
    expect(s.change?.result).toBe('직설형');
    expect(s.applied).toEqual({ wake: new Date('2026-10-18T22:20:00Z'), prepare: null, minutes: 0 });
  });

  it('약속이 없는 알람은 루틴 이름 · 알람 이름으로, 일정 id는 빈 글자', () => {
    const routine = toSuggestion(row(), target({ alarm_type: 'ROUTINE', appointment_participants: null, routines: { title: '저녁 루틴' } }))!;
    expect(routine.change?.target).toBe('10월 19일 (월) 저녁 루틴 · 루틴 알람');
    expect([routine.appointment.id, routine.appointment.title]).toEqual(['', '저녁 루틴']);
    const alone = toSuggestion(row(), target({ appointment_participants: null }))!;
    expect(alone.change?.target).toBe('10월 19일 (월) 기상 알람');
  });

  it('바꿀 알람이 없어졌으면 제안도 없음, 모르는 값은 값 그대로', () => {
    expect(toSuggestion(row(), null)).toBeNull();
    expect(valueText('SOUND', 'my_sound')).toBe('my_sound');
    expect(valueText('SOUND', null)).toBe('정해지지 않음');
    expect(valueText('SOUND', 'theme_urgent')).toBe('강한 소리');
  });

  it('적용할 수 있는 값: 말소리 · 진동은 DB 선택지 안, 배경음은 아무 이름', () => {
    expect(isApplicableValue('VOICE_TONE', 'DIRECT')).toBe(true);
    expect(isApplicableValue('VOICE_TONE', 'LOUD')).toBe(false);
    expect(isApplicableValue('INTENSITY', 'STRONG')).toBe(true);
    expect(isApplicableValue('INTENSITY', '')).toBe(false);
    expect(isApplicableValue('SOUND', 'any_sound')).toBe(true);
    expect(isApplicableValue('SOUND', '')).toBe(false);
  });

  it('알람 갱신 내용: 적용은 직접 고른 값으로 표시, 되돌림은 값만', () => {
    expect(alarmPatch('VOICE_TONE', 'DIRECT', true)).toEqual({ voice_tone: 'DIRECT', intensity_source: 'MANUAL' });
    expect(alarmPatch('SOUND', 'theme_urgent', true)).toEqual({ sound_key: 'theme_urgent', intensity_source: 'MANUAL' });
    expect(alarmPatch('INTENSITY', 'STRONG', true)).toEqual({ intensity: 'STRONG', intensity_source: 'MANUAL' });
    expect(alarmPatch('INTENSITY', 'SOFT', false)).toEqual({ intensity: 'SOFT' });
  });

  it('uuid 모양만 DB에서 찾음 (가짜 데이터 주소 s1이 남아 있어도 오류 없이 없음)', () => {
    expect(isUuid('2b9f6a4e-5c0e-4d3b-9a77-0a1b2c3d4e5f')).toBe(true);
    expect(isUuid('s1')).toBe(false);
  });
});
