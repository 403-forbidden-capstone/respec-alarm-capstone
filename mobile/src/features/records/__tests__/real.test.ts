import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { UserError } from '@/lib/errors';
import { dayKey, formatTime } from '@/lib/format';

import { calls, filterOf, onCall, resetFake, type FakeCall, type FakeReply } from '../testing/fakeSupabase';
import { applySuggestion, getDay, getMonth, getPendingSuggestion, getSuggestion, getWeek, ignoreSuggestion, recordToday, reopenSuggestion, undoSuggestion } from '../real';

// real.ts가 어느 테이블을 어떤 조건으로 읽고 어떤 순서로 쓰는지 — 가짜 클라이언트로 확인 (칸 이름은 tsc, 행 → 화면 변환은 map.test.ts)
jest.mock('@/lib/supabase', () => ({ supabase: jest.requireActual<typeof import('../testing/fakeSupabase')>('../testing/fakeSupabase').fakeClient }));
jest.mock('@/lib/user', () => ({ requireUserId: async () => 'user-1' }));
// 한국 시간 2026-10-19(월) 오전 9:30
let mockNow = new Date('2026-10-19T00:30:00Z');
jest.mock('@/lib/clock', () => ({ now: () => mockNow }));
const mockReconcile = jest.fn<(options: { alarmIds?: string[] }) => Promise<unknown>>();
jest.mock('@/lib/alarmSync', () => ({ reconcile: (options: { alarmIds?: string[] }) => mockReconcile(options) }));

const SUGGESTION_ID = '2b9f6a4e-5c0e-4d3b-9a77-0a1b2c3d4e5f';
const reply = (handler: (call: FakeCall) => FakeReply | undefined) => onCall(handler);
const onlyCalls = (table: string, op?: FakeCall['op']) => calls.filter((c) => c.table === table && (!op || c.op === op));

beforeEach(() => {
  resetFake();
  mockNow = new Date('2026-10-19T00:30:00Z');
  mockReconcile.mockReset();
  mockReconcile.mockResolvedValue({});
});

const record = (date: string, patch: Record<string, unknown> = {}) => ({
  record_date: date,
  sleep_at: null,
  wake_reported_at: null,
  wake_confirmed_at: null,
  actual_prepare_minutes: null,
  routine_done_rate: null,
  sleep_satisfaction: null,
  condition_note: null,
  ...patch,
});

describe('recordToday', () => {
  it('실데이터는 지금 시각의 한국 시간 0시', () => {
    expect(recordToday().toISOString()).toBe('2026-10-18T15:00:00.000Z');
  });
});

