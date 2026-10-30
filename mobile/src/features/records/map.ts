// DB 행 → R02 · S01 화면 타입 바꾸기 — 순수 함수만 (시험: __tests__/map.test.ts). 쿼리는 real.ts
// 실데이터 구현의 틀(features/alarm/map.ts와 같음): 쿼리는 real.ts에서 얇게, 행 → 화면 모양 변환은 여기서 순수 함수로
import { KIND_LABEL, LEVELS, type Level } from '@/features/alarm/types';
import { dbTimeMs, parseDbTime } from '@/lib/dbTime';
import { dayKey, formatDateShort, josa, minutesBetween, startOfDay } from '@/lib/format';
import type { Enums, Tables, TablesUpdate } from '@/types/database';
import { levelOfIntensity, levelOfSoundKey, levelOfVoiceTone } from '@shared/calc/intensity.ts';

import { NO_APPOINTMENTS, wakeScore, type AppointmentCounts, type DayFacts, type WakeRow } from './summary';
import type { Suggestion, SuggestionChange, TimelineRow } from './types';

// ---------------------------------------------------------------------------
// 월간 · 주간 (daily_records)
// ---------------------------------------------------------------------------

export type RecordRow = Pick<
  Tables<'daily_records'>,
  'record_date' | 'sleep_at' | 'wake_reported_at' | 'wake_confirmed_at' | 'actual_prepare_minutes' | 'routine_done_rate' | 'sleep_satisfaction' | 'condition_note' | 'data_source'
>;
export type JournalDayRow = Pick<Tables<'daily_journals'>, 'record_date' | 'coaching_insight'>;

// 그날 일정과 그 출발 · 도착 기록 — appointment_participants(내 참여 조건) × appointments. 달력 점이 "그날 있어야 할 기록"을 셈 (D27 C)
export type AppointmentDayRow = Pick<Tables<'appointment_participants'>, 'departed_at' | 'arrived_at'> & {
  appointments: Pick<Tables<'appointments'>, 'appointment_at' | 'exception_kind'>;
};

// 일정 행 → 날짜(YYYY-MM-DD, 한국 시간)별 일정 · 출발 · 도착 수. 이번만 지운 회차(exception_kind CANCELED)는 그날 일정이 아니라서 뺌
//   (지워도 참여 조건 행은 남으므로 읽은 뒤 여기서 거름). 약속 시각을 못 읽는 행도 뺌
export function appointmentCountsByDay(rows: readonly AppointmentDayRow[]): Map<string, AppointmentCounts> {
  const byDay = new Map<string, AppointmentCounts>();
  for (const row of rows) {
    if (row.appointments.exception_kind === 'CANCELED') continue;
    const at = dbTimeMs(row.appointments.appointment_at);
    if (Number.isNaN(at)) continue;
    const key = dayKey(new Date(at));
    const counts = byDay.get(key) ?? { total: 0, departed: 0, arrived: 0 };
    counts.total += 1;
    if (row.departed_at != null) counts.departed += 1;
    if (row.arrived_at != null) counts.arrived += 1;
    byDay.set(key, counts);
  }
  return byDay;
}

// 그날 기록 → 달력 점을 정하는 사실 (summary.ts dayMark에 넘김). 행이 없으면 일기만 봄. appointments = 그날 일정과 출발 · 도착 수 (안 넘기면 일정 없는 날)
export function factsOf(record: RecordRow | undefined, hasJournal: boolean, appointments: AppointmentCounts = NO_APPOINTMENTS): DayFacts {
  const woke = record?.wake_confirmed_at != null;
  const other =
    record != null &&
    (record.actual_prepare_minutes != null || record.sleep_at != null || record.wake_reported_at != null || record.routine_done_rate != null || record.sleep_satisfaction != null || record.condition_note != null);
  return { woke, journal: hasJournal, any: woke || other, appointments };
}

