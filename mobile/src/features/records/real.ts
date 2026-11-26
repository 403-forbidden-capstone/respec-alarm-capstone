// ④ 캘린더 · 하루 기록 · 알람 조정 제안 — 실데이터(Supabase) 구현. api.ts의 함수가 `if (!isMock()) return real.<함수>(...)`로 넘겨 줌 (P6)
//   · 쿼리는 이 파일에서 얇게, 행 → 화면 타입 변환은 map.ts, 점수 · 달력 점 · 주간 요약 계산은 summary.ts (가짜와 같은 함수)
//   · 읽기 실패는 DB 원문 그대로 던지고(화면이 LoadError로 기본 문구), 이유를 보여 줄 때만 UserError
//   · 날짜는 lib/format의 한국 시간 하루(0시~24시), 오늘은 lib/clock now()
//   · 읽고 쓰는 곳은 docs/screen-data-map.md R02 · S01. 쓰기는 DB 직접 → 그 알람만 reconcile (실데이터 연결 규칙)
import { applyCommit, reconcile } from '@/lib/alarmSync';
import { now } from '@/lib/clock';
import { UserError } from '@/lib/errors';
import { addDays, dateParts, dayKey, isSameDay, startOfDay } from '@/lib/format';
import { callEdge } from '@/lib/edge';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';
import type { Json, Tables, TablesInsert, TablesUpdate } from '@/types/database';

import { leadingBlanks, monthDays, monthTitle, weekDays, weekRelative, weekStart, weekTitle } from './calendar';
import {
  actualRows,
  alarmPatch,
  factsOf,
  hasJournalText,
  isAlarmValueSuggestion,
  isApplicableValue,
  isPlanned,
  isUuid,
  plannedRow,
  SUGGESTION_KIND,
  toPrepareSuggestion,
  toSuggestion,
  wakeRowsOf,
  type AlarmValueSuggestionType,
  type JournalDayRow,
  type PlannedAlarmRow,
  type RecordRow,
  type SuggestionRow,
  type SuggestionTarget,
} from './map';
import { buildWeekSummary, dayMark } from './summary';
import type { DayRecord, MonthRecord, Suggestion, SuggestionStatus, TimelineRow, WeekAiSummary, WeekRecord } from './types';

// 기록 화면의 오늘 (한국 시간 0시)
export const recordToday = () => startOfDay(now());

// ---------------------------------------------------------------------------
// 읽기 도우미
// ---------------------------------------------------------------------------

const RECORD_COLUMNS =
  'record_date, sleep_at, wake_reported_at, wake_confirmed_at, actual_prepare_minutes, routine_done_rate, sleep_satisfaction, condition_note, data_source';

// 날짜(YYYY-MM-DD) 범위의 생활 기록 — 양 끝 포함
async function loadRecords(userId: string, fromKey: string, toKey: string): Promise<RecordRow[]> {
  const { data, error } = await supabase.from('daily_records').select(RECORD_COLUMNS).eq('user_id', userId).gte('record_date', fromKey).lte('record_date', toKey);
  if (error) throw error;
  return data ?? [];
}

// 날짜 범위의 일기 (있는 날 표시 · 주간 AI 요약을 읽을지)
async function loadJournalDays(userId: string, fromKey: string, toKey: string): Promise<JournalDayRow[]> {
  const { data, error } = await supabase.from('daily_journals').select('record_date, ai_summary, edited_summary, is_edited').eq('user_id', userId).gte('record_date', fromKey).lte('record_date', toKey);
  if (error) throw error;
  return data ?? [];
}

// 구간 안 켜진 기상 알람 시각 (목표 시각 — 하루의 첫 기상 알람)
async function loadWakeAlarmAts(userId: string, from: Date, to: Date): Promise<string[]> {
  const { data, error } = await supabase
    .from('alarms')
    .select('scheduled_at')
    .eq('user_id', userId)
    .eq('alarm_type', 'WAKE')
    .eq('is_enabled', true)
    .gte('scheduled_at', from.toISOString())
    .lt('scheduled_at', to.toISOString());
  if (error) throw error;
  return (data ?? []).map((a) => a.scheduled_at);
}