describe('R02 월간', () => {
  it('daily_records(그 달) + 일기로 달력 점, 오늘 카드는 오늘 기록 수 · 일기 여부', async () => {
    reply((c) => {
      if (c.table === 'daily_records') {
        return {
          data: [
            record('2026-10-12', { wake_confirmed_at: '2026-10-11T22:30:00Z', actual_prepare_minutes: 40 }), // 완료
            record('2026-10-17', { wake_confirmed_at: '2026-10-17T00:30:00Z' }), // 일부
            record('2026-10-19', { wake_confirmed_at: '2026-10-18T22:30:00Z' }), // 오늘 — 기상 확인만 있어도 완료
          ],
        };
      }
      if (c.table === 'daily_journals') return c.columns === 'journal_id' ? { data: { journal_id: 'j1' } } : { data: [{ record_date: '2026-10-14', coaching_insight: null }] };
      if (c.table === 'alarm_events') {
        return {
          data: [
            { event_id: 1, event_type: 'TRIGGERED', event_at: '2026-10-18T22:20:00Z', snooze_minutes: null, input_source: null, alarms: { alarm_type: 'WAKE', appointment_participants: null } },
            { event_id: 2, event_type: 'DISMISSED', event_at: '2026-10-18T22:22:00Z', snooze_minutes: null, input_source: 'BUTTON', alarms: { alarm_type: 'WAKE', appointment_participants: null } },
          ],
        };
      }
      return undefined;
    });
    const m = await getMonth(2026, 10);
    const mark = (d: number) => m.days[d - 1].mark;
    expect([m.title, m.leadingBlanks, m.days.length]).toEqual(['2026년 10월', 3, 31]); // 10/1은 목요일
    expect([mark(12), mark(17), mark(14), mark(19), mark(20)]).toEqual(['done', 'partial', 'partial', 'done', 'none']);
    expect([m.days[18].isToday, m.days[19].isFuture, m.days[17].isFuture]).toEqual([true, true, false]);
    expect([dayKey(m.today.date), m.today.eventCount, m.today.journalWritten]).toEqual(['2026-10-19', 2, true]);

    const records = onlyCalls('daily_records')[0];
    expect([filterOf(records, 'eq', 'user_id')?.[1], filterOf(records, 'gte', 'record_date')?.[1], filterOf(records, 'lte', 'record_date')?.[1]]).toEqual(['user-1', '2026-10-01', '2026-10-31']);
    const events = onlyCalls('alarm_events')[0];
    expect([filterOf(events, 'gte', 'event_at')?.[1], filterOf(events, 'lt', 'event_at')?.[1]]).toEqual(['2026-10-18T15:00:00.000Z', '2026-10-19T15:00:00.000Z']);
  });

  it('기록이 없는 달은 달력만', async () => {
    reply((c) => (c.table === 'daily_journals' && c.columns === 'journal_id' ? { data: null } : { data: [] }));
    const m = await getMonth(2026, 9);
    expect(m.days.every((d) => d.mark === 'none' && !d.isFuture && !d.isToday)).toBe(true);
    expect([m.today.eventCount, m.today.journalWritten]).toEqual([0, false]);
  });

  it('읽기 실패는 그대로 던짐 (화면이 LoadError)', async () => {
    reply((c) => (c.table === 'daily_records' ? { error: { message: 'boom' } } : { data: [] }));
    await expect(getMonth(2026, 10)).rejects.toMatchObject({ message: 'boom' });
  });
});

