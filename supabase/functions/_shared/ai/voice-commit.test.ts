// voice-commit(대화 끝 정리) 흐름 시험 — 가짜 DB(fake-db) + 가짜 모델(지점별 미리 정한 출력). 실제 Gemini · 운영 DB 없음
// 대화는 voice-session · voice-turn 진짜 길로 쌓음(글 = T2F + T1, 음성 = spoken_reply + T2F) — 끝 정리가 둘을 같은 흐름으로 받는지 봄
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpError } from '../errors.ts';
import { FakeDb } from '../fake-db.ts';
import type { Db } from '../supabase.ts';
import { fakeClaude, upstreamError, type FakeScript } from './fake-claude.ts';
import type { ServerState } from './session.ts';
import { emptyExtract } from './testing.ts';
import { handleVoiceTurn, type VoiceTurnOut } from './turn.ts';
import type { Structured } from './final-core.ts';
import { structuredProblems } from './structured.v1.ts';
import type { BehaviorReport, Card, FinalExtract } from './types.ts';
import { handleVoiceCommit, type CommitDeps, type VoiceCommitOut } from './voice-commit.ts';
import { handleVoiceSession, type VoiceSessionOut } from './voice-session.ts';

const ME = 'u-me';
const REVIEW = '2026-10-29';
const TOMORROW = '2026-10-30';
const NOW = new Date('2026-10-29T22:30:00+09:00');
const T2F_NONE = { appointments: [], alarm_changes: [], fact_feedback: [], prep_adjustment: null, safety_flag: false };
const T1_OK = { reply: '그랬군요. 오늘도 수고했어요.', acts: [], end: false };
let seq = 0;
const cid = () => `cccccccc-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

// 10/29: 팀플 회의 13:00(도착 기록 없음, 기상 알람 08:00) · 캡스톤 수업 10:00(위치로 도착 10:07, 지각 아님)
function seed(): FakeDb {
  const db = new FakeDb();
  db.now = NOW;
  db.rows('profiles').push({ user_id: ME, nickname: '지민', timezone: 'Asia/Seoul' });
  db.rows('appointments').push(
    { appointment_id: 'ap-team', creator_id: ME, title: '팀플 회의', appointment_at: '2026-10-29T13:00:00+09:00', dest_name: '학생회관', importance: 'NORMAL', recurrence_rule: null },
    { appointment_id: 'ap-class', creator_id: ME, title: '캡스톤 수업', appointment_at: '2026-10-29T10:00:00+09:00', dest_name: '공학관', importance: 'NORMAL', recurrence_rule: null },
  );
  db.rows('appointment_participants').push(
    { participant_id: 'pt-team', appointment_id: 'ap-team', user_id: ME, transport_type: 'WALK', est_travel_minutes: 15, departed_at: null, departed_source: null, arrived_at: null, arrived_source: null, is_late: null, late_minutes: null },
    {
      participant_id: 'pt-class', appointment_id: 'ap-class', user_id: ME, transport_type: 'SUBWAY', est_travel_minutes: 30,
      departed_at: '2026-10-29T09:20:00+09:00', departed_source: 'LOCATION', arrived_at: '2026-10-29T10:07:00+09:00', arrived_source: 'LOCATION', is_late: false, late_minutes: 0,
    },
  );
  db.rows('alarms').push({ alarm_id: 'al-wake', user_id: ME, participant_id: 'pt-team', routine_id: null, alarm_type: 'WAKE', scheduled_at: '2026-10-29T08:00:00+09:00', intensity: 'NORMAL', is_enabled: true, time_source: 'AUTO' });
  db.rows('alarm_events').push({ event_id: 1, alarm_id: 'al-wake', user_id: ME, event_type: 'TRIGGERED', event_at: '2026-10-29T08:00:00+09:00', input_source: null });
  return db;
}

/** 대화 열고 말 쌓기 — [말, 음성이면 Live 답] */
async function chat(db: FakeDb, lines: [string, string?][], t2: FakeScript['T2'] = []) {
  const voiceTurns = lines.filter(([, spoken]) => spoken !== undefined).length;
  const fake = fakeClaude({ T2F: lines.map(() => T2F_NONE), T1: Array(lines.length - voiceTurns).fill(T1_OK), T2: t2 });
  let t = 0;
  const deps: CommitDeps = { userId: ME, userDb: db as unknown as Db, service: db as unknown as Db, llm: fake.client, model: 'gemini-3.5-flash-lite', now: () => NOW, clock: () => (t += 40), sleep: async () => {} };
  const s = (await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut;
  const sid = s.session_id as string;
  let rev = s.rev;
  for (const [said, spoken] of lines) {
    const r = (await handleVoiceTurn(deps, { session_id: sid, rev, client_turn_id: cid(), text: said, ...(spoken !== undefined ? { spoken_reply: spoken } : {}) })) as VoiceTurnOut;
    rev = r.rev;
  }
  return { fake, deps, sid };
}

const rowOf = (db: FakeDb, sid: string) => db.rows('conversation_sessions').find((s) => s.session_id === sid) as { server_state: ServerState; ended_at: string | null; extracted_data: any; apply_status?: string; transcript?: string };
const commit = (deps: CommitDeps, sid: string) => handleVoiceCommit(deps, { session_id: sid }) as Promise<VoiceCommitOut>;

/** 대화 중 카드 결과를 상태에 넣음 (카드 흐름 자체는 voice.flow.test.ts가 봄) */
function putCards(db: FakeDb, sid: string, cards: Partial<Card>[]) {
  rowOf(db, sid).server_state.cards = cards.map((c, i) => ({
    id: `c${i + 1}`, kind: 'APPT_NEW', status: 'READY', first_of_day: false, highlight: false, summary: '', edit: null, digest: null, items: [], appointment_id: null, error: null,
    draft: { title: '', date: TOMORROW, time: '14:00', place: null, importance: null, transport: null, repeat: [], items: [], alarms: { WAKE: true, PREPARE: true, DEPARTURE: true } },
    ...c,
  })) as Card[];
}

const appt = (title: string, over: Partial<FinalExtract['appointments'][number]> = {}) => ({
  ref: null, title, date: TOMORROW, time: '14:00', place: null, importance: null, transport: null, repeat: 'NONE' as const, save: 'UNCONFIRMED' as const, unclear: null, ...over,
});
const beh = (kind: BehaviorReport['kind'], over: Partial<BehaviorReport> = {}): BehaviorReport => ({
  kind, date: REVIEW, time: null, minutes: null, appointment_ref: null, appointment_title: null, reasons: [], source: 'stated', uncertain: null, ...over,
});
const todo = (title: string, over: Partial<FinalExtract['todos'][number]> = {}) => ({ title, type: 'ITEM' as const, due_date: null, appointment_ref: null, appointment_title: null, ...over });

async function failure(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof HttpError, String(e));
    return e;
  }
  assert.fail('오류가 나야 함');
}

// ───────── 추출 · 저장 ─────────

test('글 대화: 여러 일정 · 준비물 — 할 일만 저장, 일정은 카드 상태대로 (새 appointments 줄 없음)', async () => {
  const db = seed();
  const out = emptyExtract({
    appointments: [appt('스터디', { place: '도서관' }), appt('영화', { date: '2026-11-01', time: '19:00' })],
    todos: [todo('노트북', { appointment_title: '스터디' }), todo('우산', { due_date: TOMORROW }), todo('과제 제출', { type: 'TASK', due_date: TOMORROW })],
  });
  const { fake, deps, sid } = await chat(db, [['내일 2시에 도서관에서 스터디 있어. 노트북 챙겨야 해'], ['일요일 7시에 영화도 보고, 우산이랑 과제 제출도 잊지 말아야지']], [out]);
  db.rows('appointments').push({ appointment_id: 'ap-new', creator_id: ME, title: '스터디', appointment_at: '2026-10-30T14:00:00+09:00', dest_name: '도서관', importance: 'NORMAL' }); // 카드 [저장]이 만든 줄
  putCards(db, sid, [{ status: 'SAVED', appointment_id: 'ap-new', draft: { title: '스터디', date: TOMORROW, time: '14:00', place: '도서관', importance: null, transport: null, repeat: [], items: [], alarms: { WAKE: true, PREPARE: true, DEPARTURE: true } } }]);
  const apptsBefore = db.rows('appointments').length;

  const r = await commit(deps, sid);
  assert.equal(r.status, 'DONE');
  assert.equal(r.saved.todos, 3);
  assert.deepEqual(r.pending, ['일정 확인 필요: 영화']);
  assert.deepEqual(db.rows('todos').map((t) => [t.title, t.todo_type, t.appointment_id, t.due_date, t.source_session_id]), [
    ['노트북', 'ITEM', 'ap-new', null, sid], ['우산', 'ITEM', null, TOMORROW, sid], ['과제 제출', 'TASK', null, TOMORROW, sid],
  ]);
  assert.equal(db.rows('appointments').length, apptsBefore); // 일정은 카드로만
  const row = rowOf(db, sid);
  assert.equal(row.apply_status, 'APPLIED');
  assert.equal(row.ended_at, '2026-10-29T22:30:00+09:00');
  assert.equal(row.server_state.ended, true);
  assert.equal(row.server_state.commit?.status, 'DONE');
  const x = row.extracted_data as Structured;
  assert.deepEqual(structuredProblems(x), []);
  assert.equal(x.schema_version, 'structured.v1');
  assert.deepEqual(x.session, {
    session_id: sid, reference_date: REVIEW, session_type: 'night', input_modes: ['text'], started_at: x.session.started_at, ended_at: '2026-10-29T22:30:00+09:00',
    extracted_at: '2026-10-29T22:30:00+09:00', extractor: { prompt: 'T2@v3.2', schema: 'extract.v2' },
  });
  assert.deepEqual(x.appointments.map((a) => [a.title, a.status, a.appointment_id]), [['스터디', 'saved', 'ap-new'], ['영화', 'needs_confirm', null]]);
  assert.deepEqual(x.todos.map((t) => [t.title, t.stored]), [['노트북', 'inserted'], ['우산', 'inserted'], ['과제 제출', 'inserted']]);
  assert.deepEqual(x.storage.map((t) => [t.table, t.key, t.result]), [['todos', '노트북', 'inserted'], ['todos', '우산', 'inserted'], ['todos', '과제 제출', 'inserted']]);
  assert.match(row.transcript ?? '', /^AI: .*\n사용자: 내일 2시에 도서관에서 스터디 있어/s);
  assert.deepEqual(fake.order.filter((p) => p === 'T2'), ['T2']);
  assert.deepEqual(db.rows('ai_calls').filter((c) => c.point === 'T2').map((c) => [c.prompt_version, c.ok, c.session_id]), [['v3.2', true, sid]]);
  // 끝난 대화에는 말을 더 못 보냄 (카드 버튼은 그대로 받음 — turn.ts)
  const e = await failure(handleVoiceTurn(deps, { session_id: sid, rev: row.server_state.rev, client_turn_id: cid(), text: '하나 더' }));
  assert.equal(e.code, 'CONFLICT');
});

const LATE_TALK = '오늘 수업에 10분 지각했어. 8시에 알람이 울렸는데 8시 15분에 일어났고, 준비하는 데 평소보다 20분 더 걸렸어';
const lateExtract = () => emptyExtract({
  behavior: [
    beh('LATE', { minutes: 10, appointment_title: '수업' }),
    beh('ALARM_RING', { time: '08:00' }),
    beh('WAKE', { time: '08:15', reasons: ['OVERSLEPT'] }),
    beh('PREP_OVER', { minutes: 20 }),
    beh('ARRIVE', { time: '10:10', appointment_title: '수업' }), // 위치로 10:07 도착이 이미 있음 — 덮지 않음
  ],
});

test('글 · 음성(Live) 대화가 같은 말이면 같은 구조화 JSON (입력 방식만 다름), T2는 Live가 소리로 한 답도 문맥으로 받음', async () => {
  const dbText = seed();
  const t = await chat(dbText, [[LATE_TALK]], [lateExtract()]);
  await commit(t.deps, t.sid);
  const dbVoice = seed();
  const v = await chat(dbVoice, [[LATE_TALK, '많이 바빴겠어요.']], [lateExtract()]);
  await commit(v.deps, v.sid);
  assert.match(v.fake.seen.T2[0], /많이 바빴겠어요/);
  const a = rowOf(dbText, t.sid).extracted_data as Structured;
  const b = rowOf(dbVoice, v.sid).extracted_data as Structured;
  assert.deepEqual([a.session.input_modes, b.session.input_modes], [['text'], ['voice']]);
  const { session: _a, ...restA } = a;
  const { session: _b, ...restB } = b;
  assert.deepEqual(restA, restB);
  assert.deepEqual(structuredProblems(b), []);
});

test('예시 대화: 지각 10분 · 기상 지연 15분(말한 알람 시각 기준) · 준비 초과 20분이 각자 자리에, 시스템 측정 칸 · 다른 담당 표는 그대로', async () => {
  const db = seed();
  const { deps, sid } = await chat(db, [[LATE_TALK]], [lateExtract()]);
  const before = structuredClone({ p: db.rows('appointment_participants'), e: db.rows('alarm_events') });

  const r = await commit(deps, sid);
  assert.equal(r.status, 'DONE');
  const x = rowOf(db, sid).extracted_data as Structured;
  assert.deepEqual(x.schedule_outcomes.map((o) => [o.appointment_id, o.is_late, o.late_minutes, o.arrived_at, o.status]), [['ap-class', true, 10, '2026-10-29T10:10:00+09:00', 'recorded']]);
  assert.deepEqual(x.sleep_wake.map((w) => [w.alarm_rang_at, w.wake_at, w.wake_delay_minutes, w.wake_delay_basis, w.overslept]), [['2026-10-29T08:00:00+09:00', '2026-10-29T08:15:00+09:00', 15, 'stated_alarm_time', true]]);
  assert.deepEqual(x.behavior.filter((b) => b.kind === 'prep_over').map((b) => b.minutes), [20]);
  // 위치로 잰 도착 · 지각 판정(10:07 · 지각 아님), 알람 반응 기록은 말로 바뀌지 않음 · 새로 생기지 않음
  assert.deepEqual(db.rows('appointment_participants'), before.p);
  assert.deepEqual(db.rows('alarm_events'), before.e);
  assert.equal(db.rows('daily_records').length, 0); // 기상 · 준비 진술은 표의 측정 칸에 안 씀
  assert.equal(db.rows('daily_journals').length, 0);
});

test('일정을 모르는 지각 · 날짜 모르는 진술 · 모호한 일정 → 저장 없이 JSON에 확인 필요로 남김', async () => {
  const db = seed();
  const out = emptyExtract({
    appointments: [appt('산책', { date: null, time: null, unclear: "'산책'의 날짜 · 시각을 모름" })],
    behavior: [beh('LATE', { minutes: 10 }), beh('SNOOZE', { minutes: 2, date: null })],
  });
  const { deps, sid } = await chat(db, [['오늘 10분 지각했어. 알람도 두 번 미뤘고. 초롱이랑 산책 약속도 있어']], [out]);
  const r = await commit(deps, sid);
  assert.equal(r.status, 'DONE');
  assert.deepEqual(r.pending, ["일정 확인 필요: 산책 ('산책'의 날짜 · 시각을 모름)", 'late 기록 확인 필요: 어느 일정인지 모름', 'snooze 기록 확인 필요: 날짜를 모름']);
  const x = rowOf(db, sid).extracted_data as Structured;
  assert.deepEqual(x.schedule_outcomes.map((o) => [o.appointment_id, o.late_minutes, o.link, o.status]), [[null, 10, 'unlinked', 'needs_confirm']]);
  assert.deepEqual(x.behavior.map((b) => [b.kind, b.minutes, b.issue]), [['late', 10, 'unlinked'], ['snooze', 2, 'no_date']]);
  assert.equal(db.rows('appointment_participants').find((p) => p.participant_id === 'pt-team')!.is_late, null);
});

test('감정 · 습관 · 목표 · 알람 평가 · 수면 → JSON 전부, 표에는 수면 진술 칸의 빈 칸만 (이미 있는 값은 kept_existing)', async () => {
  const db = seed();
  db.rows('daily_records').push({ record_id: 'r-old', user_id: ME, record_date: REVIEW, wake_confirmed_at: '2026-10-29T08:16:00+09:00', sleep_satisfaction: 3, data_source: 'ALARM' });
  const out = emptyExtract({
    behavior: [beh('SLEEP', { date: '2026-10-28', time: '23:40' }), beh('WAKE', { date: '2026-10-28', time: '07:30' })],
    daily_record: { sleep_time: '23:30', sleep_satisfaction: 2, condition_note: '많이 피곤함' },
    day_review: { events: [{ text: '발표를 잘 마침', time: null, important: true, source: 'stated' }], memorable: '발표를 잘 마침' },
    mood_condition: { mood: ['good', 'tired'], valence: 1, fatigue: null, stress: null, causes: ['발표를 잘 마쳐서 뿌듯함'], source: 'stated' },
    habit_signals: [{ habit: 'phone_in_bed', note: '요즘 자기 전에 휴대폰을 오래 봄', date: null, recurring: true, source: 'stated' }],
    goals_routine: { goals: [{ habit: 'late_bedtime', goal_text: '12시 전에 자기', source: 'stated' }], wanted_routine: '아침 20분 운동' },
    alarm_feedback: [{ effect: 'too_weak', alarm_type: 'WAKE', date: REVIEW, note: '소리가 작아서 못 들음', source: 'stated' }],
  });
  const { deps, sid } = await chat(db, [['발표 잘 마쳐서 뿌듯한데 너무 피곤해. 요즘 자기 전에 폰을 오래 봐. 12시 전에 자고 싶고 아침에 20분 운동하고 싶어. 알람 소리가 작아서 못 들었어']], [out]);
  const r = await commit(deps, sid);
  assert.equal(r.status, 'DONE');
  const x = rowOf(db, sid).extracted_data as Structured;
  assert.deepEqual([x.mood_condition.mood, x.mood_condition.fatigue, x.mood_condition.condition_note], [['good', 'tired'], null, '많이 피곤함']);
  assert.deepEqual([x.habit_signals.length, x.goals_routine.goals.length, x.goals_routine.wanted_routine, x.alarm_feedback[0].db_feedback_type], [1, 1, '아침 20분 운동', 'TOO_QUIET']);
  // 10/28 기상 · 10/29 기록(23:40 취침은 다음 날 아침 기록)이 날짜별로
  assert.deepEqual(x.sleep_wake.map((w) => [w.date, w.sleep_at, w.wake_at]), [['2026-10-28', null, '2026-10-28T07:30:00+09:00'], [REVIEW, '2026-10-28T23:40:00+09:00', null]]);
  const rec = db.rows('daily_records').find((d) => d.record_date === REVIEW)!;
  assert.deepEqual([rec.sleep_at, rec.sleep_satisfaction, rec.condition_note, rec.wake_confirmed_at, rec.data_source], ['2026-10-28T23:40:00+09:00', 3, '많이 피곤함', '2026-10-29T08:16:00+09:00', 'ALARM']);
  assert.deepEqual(x.storage.filter((s) => s.table === 'daily_records').map((s) => [s.key, s.column, s.result]), [
    [REVIEW, 'sleep_at', 'written'], [REVIEW, 'sleep_satisfaction', 'kept_existing'], [REVIEW, 'condition_note', 'written'],
  ]);
  assert.deepEqual([db.rows('daily_journals').length, db.rows('alarm_events').length], [0, 1]); // 일기 · 알람 반응은 안 씀
});

test('일정 정보가 없는 일상 대화 → 아무 표에도 안 씀, JSON은 빈 칸으로 저장', async () => {
  const db = seed();
  const { deps, sid } = await chat(db, [['오늘 그냥 평범했어']], [emptyExtract()]);
  const r = await commit(deps, sid);
  assert.deepEqual([r.status, r.saved, r.pending, r.failed], ['DONE', { todos: 0, daily_records: 0 }, [], []]);
  assert.deepEqual([db.rows('todos').length, db.rows('daily_records').length, db.rows('daily_journals').length], [0, 0, 0]);
  const x = rowOf(db, sid).extracted_data as Structured;
  assert.deepEqual([x.behavior, x.storage, x.pending], [[], [], []]);
});

test('이미 있는 준비물 · 할 일과 겹치면 다시 넣지 않음', async () => {
  const db = seed();
  db.rows('todos').push(
    { todo_id: 't-old', user_id: ME, appointment_id: null, source_session_id: null, title: '우산', todo_type: 'ITEM', due_date: TOMORROW, is_done: false, created_at: '2026-10-28T20:00:00+09:00' },
    { todo_id: 't-card', user_id: ME, appointment_id: 'ap-team', source_session_id: null, title: '발표 자료', todo_type: 'ITEM', due_date: null, is_done: false, created_at: '2026-10-29T20:00:00+09:00' },
  );
  let teamRef = ''; // 팀플 회의의 a# — context가 정하므로 대화를 연 뒤 상태에서 읽음 (T2 출력은 부를 때 만듦)
  const out = () => emptyExtract({ todos: [todo('우산 챙기기', { due_date: TOMORROW }), todo('발표 자료', { appointment_ref: teamRef }), todo('충전기', { due_date: TOMORROW })] });
  const { deps, sid } = await chat(db, [['내일 우산 챙기고 팀플 발표 자료랑 충전기도']], [out]);
  teamRef = rowOf(db, sid).server_state.ctx.today.appointments.find((a) => a.title === '팀플 회의')!.ref;
  const r = await commit(deps, sid);
  assert.equal(r.saved.todos, 1);
  assert.deepEqual(db.rows('todos').map((t) => t.title), ['우산', '발표 자료', '충전기']);
});

test('사용자가 일정 저장을 거절: 카드 거절 · 말로 거절 → declined, 일정 줄 없음 · 그 일정 준비물은 연결 없이 남음(D32 A)', async () => {
  const db = seed();
  const out = emptyExtract({ appointments: [appt('동아리'), appt('술자리', { save: 'DECLINED' })], todos: [todo('회비', { appointment_title: '동아리' })] });
  const { deps, sid } = await chat(db, [['내일 동아리 모임 있어, 회비 챙겨야 해'], ['술자리는 저장 안 해도 돼']], [out]);
  putCards(db, sid, [{ status: 'REJECTED', draft: { title: '동아리', date: TOMORROW, time: '14:00', place: null, importance: null, transport: null, repeat: [], items: [], alarms: { WAKE: true, PREPARE: true, DEPARTURE: true } } }]);
  const apptsBefore = db.rows('appointments').length;
  const r = await commit(deps, sid);
  assert.deepEqual(r.pending, []);
  assert.deepEqual((rowOf(db, sid).extracted_data as Structured).appointments.map((a) => a.status), ['declined', 'declined']);
  assert.equal(db.rows('appointments').length, apptsBefore);
  assert.deepEqual(db.rows('todos').map((t) => [t.title, t.appointment_id]), [['회비', null]]);
});

// ───────── 실패 · 다시 시도 · 겹친 요청 ─────────

test('저장 일부 실패 → PARTIAL · apply_status PENDING, 다시 보내면 T2 없이 이어서 저장 · 한 번만', async () => {
  const db = seed();
  const out = emptyExtract({
    todos: [todo('우산', { due_date: TOMORROW })],
    daily_record: { sleep_time: null, sleep_satisfaction: 4, condition_note: null },
  });
  const { fake, deps, sid } = await chat(db, [['내일 우산 챙겨야 해. 어젯밤엔 잘 잤어']], [out]);
  db.failOn.push({ table: 'todos', op: 'insert' });

  const r1 = await commit(deps, sid);
  assert.equal(r1.status, 'PARTIAL');
  assert.deepEqual(r1.failed, ['todos']);
  assert.equal(r1.saved.daily_records, 1);
  assert.equal(rowOf(db, sid).apply_status, 'PENDING');
  assert.equal(db.rows('todos').length, 0);

  db.failOn = [];
  const r2 = await commit(deps, sid);
  assert.equal(r2.status, 'DONE');
  assert.equal(fake.left('T2'), 0);
  assert.equal(fake.order.filter((p) => p === 'T2').length, 1); // 추출 결과를 다시 씀
  assert.deepEqual(db.rows('todos').map((t) => t.title), ['우산']);
  assert.equal(db.rows('daily_records').length, 1);
  assert.equal(db.rows('daily_records')[0].sleep_satisfaction, 4);
  assert.equal(rowOf(db, sid).apply_status, 'APPLIED');
  assert.equal(rowOf(db, sid).server_state.commit?.attempts, 2);

  const r3 = await commit(deps, sid); // 끝난 뒤 또 오면 저장한 답 그대로, 쓰기 없음
  assert.deepEqual(r3, r2);
  assert.equal(db.rows('todos').length, 1);
});

test('추출(T2) 실패 → LLM_UNAVAILABLE · FAILED, 다시 보내면 T2를 다시 불러 끝냄', async () => {
  const db = seed();
  const { fake, deps, sid } = await chat(db, [['내일 우산 챙겨야 해']], [upstreamError(), upstreamError(), emptyExtract({ todos: [todo('우산')] })]);
  const e = await failure(commit(deps, sid));
  assert.equal(e.code, 'LLM_UNAVAILABLE');
  assert.equal(rowOf(db, sid).server_state.commit?.status, 'FAILED');
  assert.equal(db.rows('todos').length, 0);
  const r = await commit(deps, sid);
  assert.equal(r.status, 'DONE');
  assert.equal(fake.left('T2'), 0);
  assert.deepEqual(db.rows('todos').map((t) => t.title), ['우산']);
});

test('같은 종료 요청이 동시에 두 번 → 하나만 처리(T2 1번), 다른 하나는 RUNNING · 끝난 뒤는 같은 답', async () => {
  const db = seed();
  const { fake, deps, sid } = await chat(db, [['내일 우산 챙겨야 해']], [emptyExtract({ todos: [todo('우산')] })]);
  const [a, b] = await Promise.all([commit(deps, sid), commit(deps, sid)]);
  assert.deepEqual([a.status, b.status].sort(), ['DONE', 'RUNNING']);
  assert.equal(fake.order.filter((p) => p === 'T2').length, 1);
  assert.equal(db.rows('todos').length, 1);
  const again = await commit(deps, sid);
  assert.equal(again.status, 'DONE');
  assert.equal(db.rows('todos').length, 1);
});

test('처리 중(RUNNING)이 오래 멈췄으면 다시 시도를 받음', async () => {
  const db = seed();
  const { deps, sid } = await chat(db, [['내일 우산 챙겨야 해']], [emptyExtract({ todos: [todo('우산')] })]);
  const st = rowOf(db, sid).server_state;
  st.commit = { status: 'RUNNING', attempts: 1, started_at: '2026-10-29T22:00:00+09:00', finished_at: null, extract: null, out: null, error: null };
  const r = await commit(deps, sid);
  assert.equal(r.status, 'DONE');
  assert.equal(rowOf(db, sid).server_state.commit?.attempts, 2);
});

test('말이 없는 대화는 SKIPPED(모델 0번 · 안 끝냄), 남의 세션은 NOT_FOUND, 키 없음은 NOT_CONFIGURED', async () => {
  const db = seed();
  const { fake, deps, sid } = await chat(db, []);
  assert.equal((await commit(deps, sid)).status, 'SKIPPED');
  assert.equal(rowOf(db, sid).server_state.ended, false);
  assert.equal(fake.order.length, 0);
  assert.equal((await failure(handleVoiceCommit({ ...deps, userId: 'u-other' }, { session_id: sid }))).code, 'NOT_FOUND');
  assert.equal((await failure(handleVoiceCommit(deps, { session_id: 'nope' }))).code, 'VALIDATION_FAILED');

  const db2 = seed();
  const c2 = await chat(db2, [['내일 우산']]);
  assert.equal((await failure(handleVoiceCommit({ ...c2.deps, llm: null }, { session_id: c2.sid }))).code, 'NOT_CONFIGURED');
});

test('표에 같은 순간이 다른 글자 모양(+00:00)으로 있으면 같은 값 — kept_existing이 아니라 written', async () => {
  const db = seed();
  db.rows('daily_records').push({ record_id: 'r1', user_id: ME, record_date: REVIEW, sleep_at: '2026-10-28T14:40:00+00:00', data_source: 'AI' });
  const out = emptyExtract({ behavior: [beh('SLEEP', { date: '2026-10-28', time: '23:40' })] });
  const { deps, sid } = await chat(db, [['어젯밤 11시 40분에 잤어']], [out]);
  await commit(deps, sid);
  const x = rowOf(db, sid).extracted_data as Structured;
  assert.deepEqual(x.storage.map((s) => [s.column, s.result]), [['sleep_at', 'written']]);
});

test('자정을 넘긴 대화(10/30 00:40, 아직 기상 기록 없음) → 기준일 10/29: T2 날짜표의 오늘 = 10/29 + 자정 줄, reference_date 10/29, "오늘 수업" 지각은 10/29 수업에 연결', async () => {
  const db = seed();
  const AFTER = new Date('2026-10-30T00:40:00+09:00');
  db.now = AFTER;
  const out = emptyExtract({ behavior: [beh('LATE', { date: REVIEW, minutes: 5, appointment_title: '수업' })] });
  const fake = fakeClaude({ T2F: [T2F_NONE], T1: [T1_OK], T2: [out] });
  let t = 0;
  const deps: CommitDeps = { userId: ME, userDb: db as unknown as Db, service: db as unknown as Db, llm: fake.client, model: 'm', now: () => AFTER, clock: () => (t += 40), sleep: async () => {} };
  const s = (await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut;
  await handleVoiceTurn(deps, { session_id: s.session_id as string, rev: s.rev, client_turn_id: cid(), text: '오늘 수업에 5분 늦었어' });
  await commit(deps, s.session_id as string);
  assert.match(fake.seen.T2[0], /자정이 지났지만 잠들기 전이라 '오늘'은 2026-10-29\(목\)/);
  assert.match(fake.seen.T2[0], /오늘 2026-10-29\(목\) · 내일 2026-10-30\(금\)/);
  const x = rowOf(db, s.session_id as string).extracted_data as Structured;
  assert.equal(x.session.reference_date, REVIEW);
  assert.deepEqual(x.schedule_outcomes.map((o) => [o.date, o.appointment_id, o.status]), [[REVIEW, 'ap-class', 'recorded']]);
});

test('모델이 숫자 없는 피로를 점수로 내도(fatigue 5) 저장 JSON에는 null — 실제 시험 문장 B', async () => {
  const db = seed();
  const out = emptyExtract({ mood_condition: { mood: ['tired'], valence: null, fatigue: 5, stress: null, causes: ['발표'], source: 'stated' } });
  const { deps, sid } = await chat(db, [['어제 새벽 1시까지 휴대폰을 봤어. 오늘 발표는 잘 끝났는데 너무 피곤해. 앞으로 12시 전에는 자고 싶어.']], [out]);
  await commit(deps, sid);
  const x = rowOf(db, sid).extracted_data as Structured;
  assert.deepEqual([x.mood_condition.fatigue, x.mood_condition.mood], [null, ['tired']]);
});