async function hasJournal(userId: string, key: string): Promise<boolean> {
  const { data, error } = await supabase.from('daily_journals').select('journal_id').eq('user_id', userId).eq('record_date', key).maybeSingle();
  if (error) throw error;
  return data != null;
}

// 그날 실제로 일어난 일 — 울림 기록(alarm_events) + 생활 기록(daily_records)에만 있는 기상 시각, 시각순. 일기 사실(routine/real.ts)도 같은 줄을 씀
export async function loadActualRows(userId: string, day: Date): Promise<TimelineRow[]> {
  const from = startOfDay(day);
  const [events, record] = await Promise.all([
    supabase
      .from('alarm_events')
      .select('event_id, event_type, event_at, snooze_minutes, input_source, alarms(alarm_type, appointment_participants(is_late, late_minutes))')
      .eq('user_id', userId)
      .gte('event_at', from.toISOString())
      .lt('event_at', addDays(from, 1).toISOString()),
    supabase.from('daily_records').select(RECORD_COLUMNS).eq('user_id', userId).eq('record_date', dayKey(from)).maybeSingle(),
  ]);
  if (events.error) throw events.error;
  if (record.error) throw record.error;
  return actualRows(events.data ?? [], record.data);
}

async function loadPlannedRows(userId: string, day: Date, nowMs: number | null): Promise<TimelineRow[]> {
  const from = startOfDay(day);
  const { data, error } = await supabase
    .from('alarms')
    .select('alarm_id, alarm_type, scheduled_at, is_enabled, appointment_participants(appointments(title)), routines(title)')
    .eq('user_id', userId)
    .gte('scheduled_at', from.toISOString())
    .lt('scheduled_at', addDays(from, 1).toISOString())
    .order('scheduled_at');
  if (error) throw error;
  const rows: PlannedAlarmRow[] = data ?? [];
  return rows.filter(isPlanned).map((row) => plannedRow(row, nowMs));
}

// ---------------------------------------------------------------------------
// R02 월간 · 주간 · 일간
// ---------------------------------------------------------------------------

// 월간 — daily_records(그 달) + 일기 있는 날로 달력 점. 오늘 카드의 기록 수는 오늘 alarm_events
export async function getMonth(year: number, month: number): Promise<MonthRecord> {
  const userId = await requireUserId();
  const t = recordToday();
  const days = monthDays(year, month);
  const [records, journals, todayRows, todayJournal] = await Promise.all([
    loadRecords(userId, dayKey(days[0]), dayKey(days[days.length - 1])),
    loadJournalDays(userId, dayKey(days[0]), dayKey(days[days.length - 1])),
    loadActualRows(userId, t),
    hasJournal(userId, dayKey(t)),
  ]);
  return {
    title: monthTitle(year, month),
    leadingBlanks: leadingBlanks(year, month),
    days: days.map((date) => {
      const key = dayKey(date);
      const isToday = isSameDay(date, t);
      return {
        date,
        day: dateParts(date).day,
        mark: dayMark(
          factsOf(
            records.find((r) => r.record_date === key),
            journals.some((j) => j.record_date === key),
          ),
          isToday,
        ),
        isToday,
        isFuture: date.getTime() > t.getTime(),
      };
    }),
    today: { date: t, eventCount: todayRows.length, journalWritten: todayJournal },
  };
}