describe('R02 주간', () => {
  // 이번 주 10/19(월) 기상 확인 7:29(알람 7:20 → 9분 안), 지난주 10/12(월) 7:41(알람 7:20 → 21분)
  const rows = () =>
    reply((c) => {
      if (c.table === 'daily_records') {
        return {
          data: [record('2026-10-19', { wake_confirmed_at: '2026-10-18T22:29:00Z' }), record('2026-10-12', { wake_confirmed_at: '2026-10-11T22:41:00Z' })],
        };
      }
      if (c.table === 'alarms') return { data: [{ scheduled_at: '2026-10-18T22:20:00Z' }, { scheduled_at: '2026-10-11T22:20:00Z' }] };
      if (c.table === 'daily_journals') return { data: [{ record_date: '2026-10-20', coaching_insight: '이번 주 코칭' }] };
      return undefined;
    });

  it('이번 주 요약: 평균 기상 · 앞 주와 견줌 · 목표 기상률 · 막대 · 코칭', async () => {
    rows();
    const w = await getWeek(new Date('2026-10-21T03:00:00Z'));
    expect([w.title, w.relative]).toEqual(['10월 19일 — 25일', '이번 주']);
    expect(w.strip.map((d) => `${d.weekday}${d.day}${d.recorded ? '•' : ''}`)).toEqual(['월19•', '화20•', '수21', '목22', '금23', '토24', '일25']); // 화 20은 일기만 있는 날
    const s = w.summary!;
    expect(formatTime(s.averageWake)).toBe('오전 7:29');
    expect(s.averageText).toBe('지난주보다 12분 빨라요'); // 지난주 7:41 = 461분, 이번 주 449분
    expect([s.goalRate, s.goalText]).toEqual([100, '이번 주 1/1일']);
    expect(s.bars.map((b) => `${b.label}:${b.score}`)).toEqual(['월 19:88']);
    expect([s.todayPending, s.coaching]).toEqual([false, '이번 주 코칭']);

    // 앞 주부터 이번 주까지 한 번에 읽음
    const records = onlyCalls('daily_records')[0];
    expect([filterOf(records, 'gte', 'record_date')?.[1], filterOf(records, 'lte', 'record_date')?.[1]]).toEqual(['2026-10-12', '2026-10-25']);
    const alarms = onlyCalls('alarms')[0];
    expect([filterOf(alarms, 'eq', 'alarm_type')?.[1], filterOf(alarms, 'eq', 'is_enabled')?.[1], filterOf(alarms, 'eq', 'user_id')?.[1]]).toEqual(['WAKE', true, 'user-1']);
  });

  it('오늘 기상 확인 전이면 기록 대기, 앞 주 기록이 없으면 견주지 않음, 코칭 일기가 없으면 빈 글자', async () => {
    reply((c) => {
      if (c.table === 'daily_records') return { data: [record('2026-10-14', { wake_confirmed_at: '2026-10-13T22:25:00Z' })] };
      if (c.table === 'alarms') return { data: [{ scheduled_at: '2026-10-13T22:20:00Z' }] };
      return { data: [] };
    });
    const w = await getWeek(new Date('2026-10-14T03:00:00Z'));
    expect(w.relative).toBe('지난주');
    expect(w.summary).toMatchObject({ averageText: '그 전 주 기록이 없어 견줄 수 없어요', todayPending: false, coaching: '' });
    const thisWeek = await getWeek(new Date('2026-10-19T03:00:00Z'));
    expect(thisWeek.summary).toBeNull(); // 이번 주에는 기록이 없음
  });

  it('기상 확인은 있지만 그날 기상 알람이 없으면 막대에 안 넣음 (점수를 못 냄)', async () => {
    reply((c) => (c.table === 'daily_records' ? { data: [record('2026-10-19', { wake_confirmed_at: '2026-10-18T22:29:00Z' })] } : { data: [] }));
    const w = await getWeek(new Date('2026-10-19T03:00:00Z'));
    expect(w.summary).toBeNull();
    expect(w.strip[0].recorded).toBe(true); // 점은 기상 확인이 있으니 찍힘
  });
});