// 주간 요약의 한 줄 — 기상 확인(daily_records)이 있고 그날 켜진 기상 알람이 있어 점수를 낼 수 있는 날
//   목표 시각 = 그날 가장 이른 기상 알람 (여러 약속이 있어도 하루의 첫 기상). 점수는 summary.ts wakeScore
export function wakeRowsOf(days: readonly Date[], records: readonly RecordRow[], wakeAlarmAts: readonly string[]): WakeRow[] {
  const firstWakeAlarm = new Map<string, Date>();
  for (const at of wakeAlarmAts) {
    const date = parseDbTime(at);
    const key = dayKey(date);
    const known = firstWakeAlarm.get(key);
    if (!known || date.getTime() < known.getTime()) firstWakeAlarm.set(key, date);
  }
  return days.flatMap((date) => {
    const key = dayKey(date);
    const record = records.find((r) => r.record_date === key);
    const target = firstWakeAlarm.get(key);
    if (!record?.wake_confirmed_at || !target) return [];
    const midnight = startOfDay(date);
    const wake = minutesBetween(midnight, parseDbTime(record.wake_confirmed_at));
    return [{ date, wake, score: wakeScore(wake, minutesBetween(midnight, target)) }];
  });
}

// 그 주 AI 코칭 — 주 단위 글은 DB에 없어서 그 주에서 가장 최근 일기의 코칭을 보여 줌. 없으면 빈 글자
export function latestCoaching(journals: readonly JournalDayRow[]): string {
  const sorted = [...journals].sort((a, b) => b.record_date.localeCompare(a.record_date));
  return sorted.find((j) => j.coaching_insight?.trim())?.coaching_insight?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// 일간 (alarms 설정한 값 + alarm_events 실제로 일어난 일)
// ---------------------------------------------------------------------------

export type PlannedAlarmRow = Pick<Tables<'alarms'>, 'alarm_id' | 'alarm_type' | 'scheduled_at' | 'is_enabled'> & {
  appointment_participants: { appointments: { title: string } | null } | null;
  routines: { title: string } | null;
};

export type EventRow = Pick<Tables<'alarm_events'>, 'event_id' | 'event_type' | 'event_at' | 'snooze_minutes' | 'input_source'> & {
  alarms: {
    alarm_type: Enums<'alarm_type'>;
    appointment_participants: { is_late: boolean | null; late_minutes: number | null } | null;
  } | null;
};

const alarmName = (type: Enums<'alarm_type'>) => (type === 'ROUTINE' ? '루틴 알람' : `${KIND_LABEL[type]} 알람`);

// 켜져 있는 알람만 "설정한 값"에 넣음 — 꺼 둔 알람은 안 울리니 뺌
//   도착 목표(ARRIVE)도 같은 규칙: 화면(H03)은 도착 목표를 늘 켜짐으로 그리지만 DB 행은 울리는 알람(기상 · 준비 · 출발)이 하나라도 켜져 있을 때만 켜 두므로
//   (realWrite mirrorArrive) 일정을 통째로 꺼 둔 날에 도착 목표만 "설정한 값"에 남지 않음
export function isPlanned(row: Pick<PlannedAlarmRow, 'is_enabled'>): boolean {
  return row.is_enabled;
}

// 설정한 알람 한 줄. nowMs를 주면(오늘) 이미 지난 알람에 past 표시
export function plannedRow(row: PlannedAlarmRow, nowMs: number | null): TimelineRow {
  const at = parseDbTime(row.scheduled_at);
  const label = row.alarm_type === 'ARRIVE' ? `${KIND_LABEL.ARRIVE} 목표` : alarmName(row.alarm_type);
  const source = row.appointment_participants?.appointments?.title ?? row.routines?.title ?? '일정 없는 알람';
  return nowMs == null ? { at, label, source } : { at, label, source, past: at.getTime() <= nowMs };
}

// 어떻게 남은 기록인지 — 버튼 · 폰 사용 · 위치 · 직접 입력 (alarm_events.input_source). 가짜 데이터의 글자와 같음
const INPUT_SOURCE_TEXT: Record<Enums<'event_input_source'>, string> = {
  BUTTON: '직접 응답',
  LOCATION: '자동 · 지오펜스',
  VOICE: '음성',
  MANUAL: '직접 입력',
  USAGE: '자동 판정',
};
const inputSourceText = (source: EventRow['input_source']) => (source ? INPUT_SOURCE_TEXT[source] : '자동');

// 실제로 일어난 일 한 줄. 일어난 일로 보이지 않는 기록(평가)은 null
//   울림 · 해제 · 미루기 · 놓침은 폰이 알아서 남긴 것이라 '자동', 기상 확인 · 원탭 응답 · 도착 확인은 input_source로 어떻게 남았는지
export function actualRow(e: EventRow): TimelineRow | null {
  const at = parseDbTime(e.event_at);
  const type = e.alarms?.alarm_type;
  const name = type ? alarmName(type) : '알람';
  const make = (label: string, source: string): TimelineRow => ({ at, label, source });
  switch (e.event_type) {
    case 'TRIGGERED':
      return make(`${name} 울림`, '자동');
    case 'DISMISSED':
      return make(`${name} 해제`, '자동');
    case 'SNOOZED':
      return make(e.snooze_minutes ? `${name} ${e.snooze_minutes}분 미루기` : `${name} 미루기`, '자동');
    case 'MISSED':
      return make(`${name} 놓침`, '자동');
    case 'WAKE_CONFIRMED':
      return make('기상 확인', inputSourceText(e.input_source));
    case 'ACKNOWLEDGED':
      return make(type === 'DEPARTURE' ? '집 출발' : type === 'PREPARE' ? '준비 시작' : type === 'ROUTINE' ? '루틴 단계 완료' : '확인 알림 응답', inputSourceText(e.input_source));
    case 'ARRIVAL_CONFIRMED': {
      const p = e.alarms?.appointment_participants;
      const late = p?.is_late === true ? (p.late_minutes ? ` · ${p.late_minutes}분 지각` : ' · 지각') : p?.is_late === false ? ' · 지각 아님' : '';
      return make(`도착${late}`, inputSourceText(e.input_source));
    }
    default:
      return null;
  }
}

const RECORD_SOURCE_TEXT: Record<Enums<'record_source'>, string> = { MANUAL: '직접 입력', ALARM: '자동', AI: 'AI 대화' };

// 그날 생활 기록(daily_records)에만 있고 울림 기록(alarm_events)에는 없는 일 — 달력 점은 생활 기록으로 찍으니, 점이 있는 날 일간에도 그 기록이 보이게
//   기상 확인 · 알람 해제 시각 두 가지. 울림 기록에 같은 일이 있으면 그쪽을 씀 (두 줄로 겹치지 않게)
export function recordRows(record: RecordRow | undefined | null, events: readonly EventRow[]): TimelineRow[] {
  if (!record) return [];
  const source = RECORD_SOURCE_TEXT[record.data_source];
  const rows: TimelineRow[] = [];
  if (record.wake_reported_at && !events.some((e) => e.event_type === 'DISMISSED' && e.alarms?.alarm_type === 'WAKE')) {
    rows.push({ at: parseDbTime(record.wake_reported_at), label: '기상 알람 해제', source });
  }
  if (record.wake_confirmed_at && !events.some((e) => e.event_type === 'WAKE_CONFIRMED')) {
    rows.push({ at: parseDbTime(record.wake_confirmed_at), label: '기상 확인', source });
  }
  return rows;
}

// 시각순 (같은 시각이면 기록 번호순, 생활 기록에서 온 줄은 같은 시각의 울림 기록 뒤) — 마지막 줄(지금 강조)이 가장 늦은 일이 되게
export function actualRows(events: readonly EventRow[], record?: RecordRow | null): TimelineRow[] {
  const fromEvents = [...events]
    .sort((x, y) => dbTimeMs(x.event_at) - dbTimeMs(y.event_at) || x.event_id - y.event_id)
    .flatMap((e) => {
      const row = actualRow(e);
      return row ? [row] : [];
    });
  return [...fromEvents, ...recordRows(record, events)].sort((x, y) => x.at.getTime() - y.at.getTime()); // 정렬은 안정적이라 같은 시각이면 울림 기록이 앞
}

// ---------------------------------------------------------------------------
// 알람 조정 제안 (alarm_suggestions) — DB 종류는 말소리 · 배경음 · 진동뿐 (D6 열림)
// ---------------------------------------------------------------------------

export type SuggestionType = Enums<'alarm_suggestion_type'>;

// 제안 종류 → 화면 이름 · 바뀌는 alarms 칸 · 값 읽기. 진동 = alarms.intensity, 말소리 = voice_tone, 배경음 = sound_key (features/alarm 고친 값 기록과 같은 이름)
export const SUGGESTION_KIND: Record<
  SuggestionType,
  { axis: string; column: 'voice_tone' | 'sound_key' | 'intensity'; levelOf: (v: string | null | undefined) => Level | null; text: (level: Level) => string }
> = {
  VOICE_TONE: { axis: '말소리', column: 'voice_tone', levelOf: levelOfVoiceTone, text: (l) => LEVELS[l].voice },
  SOUND: { axis: '배경음', column: 'sound_key', levelOf: levelOfSoundKey, text: (l) => LEVELS[l].sound },
  INTENSITY: { axis: '진동', column: 'intensity', levelOf: levelOfIntensity, text: (l) => LEVELS[l].vibration },
};

// DB 값 → 화면 글자 (모르는 값이면 값 그대로)
export function valueText(type: SuggestionType, value: string | null): string {
  if (value == null) return '정해지지 않음';
  const kind = SUGGESTION_KIND[type];
  const level = kind.levelOf(value);
  return level == null ? value : kind.text(level);
}

// 제안한 값을 알람에 쓸 수 있는지 — 말소리 · 진동은 DB 선택지(enum) 안의 값이어야 하고, 배경음은 이름 아무거나 (알람 코어가 모르면 기본음)
export function isApplicableValue(type: SuggestionType, value: string): boolean {
  if (!value) return false;
  return type === 'SOUND' || SUGGESTION_KIND[type].levelOf(value) != null;
}

// 제안한 값을 알람에 쓰는 갱신 내용. 적용할 때는 직접 고른 값으로 표시해 서버가 다시 계산해도 덮지 않게 함 (alarms.intensity_source MANUAL — 서버는 저장된 값을 직접 고른 값으로 읽음),
// 되돌릴 때는 값만 되돌림 (표시는 그대로 — 되돌린 값이 자동 값과 같으면 서버가 직접 고른 값으로 안 봄). isApplicableValue를 통과한 값만 넘길 것
export function alarmPatch(type: SuggestionType, value: string, markManual: boolean): TablesUpdate<'alarms'> {
  const source = markManual ? ({ intensity_source: 'MANUAL' } as const) : {};
  if (type === 'SOUND') return { sound_key: value, ...source };
  if (type === 'VOICE_TONE') return { voice_tone: value as Enums<'voice_tone'>, ...source };
  return { intensity: value as Enums<'alarm_intensity'>, ...source };
}

export type SuggestionRow = Pick<Tables<'alarm_suggestions'>, 'suggestion_id' | 'suggestion_type' | 'current_value' | 'suggested_value' | 'result_value' | 'status' | 'target_alarm_id'>;
export type SuggestionTarget = Pick<Tables<'alarms'>, 'alarm_id' | 'alarm_type' | 'scheduled_at'> & {
  appointment_participants: { appointments: { appointment_id: string; title: string; appointment_at: string } | null } | null;
  routines: { title: string } | null;
};

export const SUGGESTION_REASON = '최근 알람 반응을 바탕으로\n더 잘 맞는 설정을 찾았어요.';

// 제안 한 줄 → 화면 타입. 대상 알람이 없어졌으면(알람을 지움) null
//   시각 칸은 대상 알람 시각으로 채우고 화면은 change를 봄 (types.ts Suggestion.change)
export function toSuggestion(row: SuggestionRow, target: SuggestionTarget | null): Suggestion | null {
  if (!target) return null;
  const kind = SUGGESTION_KIND[row.suggestion_type];
  const at = parseDbTime(target.scheduled_at);
  const appointment = target.appointment_participants?.appointments ?? null;
  const name = alarmName(target.alarm_type);
  const owner = appointment?.title ?? target.routines?.title ?? null;
  const applied = row.status === 'APPLIED' || row.status === 'EDITED';
  const change: SuggestionChange = {
    kind: row.suggestion_type,
    axis: kind.axis,
    target: `${formatDateShort(at)} ${owner ? `${owner} · ` : ''}${name}`,
    current: valueText(row.suggestion_type, row.current_value),
    suggested: valueText(row.suggestion_type, row.suggested_value),
    result: applied ? valueText(row.suggestion_type, row.result_value) : null,
  };
  return {
    id: row.suggestion_id,
    title: `${name}의 ${josa(kind.axis, '을', '를')} 바꿔 볼까요?`,
    summary: `${change.current} → ${change.suggested}`,
    reason: SUGGESTION_REASON,
    deltas: [],
    appointment: { id: appointment?.appointment_id ?? '', title: owner ?? name, at: appointment ? parseDbTime(appointment.appointment_at) : at },
    minutes: 0,
    currentWake: at,
    currentPrepare: null,
    depart: at,
    bounds: { earlier: 0, later: 0 },
    proposedWake: at,
    status: row.status,
    applied: applied ? { wake: at, prepare: null, minutes: 0 } : null,
    change,
  };
}

export const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