// 주간 — 그 주와 앞 주의 기상 확인(daily_records) × 그날 첫 기상 알람으로 점수 · 평균 · 목표 기상률 (summary.ts)
export async function getWeek(anyDay: Date): Promise<WeekRecord> {
  const userId = await requireUserId();
  const t = recordToday();
  const days = weekDays(anyDay);
  const before = weekDays(addDays(days[0], -7));
  const relative = weekRelative(anyDay, t);
  const fromKey = dayKey(before[0]);
  const toKey = dayKey(days[6]);
  const [records, journals, wakeAlarmAts] = await Promise.all([
    loadRecords(userId, fromKey, toKey),
    loadJournalDays(userId, fromKey, toKey),
    loadWakeAlarmAts(userId, before[0], addDays(days[6], 1)),
  ]);
  const todayKey = dayKey(t);
  return {
    title: weekTitle(anyDay),
    relative,
    strip: days.map((date) => {
      const key = dayKey(date);
      const facts = factsOf(
        records.find((r) => r.record_date === key),
        journals.some((j) => j.record_date === key),
      );
      return {
        date,
        weekday: dateParts(date).weekday,
        day: dateParts(date).day,
        isToday: isSameDay(date, t),
        isFuture: date.getTime() > t.getTime(),
        recorded: dayMark(facts, key === todayKey) !== 'none',
      };
    }),
    summary: buildWeekSummary({
      days,
      rows: wakeRowsOf(days, records, wakeAlarmAts),
      beforeRows: wakeRowsOf(before, records, wakeAlarmAts),
      relative,
      today: t,
      todayWoke: records.some((r) => r.record_date === todayKey && r.wake_confirmed_at != null),
    }),
    journalDays: journals.filter((j) => j.record_date >= dayKey(days[0]) && hasJournalText(j)).length,
  };
}

// weekly-summary 응답 (supabase/functions/_shared/weekly-summary.ts WeeklySummaryOut)
type WeeklySummaryOut = { week_start: string; week_end: string; dates: string[]; summary: string | null; generated_at: string | null; stale: boolean };

// 주간 AI 요약 — 그 주 일기로 서버가 만든 글. 같은 기록이면 서버가 저장된 글을 줘서 모델을 다시 안 부름. 그 주 일기가 없으면 null
//   기록 일수 · 기간은 서버가 센 값 (stale이면 그 글을 만들 때의 일수)
export async function getWeekAiSummary(anyDay: Date): Promise<WeekAiSummary | null> {
  const r = await callEdge<WeeklySummaryOut>('weekly-summary', { week_start: dayKey(weekStart(anyDay)) });
  return r.summary ? { text: r.summary, dayCount: r.dates.length, period: weekTitle(anyDay), stale: r.stale } : null;
}

// 일간 — 설정한 값(그날 alarms) + 실제로 일어난 일(alarm_events). 아직 오지 않은 날은 빈 기록 (가짜와 같음)
export async function getDay(date: Date): Promise<DayRecord> {
  const userId = await requireUserId();
  const day = startOfDay(date);
  const t = recordToday();
  const isToday = isSameDay(day, t);
  const isFuture = day.getTime() > t.getTime();
  if (isFuture) return { date: day, isToday, isFuture, journalWritten: false, planned: [], actual: [] };
  const [planned, actual, journalWritten] = await Promise.all([
    loadPlannedRows(userId, day, isToday ? now().getTime() : null),
    loadActualRows(userId, day),
    hasJournal(userId, dayKey(day)),
  ]);
  return { date: day, isToday, isFuture, journalWritten, planned, actual };
}

// ---------------------------------------------------------------------------
// S01 알람 조정 제안 — 알람 값 제안(말소리 · 배경음 · 진동)과 준비 알람 당김(PREPARE_ADVANCE, 안건 D111)
//   알람 값: 그 알람의 값을 DB에 바로 쓰고 → 제안 기록 → 그 알람만 폰에 맞춤 → 고친 값 기록. 되돌림 상태는 D23 A — PENDING으로 돌림(가짜와 같음)
//   준비 알람 당김: 서버 suggestion-apply가 이번 회차와 이후 회차의 당김 분 · 알람을 바꾸고 → 돌려준 꾸러미로 폰 예약을 맞춤
// ---------------------------------------------------------------------------