describe('R02 일간', () => {
  const alarm = (type: string, at: string, patch: Record<string, unknown> = {}) => ({
    alarm_id: `alarm-${type}`,
    alarm_type: type,
    scheduled_at: at,
    is_enabled: true,
    appointment_participants: { appointments: { title: '수업' } },
    routines: null,
    ...patch,
  });
  const day = () =>
    reply((c) => {
      if (c.table === 'alarms') {
        return {
          data: [
            alarm('WAKE', '2026-10-18T22:20:00Z'), // 7:20 — 지난 알람
            alarm('PREPARE', '2026-10-18T22:30:00Z', { is_enabled: false }), // 꺼 둠 — 뺌
            alarm('DEPARTURE', '2026-10-19T02:00:00Z'), // 11:00 — 아직 안 지남
            alarm('ARRIVE', '2026-10-19T02:50:00Z', { is_enabled: false }), // 도착 목표는 늘 넣음
          ],
        };
      }
      if (c.table === 'alarm_events') {
        return {
          data: [
            { event_id: 2, event_type: 'DISMISSED', event_at: '2026-10-18T22:23:00Z', snooze_minutes: null, input_source: 'BUTTON', alarms: { alarm_type: 'WAKE', appointment_participants: null } },
            { event_id: 1, event_type: 'TRIGGERED', event_at: '2026-10-18T22:20:00Z', snooze_minutes: null, input_source: 'BUTTON', alarms: { alarm_type: 'WAKE', appointment_participants: null } },
          ],
        };
      }
      if (c.table === 'daily_journals') return { data: null };
      return undefined;
    });

  it('오늘: 설정한 값(지난 알람은 past) + 실제로 일어난 일(시각순)', async () => {
    day();
    const d = await getDay(new Date('2026-10-19T05:00:00Z')); // 어느 시각을 받아도 그날 0시
    expect([dayKey(d.date), d.isToday, d.isFuture, d.journalWritten]).toEqual(['2026-10-19', true, false, false]);
    expect(d.planned.map((p) => `${formatTime(p.at)} ${p.label} · ${p.source}${p.past ? ' (지남)' : ''}`)).toEqual([
      '오전 7:20 기상 알람 · 수업 (지남)',
      '오전 11:00 출발 알람 · 수업',
      '오전 11:50 도착 목표 · 수업',
    ]);
    expect(d.actual.map((a) => `${formatTime(a.at)} ${a.label}`)).toEqual(['오전 7:20 기상 알람 울림', '오전 7:23 기상 알람 해제']);
    const planned = onlyCalls('alarms')[0];
    expect([filterOf(planned, 'gte', 'scheduled_at')?.[1], filterOf(planned, 'lt', 'scheduled_at')?.[1], filterOf(planned, 'eq', 'user_id')?.[1]]).toEqual([
      '2026-10-18T15:00:00.000Z',
      '2026-10-19T15:00:00.000Z',
      'user-1',
    ]);
  });

  it('지난 날은 past 표시 없이, 일기가 있으면 표시', async () => {
    reply((c) => (c.table === 'daily_journals' ? { data: { journal_id: 'j1' } } : { data: [] }));
    const d = await getDay(new Date('2026-10-16T03:00:00Z'));
    expect([dayKey(d.date), d.isToday, d.isFuture, d.journalWritten, d.planned, d.actual]).toEqual(['2026-10-16', false, false, true, [], []]);
    expect(filterOf(onlyCalls('daily_journals')[0], 'eq', 'record_date')?.[1]).toBe('2026-10-16');
  });

  it('앞날은 읽지 않고 빈 기록 (가짜와 같음)', async () => {
    const d = await getDay(new Date('2026-10-20T03:00:00Z'));
    expect([d.isFuture, d.planned, d.actual, d.journalWritten]).toEqual([true, [], [], false]);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// S01
// ---------------------------------------------------------------------------

type SuggestionRowFake = ReturnType<typeof suggestionRow>;
const suggestionRow = (patch: Record<string, unknown> = {}, alarmPatch: Record<string, unknown> | null = {}) => ({
  suggestion_id: SUGGESTION_ID,
  suggestion_type: 'VOICE_TONE',
  current_value: 'CALM',
  suggested_value: 'DIRECT',
  result_value: null,
  status: 'PENDING',
  target_alarm_id: 'alarm-1',
  alarms:
    alarmPatch === null
      ? null
      : {
          alarm_id: 'alarm-1',
          alarm_type: 'WAKE',
          scheduled_at: '2026-10-19T22:20:00Z',
          intensity: 'NORMAL',
          voice_tone: 'CALM',
          sound_key: 'theme_calm',
          appointment_participants: { appointments: { appointment_id: 'appt-1', title: '수업', appointment_at: '2026-10-20T00:00:00Z' } },
          routines: null,
          ...alarmPatch,
        },
  ...patch,
});

// 제안 읽기 + 쓰기 모두 성공하는 기본 응답
function suggestionDb(row: SuggestionRowFake | null, extra?: (c: FakeCall) => FakeReply | undefined) {
  reply((c) => {
    const custom = extra?.(c);
    if (custom) return custom;
    if (c.table === 'alarm_suggestions' && c.op === 'select') return { data: row };
    if (c.op === 'update') return { data: [{ ok: true }] };
    return undefined;
  });
}

describe('S01 읽기', () => {
  it('홈 카드: 기다리는 제안 중 가장 최근 것, 바꿀 알람이 있는 것만', async () => {
    suggestionDb(suggestionRow());
    const s = await getPendingSuggestion();
    expect(s).toMatchObject({ id: SUGGESTION_ID, title: '기상 알람의 말소리를 바꿔 볼까요?', summary: '차분 · 다정 → 직설형', status: 'PENDING' });
    const q = calls[0];
    expect([q.table, filterOf(q, 'eq', 'user_id')?.[1], filterOf(q, 'eq', 'status')?.[1], filterOf(q, 'not', 'target_alarm_id')?.slice(1), filterOf(q, 'order', 'created_at')?.[1], filterOf(q, 'limit', '')]).toEqual([
      'alarm_suggestions',
      'user-1',
      'PENDING',
      ['is', null],
      { ascending: false },
      undefined,
    ]);
    expect(q.filters.find((f) => f.method === 'limit')?.args).toEqual([1]);
  });

  it('기다리는 제안이 없으면 null', async () => {
    suggestionDb(null);
    expect(await getPendingSuggestion()).toBeNull();
  });

  it('제안 한 줄: 내 것만, 없거나 바꿀 알람이 없어졌으면 null, 가짜 주소(s1)는 읽지 않고 null', async () => {
    suggestionDb(suggestionRow());
    expect((await getSuggestion(SUGGESTION_ID))?.id).toBe(SUGGESTION_ID);
    expect(filterOf(calls[0], 'eq', 'suggestion_id')?.[1]).toBe(SUGGESTION_ID);
    expect(filterOf(calls[0], 'eq', 'user_id')?.[1]).toBe('user-1');

    suggestionDb(suggestionRow({}, null));
    expect(await getSuggestion(SUGGESTION_ID)).toBeNull();
    suggestionDb(null);
    expect(await getSuggestion(SUGGESTION_ID)).toBeNull();

    resetFake();
    expect(await getSuggestion('s1')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('S01 적용', () => {
  it('알람 값 → 제안 기록 → 그 알람만 폰 맞추기 → 고친 값 기록 순서', async () => {
    const order: string[] = [];
    mockReconcile.mockImplementation(async () => {
      order.push('reconcile');
    });
    suggestionDb(suggestionRow(), (c) => {
      order.push(`${c.table}:${c.op}`);
      return undefined;
    });
    await applySuggestion(SUGGESTION_ID, 0);
    expect(order).toEqual(['alarm_suggestions:select', 'alarms:update', 'alarm_suggestions:update', 'reconcile', 'user_edit_logs:insert']);

    const alarmUpdate = onlyCalls('alarms', 'update')[0];
    expect(alarmUpdate.payload).toEqual({ voice_tone: 'DIRECT', intensity_source: 'MANUAL' });
    expect([filterOf(alarmUpdate, 'eq', 'alarm_id')?.[1], filterOf(alarmUpdate, 'eq', 'user_id')?.[1]]).toEqual(['alarm-1', 'user-1']);

    const suggestionUpdate = onlyCalls('alarm_suggestions', 'update')[0];
    expect(suggestionUpdate.payload).toEqual({ status: 'APPLIED', result_value: 'DIRECT', responded_at: '2026-10-19T00:30:00.000Z' });
    expect([filterOf(suggestionUpdate, 'in', 'status')?.[1], filterOf(suggestionUpdate, 'eq', 'user_id')?.[1]]).toEqual([['PENDING'], 'user-1']);

    expect(mockReconcile).toHaveBeenCalledWith({ alarmIds: ['alarm-1'] });
    expect(onlyCalls('user_edit_logs', 'insert')[0].payload).toEqual({
      user_id: 'user-1',
      screen: 'S01',
      field: 'voice_tone',
      alarm_id: 'alarm-1',
      alarm_type: 'WAKE',
      appointment_id: 'appt-1',
      auto_value: 0, // 차분 = 약
      edited_value: 2, // 직설 = 강
    });
  });

  it('종류마다 바뀌는 칸: 배경음 sound_key, 진동 intensity (값은 고친 값 기록에 약 · 중 · 강)', async () => {
    suggestionDb(suggestionRow({ suggestion_type: 'SOUND', current_value: 'theme_calm', suggested_value: 'theme_urgent' }, { sound_key: 'theme_calm' }));
    await applySuggestion(SUGGESTION_ID, 0);
    expect(onlyCalls('alarms', 'update')[0].payload).toEqual({ sound_key: 'theme_urgent', intensity_source: 'MANUAL' });
    expect(onlyCalls('user_edit_logs', 'insert')[0].payload).toMatchObject({ field: 'sound_key', auto_value: 0, edited_value: 2 });

    resetFake();
    suggestionDb(suggestionRow({ suggestion_type: 'INTENSITY', current_value: 'NORMAL', suggested_value: 'STRONG' }, { intensity: 'NORMAL' }));
    await applySuggestion(SUGGESTION_ID, 0);
    expect(onlyCalls('alarms', 'update')[0].payload).toEqual({ intensity: 'STRONG', intensity_source: 'MANUAL' });
    expect(onlyCalls('user_edit_logs', 'insert')[0].payload).toMatchObject({ field: 'intensity', auto_value: 1, edited_value: 2 });
  });

  it('알람을 못 바꾸면 제안 기록 · 폰 · 고친 값 기록을 하지 않고 던짐', async () => {
    suggestionDb(suggestionRow(), (c) => (c.table === 'alarms' && c.op === 'update' ? { error: { message: 'rls' } } : undefined));
    await expect(applySuggestion(SUGGESTION_ID, 0)).rejects.toMatchObject({ message: 'rls' });
    expect(onlyCalls('alarm_suggestions', 'update')).toHaveLength(0);
    expect(onlyCalls('user_edit_logs')).toHaveLength(0);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('알람 행이 없어졌거나(내 알람이 아님) 상태가 이미 바뀐 제안은 이유와 함께 거절', async () => {
    suggestionDb(suggestionRow(), (c) => (c.table === 'alarms' && c.op === 'update' ? { data: [] } : undefined));
    await expect(applySuggestion(SUGGESTION_ID, 0)).rejects.toThrow('바꿀 알람을 찾을 수 없어요');

    resetFake();
    suggestionDb(suggestionRow(), (c) => (c.table === 'alarm_suggestions' && c.op === 'update' ? { data: [] } : undefined));
    await expect(applySuggestion(SUGGESTION_ID, 0)).rejects.toBeInstanceOf(UserError);
  });

  it('기다림이 아니거나 제안이 없거나 값을 쓸 수 없으면 아무것도 쓰지 않음', async () => {
    suggestionDb(suggestionRow({ status: 'APPLIED', result_value: 'DIRECT' }));
    await expect(applySuggestion(SUGGESTION_ID, 0)).rejects.toThrow('기다리는 제안만 적용할 수 있어요');
    suggestionDb(suggestionRow({}, null));
    await expect(applySuggestion(SUGGESTION_ID, 0)).rejects.toThrow('바꿀 알람이 없어졌어요');
    suggestionDb(suggestionRow({ suggested_value: 'LOUD' }));
    await expect(applySuggestion(SUGGESTION_ID, 0)).rejects.toThrow('이 제안은 적용할 수 없어요');
    suggestionDb(null);
    await expect(applySuggestion(SUGGESTION_ID, 0)).rejects.toThrow('제안을 찾을 수 없어요');
    expect(calls.filter((c) => c.op !== 'select')).toHaveLength(0);
  });

  it('폰 맞추기 · 고친 값 기록이 실패해도 적용은 성공으로 (저장은 끝났음)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockReconcile.mockRejectedValue(new Error('read failed'));
    suggestionDb(suggestionRow(), (c) => (c.table === 'user_edit_logs' ? { error: { message: 'log failed' } } : undefined));
    await expect(applySuggestion(SUGGESTION_ID, 0)).resolves.toBeUndefined();
    expect(onlyCalls('alarm_suggestions', 'update')).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('S01 되돌리기 · 무시 · 다시 보기', () => {
  const applied = (alarmPatch: Record<string, unknown> = { voice_tone: 'DIRECT' }) => suggestionRow({ status: 'APPLIED', result_value: 'DIRECT' }, alarmPatch);

  it('되돌리기: 알람 값을 제안 전 값으로, 제안은 다시 기다림으로 (적용 이력 없음 — D23 열림)', async () => {
    suggestionDb(applied());
    await undoSuggestion(SUGGESTION_ID);
    const alarmUpdate = onlyCalls('alarms', 'update')[0];
    expect(alarmUpdate.payload).toEqual({ voice_tone: 'CALM' });
    const suggestionUpdate = onlyCalls('alarm_suggestions', 'update')[0];
    expect(suggestionUpdate.payload).toEqual({ status: 'PENDING', result_value: null });
    expect(filterOf(suggestionUpdate, 'in', 'status')?.[1]).toEqual(['APPLIED', 'EDITED']);
    expect(mockReconcile).toHaveBeenCalledWith({ alarmIds: ['alarm-1'] });
  });

  it('그 사이 알람 값을 직접 다시 고쳤으면 그 값은 건드리지 않고 제안만 기다림으로', async () => {
    suggestionDb(applied({ voice_tone: 'NEUTRAL' }));
    await undoSuggestion(SUGGESTION_ID);
    expect(onlyCalls('alarms', 'update')).toHaveLength(0);
    expect(onlyCalls('alarm_suggestions', 'update')[0].payload).toEqual({ status: 'PENDING', result_value: null });
  });

  it('적용한 제안이 아니거나 이전 값을 모르면 거절', async () => {
    suggestionDb(suggestionRow());
    await expect(undoSuggestion(SUGGESTION_ID)).rejects.toThrow('적용한 제안만 되돌릴 수 있어요');
    suggestionDb(suggestionRow({ status: 'APPLIED', result_value: 'DIRECT', current_value: null }));
    await expect(undoSuggestion(SUGGESTION_ID)).rejects.toThrow('이전 값을 알 수 없어 되돌릴 수 없어요');
    suggestionDb(null);
    await expect(undoSuggestion(SUGGESTION_ID)).rejects.toThrow('제안을 찾을 수 없어요');
    expect(calls.filter((c) => c.op !== 'select')).toHaveLength(0);
  });

  it('무시: 기다림 → 무시함 (얼마나 안 보여 줄지 suppress_until은 D24가 열려 있어 안 채움)', async () => {
    suggestionDb(suggestionRow());
    await ignoreSuggestion(SUGGESTION_ID);
    expect(onlyCalls('alarm_suggestions', 'update')[0].payload).toEqual({ status: 'IGNORED', responded_at: '2026-10-19T00:30:00.000Z' });

    suggestionDb(suggestionRow({ status: 'IGNORED' }));
    await expect(ignoreSuggestion(SUGGESTION_ID)).rejects.toThrow('기다리는 제안만 무시할 수 있어요');
  });

  it('다시 보기: 무시함 → 기다림, 안 보여 주는 기한은 비우고 responded_at은 남김', async () => {
    suggestionDb(suggestionRow({ status: 'IGNORED' }));
    await reopenSuggestion(SUGGESTION_ID);
    expect(onlyCalls('alarm_suggestions', 'update')[0].payload).toEqual({ status: 'PENDING', suppress_until: null });
    expect(filterOf(onlyCalls('alarm_suggestions', 'update')[0], 'in', 'status')?.[1]).toEqual(['IGNORED']);

    suggestionDb(suggestionRow());
    await expect(reopenSuggestion(SUGGESTION_ID)).rejects.toThrow('무시한 제안만 다시 볼 수 있어요');
  });
});