type AlarmValues = Pick<Tables<'alarms'>, 'intensity' | 'voice_tone' | 'sound_key'>;
type SuggestionWithAlarm = SuggestionRow & { alarms: (SuggestionTarget & AlarmValues) | null };

const SUGGESTION_SELECT =
  'suggestion_id, suggestion_type, current_value, suggested_value, result_value, status, target_alarm_id, evidence, alarms(alarm_id, participant_id, alarm_type, scheduled_at, intensity, voice_tone, sound_key, appointment_participants(appointments(appointment_id, title, appointment_at)), routines(title))';

async function loadSuggestion(userId: string, id: string): Promise<SuggestionWithAlarm | null> {
  if (!isUuid(id)) return null; // 가짜 데이터 주소(s1)가 남아 있어도 DB 오류 대신 "없음"
  const { data, error } = await supabase.from('alarm_suggestions').select(SUGGESTION_SELECT).eq('user_id', userId).eq('suggestion_id', id).maybeSingle();
  if (error) throw error;
  return data;
}

// 홈 카드에 띄울 제안 — 기다리는 것 중 가장 최근. 바꿀 알람이 없어진 제안은 적용할 수 없어 뺌. suppress_until은 제안을 만드는 배치만 봄
export async function getPendingSuggestion(): Promise<Suggestion | null> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from('alarm_suggestions')
    .select(SUGGESTION_SELECT)
    .eq('user_id', userId)
    .eq('status', 'PENDING')
    .not('target_alarm_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? toScreenSuggestion(userId, data) : null;
}

export async function getSuggestion(id: string): Promise<Suggestion | null> {
  const userId = await requireUserId();
  const found = await loadSuggestion(userId, id);
  return found ? toScreenSuggestion(userId, found) : null;
}

// 준비 알람 당김은 그 회차의 알람(기상 · 준비 · 출발)이 더 필요해서 한 번 더 읽음
async function toScreenSuggestion(userId: string, row: SuggestionWithAlarm): Promise<Suggestion | null> {
  if (row.suggestion_type !== 'PREPARE_ADVANCE') return toSuggestion(row, row.alarms);
  const target = row.alarms;
  const appointment = target?.appointment_participants?.appointments ?? null;
  if (!target?.participant_id || !appointment) return null;
  const { data, error } = await supabase.from('alarms').select('alarm_type, scheduled_at').eq('user_id', userId).eq('participant_id', target.participant_id);
  if (error) throw error;
  return toPrepareSuggestion(row, { alarms: data ?? [], appointment });
}

// 준비 알람 당김 — 서버 suggestion-apply (적용 · 고쳐 적용 · 무시 · 되돌리기) → 돌려준 꾸러미로 폰 예약을 맞춤
//   서버 저장이 끝났으니 폰 맞추기가 실패해도 화면에는 성공으로 — 앱이 앞에 올 때 다시 맞춤 (syncPhone과 같음)
type ApplyAction = 'APPLY' | 'EDIT' | 'IGNORE' | 'REVERT';
async function callApply(id: string, action: ApplyAction, minutes?: number) {
  const res = await callEdge<{ ring_packages?: Parameters<typeof applyCommit>[0]['ring_packages'] }>('suggestion-apply', {
    suggestion_id: id,
    action,
    ...(action === 'EDIT' ? { minutes } : {}),
  });
  if (!res.ring_packages?.length) return;
  try {
    await applyCommit({ ring_packages: res.ring_packages, canceled_alarm_ids: [] });
  } catch (e) {
    if (__DEV__) console.warn('[records] 폰 예약 맞추기 실패', e);
  }
}

// 적용 — 제안대로(minutes = 제안 분)면 APPLY, 다르면 EDIT. 이미 적용한 제안을 다시 고치면 되돌린 뒤 새 값으로 (D53)
async function applyPrepareAdvance(found: SuggestionWithAlarm, minutes: number) {
  if (!Number.isInteger(minutes) || minutes <= 0) throw new UserError('당길 시간을 골라 주세요');
  const suggested = Number(found.suggested_value) - Number(found.current_value ?? 0);
  if (found.status === 'APPLIED' || found.status === 'EDITED') await callApply(found.suggestion_id, 'REVERT');
  else if (found.status !== 'PENDING') throw new UserError('기다리는 제안만 적용할 수 있어요');
  await callApply(found.suggestion_id, minutes === suggested ? 'APPLY' : 'EDIT', minutes);
}

// 제안 기록 한 줄 갱신 — from 상태인 것만 (화면이 옛 상태로 누르면 거절)
async function updateSuggestion(userId: string, id: string, from: readonly SuggestionStatus[], patch: TablesUpdate<'alarm_suggestions'>) {
  const { data, error } = await supabase.from('alarm_suggestions').update(patch).eq('user_id', userId).eq('suggestion_id', id).in('status', [...from]).select('suggestion_id');
  if (error) throw error;
  if (!data?.length) throw new UserError('제안 상태가 바뀌었어요. 화면을 다시 열어 주세요');
}

async function updateAlarm(userId: string, alarmId: string, patch: TablesUpdate<'alarms'>) {
  const { data, error } = await supabase.from('alarms').update(patch).eq('user_id', userId).eq('alarm_id', alarmId).select('alarm_id');
  if (error) throw error;
  if (!data?.length) throw new UserError('바꿀 알람을 찾을 수 없어요');
}

// 저장은 끝났으니 폰 맞추기가 실패해도 화면에는 성공으로 — 폰 예약이 그대로라 알람은 울리고, 앱이 앞에 올 때 다시 맞춤
async function syncPhone(alarmId: string) {
  try {
    await reconcile({ alarmIds: [alarmId] });
  } catch (e) {
    if (__DEV__) console.warn('[records] 폰 예약 맞추기 실패', e);
  }
}

const valueOf = (alarm: AlarmValues, column: 'voice_tone' | 'sound_key' | 'intensity') => alarm[column];

// 고친 값 기록에 남기는 값 — 약 · 중 · 강 = 0 · 1 · 2 (features/alarm/types.ts UserEditLog 규칙), 모르는 값이면 값 그대로
const loggedValue = (type: AlarmValueSuggestionType, value: string | null): Json => {
  const level = value == null ? null : SUGGESTION_KIND[type].levelOf(value);
  return level ?? value;
};

// 적용 — 제안한 값을 대상 알람에 씀. minutes(시각 조정)는 DB 종류에 시각이 없어 안 씀
export async function applySuggestion(id: string, minutes: number) {
  const userId = await requireUserId();
  const found = await loadSuggestion(userId, id);
  if (!found) throw new UserError('제안을 찾을 수 없어요');
  if (found.suggestion_type === 'PREPARE_ADVANCE') return applyPrepareAdvance(found, minutes);
  if (found.status !== 'PENDING') throw new UserError('기다리는 제안만 적용할 수 있어요');
  const alarm = found.alarms;
  if (!alarm) throw new UserError('바꿀 알람이 없어졌어요');
  const type = found.suggestion_type;
  if (!isAlarmValueSuggestion(type) || !isApplicableValue(type, found.suggested_value)) throw new UserError('이 제안은 적용할 수 없어요');

  // 알람 값을 먼저 — 제안 기록이 실패해도 다시 눌러 같은 값을 쓰면 되도록
  await updateAlarm(userId, alarm.alarm_id, alarmPatch(type, found.suggested_value, true));
  await updateSuggestion(userId, id, ['PENDING'], { status: 'APPLIED', result_value: found.suggested_value, responded_at: now().toISOString() });
  await syncPhone(alarm.alarm_id);

  // 고친 값 기록 (F5 · F9) — 적용이 끝난 뒤. 실패해도 적용은 그대로 두고 개발 중에만 알림
  const log: TablesInsert<'user_edit_logs'> = {
    user_id: userId,
    screen: 'S01',
    field: SUGGESTION_KIND[type].column,
    alarm_id: alarm.alarm_id,
    alarm_type: alarm.alarm_type,
    appointment_id: alarm.appointment_participants?.appointments?.appointment_id ?? null,
    auto_value: loggedValue(type, valueOf(alarm, SUGGESTION_KIND[type].column)),
    edited_value: loggedValue(type, found.suggested_value),
  };
  const { error } = await supabase.from('user_edit_logs').insert(log);
  if (error && __DEV__) console.warn('[records] 고친 값 기록 실패', error);
}

// 이전 값으로 되돌리기 — 알람 값을 제안 전 값으로 되돌리고 제안은 다시 기다림으로 (D23 열림: 적용 이력은 남지 않음)
export async function undoSuggestion(id: string) {
  const userId = await requireUserId();
  const found = await loadSuggestion(userId, id);
  if (!found) throw new UserError('제안을 찾을 수 없어요');
  if (found.status !== 'APPLIED' && found.status !== 'EDITED') throw new UserError('적용한 제안만 되돌릴 수 있어요');
  if (found.suggestion_type === 'PREPARE_ADVANCE') return callApply(id, 'REVERT');
  const alarm = found.alarms;
  if (!alarm) throw new UserError('바꿀 알람이 없어졌어요');
  const type = found.suggestion_type;
  if (!isAlarmValueSuggestion(type)) throw new UserError('이 제안은 되돌릴 수 없어요');
  const previous = found.current_value;
  // 이전 값이 비어 있어도(null) 배경음은 "기본음이었다"는 뜻이라 되돌릴 수 있음 (alarms.sound_key는 null 허용). 말소리 · 진동은 DB가 늘 값을 가져서 비면 알 수 없음
  if (previous == null && type !== 'SOUND') throw new UserError('이전 값을 알 수 없어 되돌릴 수 없어요');

  // 그 사이 알람 값을 직접 다시 고쳤다면 그 값을 지킴 (적용한 값 그대로일 때만 되돌림)
  if (valueOf(alarm, SUGGESTION_KIND[type].column) === found.result_value) {
    if (previous == null) await updateAlarm(userId, alarm.alarm_id, { sound_key: null });
    else if (isApplicableValue(type, previous)) await updateAlarm(userId, alarm.alarm_id, alarmPatch(type, previous, false));
  }
  await updateSuggestion(userId, id, ['APPLIED', 'EDITED'], { status: 'PENDING', result_value: null });
  await syncPhone(alarm.alarm_id);
}

// 이번 제안 무시 — 얼마나 안 보여 줄지(suppress_until)는 D24가 열려 있어 채우지 않음
export async function ignoreSuggestion(id: string) {
  const userId = await requireUserId();
  const found = await loadSuggestion(userId, id);
  if (!found) throw new UserError('제안을 찾을 수 없어요');
  if (found.status !== 'PENDING') throw new UserError('기다리는 제안만 무시할 수 있어요');
  if (found.suggestion_type === 'PREPARE_ADVANCE') return callApply(id, 'IGNORE');
  await updateSuggestion(userId, id, ['PENDING'], { status: 'IGNORED', responded_at: now().toISOString() });
}

// 무시한 제안 다시 보기 — 안 보여 주는 기한을 비우고 기다림으로 (responded_at은 남김, D24 참고)
export async function reopenSuggestion(id: string) {
  const userId = await requireUserId();
  const found = await loadSuggestion(userId, id);
  if (!found) throw new UserError('제안을 찾을 수 없어요');
  if (found.status !== 'IGNORED') throw new UserError('무시한 제안만 다시 볼 수 있어요');
  await updateSuggestion(userId, id, ['IGNORED'], { status: 'PENDING', suppress_until: null });
}
