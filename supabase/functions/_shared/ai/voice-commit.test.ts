// voice-commit(대화 끝 정리) 흐름 시험 — 가짜 DB(fake-db) + 가짜 모델(지점별 미리 정한 출력). 실제 Gemini · 운영 DB 없음
// 대화는 voice-session · voice-turn 진짜 길로 쌓음(글 = T2F + T1, 음성 = spoken_reply + T2F) — 끝 정리가 둘을 같은 흐름으로 받는지 봄
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpError } from '../errors.ts';
import { FakeDb } from '../fake-db.ts';
import type { Db } from '../supabase.ts';
import { fakeClaude, upstreamError, type FakeScript } from './fake-claude.ts';
import { loadSession, roomTurns, type ServerState } from './session.ts';
import { LlmClientError } from './llm.ts';
import { emptyExtract } from './testing.ts';
import { handleVoiceTurn, type VoiceTurnOut } from './turn.ts';
import type { Structured } from './final-core.ts';
import { structuredProblems } from './structured.v1.ts';
import type { BehaviorReport, Card, FinalExtract } from './types.ts';
import { fallbackDiary, handleVoiceCommit, journalFacts, type CommitDeps, type VoiceCommitOut } from './voice-commit.ts';
import { CARRIED_STALE_ERROR, handleVoiceSession, withCardTimes, type VoiceSessionOut } from './voice-session.ts';

const ME = 'u-me';
const REVIEW = '2026-10-29';
const TOMORROW = '2026-10-30';
const NOW = new Date('2026-10-29T22:30:00+09:00');
const T2F_NONE = { appointments: [], alarm_changes: [], fact_feedback: [], prep_adjustment: null, safety_flag: false };
const T1_OK = { reply: '그랬군요. 오늘도 수고했어요.', acts: [], end: false };
const DIARY = { diary: '오늘은 알람을 여러 번 미뤄 수업에 지각했지만, 오후에는 팀플 발표를 잘 마치고 교수님께 칭찬도 받았다. 조금 피곤했지만 기분 좋은 하루였다.' };
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

const AFTER_MIDNIGHT = new Date('2026-10-30T00:40:00+09:00');

/** 대화 열고(같은 날 열린 방이 있으면 이어 받음) 말 쌓기 — [말, 음성이면 Live 답] */
async function chat(db: FakeDb, lines: [string, string?][], t2: FakeScript['T2'] = [], t5: FakeScript['T5'] = Array(3).fill(DIARY), at: Date = NOW) {
  const voiceTurns = lines.filter(([, spoken]) => spoken !== undefined).length;
  const fake = fakeClaude({ T2F: lines.map(() => T2F_NONE), T1: Array(lines.length - voiceTurns).fill(T1_OK), T2: t2, T5: t5 });
  let t = 0;
  const deps: CommitDeps = { userId: ME, userDb: db as unknown as Db, service: db as unknown as Db, llm: fake.client, model: 'gemini-3.5-flash-lite', now: () => at, clock: () => (t += 40), sleep: async () => {} };
  const s = (await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut;
  const sid = s.session_id as string;
  let rev = s.rev;
  for (const [said, spoken] of lines) {
    const r = (await handleVoiceTurn(deps, { session_id: sid, rev, client_turn_id: cid(), text: said, ...(spoken !== undefined ? { spoken_reply: spoken } : {}) })) as VoiceTurnOut;
    rev = r.rev;
  }
  return { fake, deps, sid, session: s };
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
  assert.equal(row.ended_at, null); // [완료]는 세션을 끝내지 않음 — 같은 날 이어 말함
  assert.equal(row.server_state.ended, false);
  assert.equal(row.server_state.commit?.status, 'DONE');
  const x = row.extracted_data as Structured;
  assert.deepEqual(structuredProblems(x), []);
  assert.equal(x.schema_version, 'structured.v1');
  assert.deepEqual(x.session, {
    session_id: sid, reference_date: REVIEW, session_type: 'night', input_modes: ['text'], started_at: x.session.started_at, ended_at: '2026-10-29T22:30:00+09:00',
    extracted_at: '2026-10-29T22:30:00+09:00', extractor: { prompt: 'T2@v3.3', schema: 'extract.v2' },
  });
  assert.deepEqual(x.appointments.map((a) => [a.title, a.status, a.appointment_id]), [['스터디', 'saved', 'ap-new'], ['영화', 'needs_confirm', null]]);
  assert.deepEqual(x.todos.map((t) => [t.title, t.stored]), [['노트북', 'inserted'], ['우산', 'inserted'], ['과제 제출', 'inserted']]);
  assert.deepEqual(x.storage.map((t) => [t.table, t.key, t.result]), [['todos', '노트북', 'inserted'], ['todos', '우산', 'inserted'], ['todos', '과제 제출', 'inserted']]);
  assert.match(row.transcript ?? '', /^AI: .*\n사용자: 내일 2시에 도서관에서 스터디 있어/s);
  assert.deepEqual(fake.order.filter((p) => p === 'T2'), ['T2']);
  assert.deepEqual(db.rows('ai_calls').filter((c) => c.point === 'T2').map((c) => [c.prompt_version, c.ok, c.session_id]), [['v3.3', true, sid]]);
  // 정리한 대화에도 이어 말할 수 있음 (같은 날 같은 방) — 예전 방식으로 끝낸(ended) 대화만 CONFLICT
  const more = fakeClaude({ T2F: [T2F_NONE], T1: [T1_OK] });
  const next = await handleVoiceTurn({ ...deps, llm: more.client }, { session_id: sid, rev: row.server_state.rev, client_turn_id: cid(), text: '하나 더' });
  assert.equal(next.reply?.text, T1_OK.reply);
  rowOf(db, sid).server_state.ended = true;
  const e = await failure(handleVoiceTurn(deps, { session_id: sid, rev: rowOf(db, sid).server_state.rev, client_turn_id: cid(), text: '또' }));
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
  assert.equal(db.rows('daily_journals').length, 1); // 일기는 따로 한 줄 (아래 '하루 일기' 시험)
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
  assert.deepEqual(x.goals_routine.goals, [{ habit: 'other', goal_text: '12시 전에 자기', source: 'stated' }]); // 늦게 잔다고 말한 신호가 없음 — 습관은 단정하지 않고 문장만
  // 10/28 기상 · 10/29 기록(23:40 취침은 다음 날 아침 기록)이 날짜별로
  assert.deepEqual(x.sleep_wake.map((w) => [w.date, w.sleep_at, w.wake_at]), [['2026-10-28', null, '2026-10-28T07:30:00+09:00'], [REVIEW, '2026-10-28T23:40:00+09:00', null]]);
  const rec = db.rows('daily_records').find((d) => d.record_date === REVIEW)!;
  assert.deepEqual([rec.sleep_at, rec.sleep_satisfaction, rec.condition_note, rec.wake_confirmed_at, rec.data_source], ['2026-10-28T23:40:00+09:00', 3, '많이 피곤함', '2026-10-29T08:16:00+09:00', 'ALARM']);
  assert.deepEqual(x.storage.filter((s) => s.table === 'daily_records').map((s) => [s.key, s.column, s.result]), [
    [REVIEW, 'sleep_at', 'written'], [REVIEW, 'sleep_satisfaction', 'kept_existing'], [REVIEW, 'condition_note', 'written'],
  ]);
  assert.deepEqual([db.rows('daily_journals').map((j) => j.record_date), db.rows('alarm_events').length], [[REVIEW], 1]); // 일기는 그날 한 줄, 알람 반응은 안 씀
});

test('일정 정보가 없는 일상 대화 → 아무 표에도 안 씀, JSON은 빈 칸으로 저장', async () => {
  const db = seed();
  const { deps, sid } = await chat(db, [['오늘 그냥 평범했어']], [emptyExtract()]);
  const r = await commit(deps, sid);
  assert.deepEqual([r.status, r.saved, r.pending, r.failed], ['DONE', { todos: 0, daily_records: 0, daily_journals: 0 }, [], []]);
  assert.deepEqual([db.rows('todos').length, db.rows('daily_records').length, db.rows('daily_journals').length], [0, 0, 0]); // 쓸 사실이 없으면 일기도 안 만듦
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

test('자정을 넘긴 대화(10/30 00:40, 새벽 4시 전) → 기준일 10/29: T2 날짜표의 오늘 = 10/29 + 새벽 줄, reference_date 10/29, "오늘 수업" 지각은 10/29 수업에 연결', async () => {
  const db = seed();
  const AFTER = new Date('2026-10-30T00:40:00+09:00');
  db.now = AFTER;
  const out = emptyExtract({ behavior: [beh('LATE', { date: REVIEW, minutes: 5, appointment_title: '수업' })] });
  const fake = fakeClaude({ T2F: [T2F_NONE], T1: [T1_OK], T2: [out], T5: [DIARY] });
  let t = 0;
  const deps: CommitDeps = { userId: ME, userDb: db as unknown as Db, service: db as unknown as Db, llm: fake.client, model: 'm', now: () => AFTER, clock: () => (t += 40), sleep: async () => {} };
  const s = (await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut;
  await handleVoiceTurn(deps, { session_id: s.session_id as string, rev: s.rev, client_turn_id: cid(), text: '오늘 수업에 5분 늦었어' });
  await commit(deps, s.session_id as string);
  assert.match(fake.seen.T2[0], /하루는 새벽 4시에 바뀌어 이 대화의 '오늘'은 2026-10-29\(목\)/);
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

// ───────── 지난 일 · 목표 vs 준비시간 변경 요청 · [저장 안 함]이 서버에 못 간 카드 (11/8 음성 실사용) ─────────

const VOICE_TALK = '오늘 아침에 알람을 두 번 미뤘어. 준비하는데 평소보다 15분 더 걸렸고 내일부턴 조금 더 일찍 일어나고 싶어.';
const prepFast = (minutes: number | null) => ({ ...T2F_NONE, prep_adjustment: { direction: 'MORE' as const, minutes } });

/** 내일(10/30) 9시 1교시 + 기상 알람 7:30 — 준비시간 카드가 붙을 내일 첫 일정 */
function seedTomorrow(): FakeDb {
  const db = seed();
  db.rows('appointments').push({ appointment_id: 'ap-tmr', creator_id: ME, title: '1교시', appointment_at: '2026-10-30T09:00:00+09:00', dest_name: '공학관', importance: 'NORMAL', recurrence_rule: null });
  db.rows('appointment_participants').push({ participant_id: 'pt-tmr', appointment_id: 'ap-tmr', user_id: ME, transport_type: 'WALK', est_travel_minutes: 15, departed_at: null, departed_source: null, arrived_at: null, arrived_source: null, is_late: null, late_minutes: null });
  db.rows('alarms').push({ alarm_id: 'al-tmr', user_id: ME, participant_id: 'pt-tmr', routine_id: null, alarm_type: 'WAKE', scheduled_at: '2026-10-30T07:30:00+09:00', intensity: 'NORMAL', is_enabled: true, time_source: 'AUTO' });
  return db;
}

/** 말 하나 — T2F 출력을 정해서. 음성이면 spoken */
async function say1(db: FakeDb, said: string, t2f: unknown, spoken?: string, t2: FakeScript['T2'] = []) {
  const fake = fakeClaude({ T2F: [t2f], T1: [T1_OK], T2: t2, T5: [DIARY] });
  let t = 0;
  const deps: CommitDeps = { userId: ME, userDb: db as unknown as Db, service: db as unknown as Db, llm: fake.client, model: 'gemini-3.5-flash-lite', now: () => NOW, clock: () => (t += 40), sleep: async () => {} };
  const s = (await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut;
  const sid = s.session_id as string;
  const r = (await handleVoiceTurn(deps, { session_id: sid, rev: s.rev, client_turn_id: cid(), text: said, ...(spoken !== undefined ? { spoken_reply: spoken } : {}) })) as VoiceTurnOut;
  return { deps, sid, r };
}

const voiceExtract = (prep: FinalExtract['prep_adjustment']) => emptyExtract({
  behavior: [beh('SNOOZE', { minutes: 2 }), beh('PREP_OVER', { minutes: 15 })],
  prep_adjustment: prep,
  habit_signals: [{ habit: 'snooze_repeat', note: '알람을 두 번 미룸', recurring: false, date: REVIEW, source: 'stated' }, { habit: 'slow_prep', note: '15분 더 걸림', recurring: false, date: REVIEW, source: 'stated' }],
  goals_routine: { goals: [{ habit: 'irregular_wake', goal_text: '조금 더 일찍 일어나고 싶어', source: 'stated' }], wanted_routine: null },
});

test('음성: 지난 일 + 목표만 말하면 T2F가 준비시간 MORE를 내도 카드 없음 · 끝 JSON에 준비시간 · 알람 변경 없음, 목표 문장은 남고 습관은 other', async () => {
  const db = seedTomorrow();
  const { deps, sid, r } = await say1(db, VOICE_TALK, prepFast(null), '그랬구나. 내일은 조금 더 일찍 일어나 봐요.', [voiceExtract({ direction: 'MORE', minutes: null })]);
  assert.deepEqual(r.cards, []); // '+10분' 카드가 생기지 않음
  assert.equal(r.next, 'USER');
  assert.deepEqual(rowOf(db, sid).server_state.cards, []);

  const out = await commit(deps, sid);
  assert.equal(out.status, 'DONE');
  assert.deepEqual(out.pending, []);
  const x = rowOf(db, sid).extracted_data as Structured;
  assert.deepEqual(structuredProblems(x), []);
  assert.deepEqual(x.session.input_modes, ['voice']);
  assert.equal(x.prep_adjustment, null);
  assert.deepEqual(x.alarm_changes, []);
  assert.deepEqual(x.behavior.map((b) => [b.kind, b.minutes, b.status]), [['snooze', 2, 'recorded'], ['prep_over', 15, 'recorded']]);
  assert.deepEqual(x.goals_routine.goals, [{ habit: 'other', goal_text: '조금 더 일찍 일어나고 싶어', source: 'stated' }]);
});

test('명시 요청 "내일 준비시간을 15분 늘려줘"는 기존대로 준비시간 카드(+15) · 끝 JSON은 서버 카드 상태(READY → needs_confirm)', async () => {
  const db = seedTomorrow();
  const { deps, sid, r } = await say1(db, '내일 준비시간을 15분 늘려줘', prepFast(15), undefined, [voiceExtract({ direction: 'MORE', minutes: 15 })]);
  assert.deepEqual(r.cards.map((c) => [c.id, c.kind, c.edit?.prepare_delta]), [['c1', 'ALARM_EDIT', 15]]);
  rowOf(db, sid).server_state.cards[0].status = 'READY'; // 앱 계산(results) 뒤

  await commit(deps, sid);
  const x = rowOf(db, sid).extracted_data as Structured;
  assert.deepEqual(x.prep_adjustment, { direction: 'MORE', minutes: 15, status: 'needs_confirm' });
  assert.equal(rowOf(db, sid).server_state.cards[0].status, 'READY');
});

test('[저장 안 함]을 서버에 못 알렸어도 [완료]의 rejected_cards로 서버가 카드를 REJECTED로 바꾸고 JSON은 declined (저장 · 모르는 카드는 그대로)', async () => {
  const db = seedTomorrow();
  const { deps, sid } = await say1(db, '내일 준비시간을 15분 늘려줘', prepFast(15), undefined, [voiceExtract({ direction: 'MORE', minutes: 15 })]);
  const st = rowOf(db, sid).server_state;
  st.cards[0].status = 'READY';
  st.cards.push({ ...st.cards[0], id: 'c2', kind: 'APPT_NEW', status: 'SAVED' } as Card);

  const out = (await handleVoiceCommit(deps, { session_id: sid, rejected_cards: ['c1', 'c2', 'c9'] })) as VoiceCommitOut;
  assert.equal(out.status, 'DONE');
  assert.deepEqual(out.pending, []);
  const row = rowOf(db, sid);
  assert.deepEqual(row.server_state.cards.map((c) => [c.id, c.status]), [['c1', 'REJECTED'], ['c2', 'SAVED']]);
  assert.equal(row.server_state.core.pending['c1'], undefined);
  assert.deepEqual((row.extracted_data as Structured).prep_adjustment, { direction: 'MORE', minutes: 15, status: 'declined' });
  // 끝난 뒤 늦게 온 같은 요청은 저장한 결과 그대로 (다시 바꾸지 않음)
  assert.deepEqual(await handleVoiceCommit(deps, { session_id: sid, rejected_cards: ['c1'] }), out);
});

test('rejected_cards 모양 검사: 카드 번호 배열이 아니면 VALIDATION_FAILED (상태 안 바꿈)', async () => {
  const db = seedTomorrow();
  const { deps, sid } = await say1(db, '내일 준비시간을 15분 늘려줘', prepFast(15));
  const rev = rowOf(db, sid).server_state.rev;
  for (const bad of ['c1', [1], ['DROP TABLE'], Array(51).fill('c1')]) {
    const e = await failure(handleVoiceCommit(deps, { session_id: sid, rejected_cards: bad }));
    assert.equal(e.code, 'VALIDATION_FAILED');
  }
  assert.equal(rowOf(db, sid).server_state.rev, rev);
});

// ───────── 하루 일기 (daily_journals.ai_summary, T5.v2 — 모델은 가짜) ─────────

// 기획 예시: "8시 10분에 일어났어. 알람을 세 번이나 미뤄서 수업에 12분 늦었어. 오후에는 팀플 발표를 끝냈고 교수님께 칭찬도 받았어. 조금 피곤하지만 기분은 좋아"
const DAY_TALK = '오늘 아침 8시 10분에 일어났어. 알람을 세 번이나 미뤄서 수업에 12분 늦었어. 그래도 오후에는 팀플 발표를 끝냈고 교수님께 칭찬도 받았어. 조금 피곤하지만 기분은 좋아';
const dayExtract = (over: Partial<FinalExtract> = {}) => emptyExtract({
  behavior: [
    beh('WAKE', { time: '08:10' }),
    beh('SNOOZE'),
    beh('LATE', { minutes: 12, appointment_title: '캡스톤 수업' }),
    beh('WAKE', { date: '2026-10-28', time: '06:00' }), // 다른 날 — 일기에 안 들어감
    beh('PREP_OVER', { minutes: 30, source: 'inferred' }), // 짐작 — 일기에 안 들어감
  ],
  day_review: {
    events: [
      { text: '팀플 발표를 끝냄', time: null, important: true, source: 'stated' },
      { text: '교수님께 칭찬받음', time: null, important: true, source: 'stated' },
      { text: '친구와 다툼', time: null, important: false, source: 'inferred' }, // 짐작 — 일기에 안 들어감
    ],
    memorable: '교수님께 칭찬받음',
  },
  mood_condition: { mood: ['good', 'tired'], valence: 1, fatigue: null, stress: null, causes: [], source: 'stated' },
  ...over,
});
const journalOf = (db: FakeDb, date = REVIEW) => db.rows('daily_journals').filter((j) => j.record_date === date);

test('일기: 구조화 JSON(그날 · 말한 것만) → T5 → daily_journals.ai_summary 한 줄 (날짜 · 근거 대화)', async () => {
  const db = seed();
  const { fake, deps, sid } = await chat(db, [[DAY_TALK]], [dayExtract()]);
  const r = await commit(deps, sid);
  assert.deepEqual([r.status, r.saved.daily_journals, r.failed], ['DONE', 1, []]);
  assert.deepEqual(fake.order.filter((p) => p === 'T2' || p === 'T5'), ['T2', 'T5']); // 구조화 저장 뒤 일기
  const screen = fake.seen.T5[0];
  assert.match(screen, new RegExp(REVIEW));
  for (const s of ['팀플 발표를 끝냄', '교수님께 칭찬받음', '"good"', '08:10', 'snooze', '캡스톤 수업']) assert.ok(screen.includes(s), `들어가야 함: ${s}`);
  for (const s of ['친구와 다툼', '2026-10-28', '06:00', 'prep_over', DAY_TALK]) assert.ok(!screen.includes(s), `빠져야 함: ${s}`); // 짐작 · 다른 날 · 대화 원문은 안 보냄
  const [j] = journalOf(db);
  assert.deepEqual([journalOf(db).length, j.user_id, j.ai_summary, j.source_session_id, j.edited_summary ?? null, j.is_edited ?? false], [1, ME, DIARY.diary, sid, null, false]);
  assert.equal(db.rows('ai_calls').filter((c) => c.point === 'T5' && c.prompt_version === 'v3').length, 1);
  // 그 JSON으로 다른 날 일기를 만들면 쓸 사실이 없음
  assert.equal(journalFacts([rowOf(db, sid).extracted_data as Structured], TOMORROW), null);
});

test('일기: 같은 대화를 다시 보내면(DONE · PARTIAL 다시 시도) 모델을 다시 부르지 않고 한 줄 그대로', async () => {
  const db = seed();
  const { fake, deps, sid } = await chat(db, [[DAY_TALK]], [dayExtract({ todos: [todo('우산', { due_date: TOMORROW })] })]);
  db.failOn.push({ table: 'todos', op: 'insert' }); // 일기는 써지고 할 일만 실패 → PARTIAL
  assert.equal((await commit(deps, sid)).status, 'PARTIAL');
  db.failOn = [];
  assert.equal((await commit(deps, sid)).status, 'DONE');
  await commit(deps, sid);
  assert.equal(fake.order.filter((p) => p === 'T5').length, 1);
  assert.equal(journalOf(db).length, 1);
});

test('일기: 사용자가 고친 일기는 덮지 않음 (모델도 안 부름)', async () => {
  const db = seed();
  db.rows('daily_journals').push({ journal_id: 'j-old', user_id: ME, record_date: REVIEW, source_session_id: null, ai_summary: '예전 AI 일기', edited_summary: '내가 고친 일기', is_edited: true });
  const { fake, deps, sid } = await chat(db, [[DAY_TALK]], [dayExtract()]);
  const r = await commit(deps, sid);
  assert.deepEqual([r.status, r.saved.daily_journals], ['DONE', 0]);
  assert.equal(fake.order.includes('T5'), false);
  assert.deepEqual(journalOf(db).map((j) => [j.ai_summary, j.edited_summary, j.is_edited, j.source_session_id]), [['예전 AI 일기', '내가 고친 일기', true, null]]);
});

test('일기: [완료] 뒤 자정 넘어 같은 기준일에 다시 열면 같은 방 — 이어 말하고 다시 [완료]하면 대화 전체로 다시 써서 그날 한 줄을 갱신', async () => {
  const db = seed();
  const ev = (text: string, important: boolean) => ({ text, time: null, important, source: 'stated' as const });
  const first = await chat(db, [['오늘 팀플 발표 끝냈어']], [emptyExtract({ day_review: { events: [ev('팀플 발표를 끝냄', true)], memorable: null } })]);
  await commit(first.deps, first.sid);
  db.now = AFTER_MIDNIGHT; // 10/30 00:40 — 새벽 4시 전이라 기준일 10/29, 같은 방
  const second = await chat(db, [['저녁엔 친구랑 떡볶이 먹었어']], [emptyExtract({ day_review: { events: [ev('팀플 발표를 끝냄', true), ev('친구와 떡볶이를 먹음', false)], memorable: null } })], [{ diary: '팀플 발표를 끝내고 저녁에는 친구와 떡볶이를 먹었다.' }], AFTER_MIDNIGHT);
  assert.equal(second.sid, first.sid);
  assert.equal(second.session.resumed, true);
  await commit(second.deps, second.sid);
  const screen = second.fake.seen.T5[0];
  assert.ok(screen.includes('팀플 발표를 끝냄') && screen.includes('친구와 떡볶이를 먹음'));
  assert.deepEqual(journalOf(db).map((j) => [j.record_date, j.ai_summary, j.source_session_id]), [[REVIEW, '팀플 발표를 끝내고 저녁에는 친구와 떡볶이를 먹었다.', first.sid]]);
});

// ── 일정 · 준비물도 일기 입력 · 빈 일기 대체 (실제 사례: "피곤했어 · 내일 10시 캡스톤 회의 · 노트북" → T5 "" → DONE인데 일기 없음)
const plan = (title: string, over: Partial<FinalExtract['appointments'][number]> = {}): FinalExtract['appointments'][number] =>
  ({ ref: null, title, date: TOMORROW, time: '10:00', place: null, importance: null, transport: null, repeat: null, save: 'UNCONFIRMED', unclear: null, ...over });
const TIRED: FinalExtract['mood_condition'] = { mood: ['tired'], valence: -1, fatigue: null, stress: null, causes: [], source: 'stated' };
const facts5 = (fake: { seen: Record<string, string[]> }) => fake.seen.T5?.[0] ?? '';

/** 카드 [저장]으로 저장한 일정 (D31 — 일기엔 저장한 일정만) */
const savedCards = (db: FakeDb, sid: string, ...titles: [string, string | null][]) =>
  putCards(db, sid, titles.map(([title, date], i) => ({
    status: 'SAVED' as const, appointment_id: `ap-${i + 1}`, draft: { title, date: date ?? TOMORROW, time: '10:00', place: null, importance: null, transport: null, repeat: [], items: [], alarms: { WAKE: true, PREPARE: true, DEPARTURE: true } },
  })));

test('일기: 모델이 빈 글을 줘도 쓸 사실이 있으면 사실 값만으로 대체 문장 저장 (실제 사례 — 감정 · 저장한 일정 · 준비물)', async () => {
  const db = seed();
  const x = emptyExtract({ mood_condition: TIRED, appointments: [plan('캡스톤 회의')], todos: [todo('노트북', { due_date: TOMORROW, appointment_title: '캡스톤 회의' })] });
  const { deps, sid } = await chat(db, [['오늘 하루 너무 피곤했어'], ['내일 오전 10시에 캡스톤 회의가 있어'], ['내일 나가기 전에 노트북 챙겨야 돼']], [x], [{ diary: '  ' }]);
  savedCards(db, sid, ['캡스톤 회의', TOMORROW]);
  const r = await commit(deps, sid);
  assert.deepEqual([r.status, r.saved.daily_journals, r.failed], ['DONE', 1, []]);
  assert.deepEqual(journalOf(db).map((j) => j.ai_summary), ['오늘은 피곤한 하루였다. 내일 오전 10시에 캡스톤 회의가 예정되어 있다. 노트북을 챙기기로 했다.']);
});

test('일기: 감정만 말해도 일기 (빈 글이면 "오늘은 피곤한 하루였다.")', async () => {
  const db = seed();
  const { fake, deps, sid } = await chat(db, [['피곤했어']], [emptyExtract({ mood_condition: TIRED })], [{ diary: '' }]);
  assert.equal((await commit(deps, sid)).saved.daily_journals, 1);
  assert.match(facts5(fake), /"tired"/);
  assert.deepEqual(journalOf(db).map((j) => j.ai_summary), ['오늘은 피곤한 하루였다.']);
});

test('일기: 저장한 일정만 있어도 일기 — T5 입력에 내일 · 말씨 시각, 오늘 사건 · 감정은 비어 있음', async () => {
  const db = seed();
  const { fake, deps, sid } = await chat(db, [['내일 오전 10시에 캡스톤 회의가 있어']], [emptyExtract({ appointments: [plan('캡스톤 회의')] })], [{ diary: '내일 오전 10시에 캡스톤 회의가 예정되어 있어 일정을 정리했다.' }]);
  savedCards(db, sid, ['캡스톤 회의', TOMORROW]);
  const r = await commit(deps, sid);
  assert.deepEqual([r.status, r.saved.daily_journals], ['DONE', 1]);
  const f = journalFacts([rowOf(db, sid).extracted_data as Structured], REVIEW);
  assert.deepEqual([f?.plans, f?.events, f?.mood], [[{ title: '캡스톤 회의', day: '내일', time: '오전 10시' }], [], []]);
  assert.match(facts5(fake), /"day": "내일"[\s\S]*"time": "오전 10시"/);
  assert.ok(!facts5(fake).includes(TOMORROW), '날짜 계산은 서버가 — 모델엔 내일로');
  assert.deepEqual(journalOf(db).map((j) => j.ai_summary), ['내일 오전 10시에 캡스톤 회의가 예정되어 있어 일정을 정리했다.']);
});

test('일기(D31): 확인 대기 · 거절한 일정은 넣지 않음 — 그것뿐이면 T5를 안 부르고 일기도 없음', async () => {
  const db = seed();
  const x = emptyExtract({ appointments: [plan('캡스톤 회의'), plan('알바', { save: 'DECLINED' }), plan('동아리')] });
  const { fake, deps, sid } = await chat(db, [['내일 10시 캡스톤 회의, 동아리도 있고 알바는 빼 줘']], [x]);
  putCards(db, sid, [{ status: 'READY', draft: { title: '캡스톤 회의', date: TOMORROW, time: '10:00', place: null, importance: null, transport: null, repeat: [], items: [], alarms: { WAKE: true, PREPARE: true, DEPARTURE: true } } }]);
  const r = await commit(deps, sid);
  const s = rowOf(db, sid).extracted_data as Structured;
  assert.deepEqual(s.appointments.map((a) => [a.title, a.status]), [['캡스톤 회의', 'needs_confirm'], ['알바', 'declined'], ['동아리', 'needs_confirm']]);
  assert.deepEqual([r.status, r.saved.daily_journals, journalOf(db).length, fake.order.includes('T5')], ['DONE', 0, 0, false]);
  assert.equal(journalFacts([s], REVIEW), null);
  // 감정이 같이 있으면 감정만으로 쓰고 확인 대기 일정은 빠짐
  const f = journalFacts([{ ...s, mood_condition: { ...s.mood_condition, mood: ['tired'] } }], REVIEW) as NonNullable<ReturnType<typeof journalFacts>>;
  assert.deepEqual([f.plans, fallbackDiary(f)], [[], '오늘은 피곤한 하루였다.']);
});

test('일기(D31): 할 일 · 준비물은 넣었거나(inserted) 이미 있던 것(duplicate)만 — 저장 실패는 뺌', async () => {
  const db = seed();
  const x = emptyExtract({ mood_condition: TIRED, todos: [todo('노트북', { due_date: TOMORROW }), todo('보고서 제출', { type: 'TASK', due_date: TOMORROW })] });
  const { fake, deps, sid } = await chat(db, [['피곤했어. 내일 노트북 챙기고 보고서 내야 해']], [x]);
  await commit(deps, sid);
  for (const w of ['"tired"', '"준비물"', '노트북', '"할 일"', '보고서 제출']) assert.ok(facts5(fake).includes(w), `들어가야 함: ${w}`);
  const s = rowOf(db, sid).extracted_data as Structured;
  assert.deepEqual(s.todos.map((t) => t.stored), ['inserted', 'inserted']);
  const f = journalFacts([s], REVIEW) as NonNullable<ReturnType<typeof journalFacts>>;
  assert.equal(fallbackDiary(f), '오늘은 피곤한 하루였다. 노트북을 챙기기로 했다. 보고서 제출을 하기로 했다.');
  type Stored = Structured['todos'][number]['stored'];
  const titles = (st: Stored[]) => journalFacts([{ ...s, todos: s.todos.map((t, i) => ({ ...t, stored: st[i] as Stored })) }], REVIEW)?.todos.map((t) => t.title);
  assert.deepEqual(titles(['duplicate', 'failed']), ['노트북']);
  assert.deepEqual(titles([null, 'failed']), []);
});

test('일기(D31): 여러 대화에 나온 같은 저장 일정 · 준비물은 한 번만', async () => {
  const db = seed();
  const x = emptyExtract({ appointments: [plan('캡스톤 회의')], todos: [todo('노트북', { due_date: TOMORROW })] });
  const { deps, sid } = await chat(db, [['내일 10시 캡스톤 회의, 노트북 챙겨야 해']], [x]);
  savedCards(db, sid, ['캡스톤 회의', TOMORROW]);
  await commit(deps, sid);
  const s = rowOf(db, sid).extracted_data as Structured;
  const again = { ...s, session: { ...s.session, session_id: 'other' }, appointments: s.appointments.map((a) => ({ ...a, title: '캡스톤  회의' })), todos: s.todos.map((t) => ({ ...t, stored: 'duplicate' as const })) };
  const f = journalFacts([s, again], REVIEW) as NonNullable<ReturnType<typeof journalFacts>>;
  assert.deepEqual([f.plans.length, f.todos.length], [1, 1]);
  assert.equal(fallbackDiary(f), '내일 오전 10시에 캡스톤 회의가 예정되어 있다. 노트북을 챙기기로 했다.');
});

test('일기: 날짜 · 시각 표현 — 저장했어도 시각이 애매하면 시각 없이, 날짜 모름은 날짜 없이, 짐작한 것은 뺌', async () => {
  const db = seed();
  const x = emptyExtract({
    appointments: [plan('동아리', { date: '2026-10-31', time: '07:00', unclear: '오전/오후' }), plan('스터디', { date: null, time: null })],
    todos: [todo('우산', { due_date: REVIEW })],
  });
  const { deps, sid } = await chat(db, [['모레 7시 동아리, 스터디도 있어. 오늘 우산 챙겨야 해']], [x]);
  savedCards(db, sid, ['동아리', '2026-10-31'], ['스터디', null]);
  await commit(deps, sid);
  const s = rowOf(db, sid).extracted_data as Structured;
  const f = journalFacts([s], REVIEW) as NonNullable<ReturnType<typeof journalFacts>>;
  assert.deepEqual(f.plans, [{ title: '동아리', day: '모레', time: null }, { title: '스터디', day: null, time: null }]);
  assert.deepEqual(f.todos, [{ title: '우산', kind: '준비물', day: '오늘', for_plan: null }]);
  assert.equal(fallbackDiary(f), '모레 동아리가 예정되어 있다. 스터디가 예정되어 있다. 우산을 챙기기로 했다.');
  // 짐작(inferred)한 것은 입력에 안 들어감
  const guessed = { ...s, appointments: s.appointments.map((a) => ({ ...a, source: 'inferred' as const })), todos: s.todos.map((t) => ({ ...t, source: 'inferred' as const })) };
  assert.equal(journalFacts([guessed], REVIEW), null);
});

test('일기: 쓸 사실이 하나도 없으면 T5를 안 부르고 일기도 없음 (DONE)', async () => {
  const db = seed();
  const { fake, deps, sid } = await chat(db, [['그냥 그래']], [emptyExtract()]);
  const r = await commit(deps, sid);
  assert.deepEqual([r.status, r.saved.daily_journals, journalOf(db).length, fake.order.includes('T5')], ['DONE', 0, 0, false]);
});

test('일기: 선택 질문에 답하지 않고 바로 끝내도("이제 잘게") 저장한 일정만으로 저장', async () => {
  const db = seed();
  const { deps, sid } = await chat(db, [['내일 오후 1시에 수업 있어'], ['이제 잘게']], [emptyExtract({ appointments: [plan('수업', { time: '13:00' })] })], [{ diary: '' }]);
  savedCards(db, sid, ['수업', TOMORROW]);
  const r = await commit(deps, sid);
  assert.deepEqual([r.status, r.saved.daily_journals], ['DONE', 1]);
  assert.deepEqual(journalOf(db).map((j) => j.ai_summary), ['내일 오후 1시에 수업이 예정되어 있다.']);
});

test('일기: T5 성공 뒤 DB 저장 실패 → PARTIAL, 다시 보내면 T2 없이 일기만 다시 만들어 한 줄', async () => {
  const db = seed();
  const { fake, deps, sid } = await chat(db, [['피곤했어']], [emptyExtract({ mood_condition: TIRED })], [DIARY, DIARY]);
  db.failOn.push({ table: 'daily_journals', op: 'insert' });
  const r1 = await commit(deps, sid);
  assert.deepEqual([r1.status, r1.failed, r1.saved.daily_journals, journalOf(db).length], ['PARTIAL', ['daily_journals'], 0, 0]);
  db.failOn = [];
  const r2 = await commit(deps, sid);
  assert.deepEqual([r2.status, r2.saved.daily_journals], ['DONE', 1]);
  assert.deepEqual([fake.order.filter((p) => p === 'T2').length, fake.order.filter((p) => p === 'T5').length, journalOf(db).map((j) => j.ai_summary)], [1, 2, [DIARY.diary]]);
  await commit(deps, sid); // 끝난 뒤 또 보내도 겹치지 않음
  assert.deepEqual([fake.order.filter((p) => p === 'T5').length, journalOf(db).length], [2, 1]);
});

test('일기: 모델 실패 → 이 단계만 PARTIAL (대화 · 구조화 JSON · 할 일은 저장된 그대로), 다시 보내면 T2 없이 일기만 만듦', async () => {
  const db = seed();
  const { fake, deps, sid } = await chat(db, [[DAY_TALK]], [dayExtract({ todos: [todo('우산', { due_date: TOMORROW })] })], [upstreamError(), upstreamError(), DIARY]);
  const r1 = await commit(deps, sid);
  assert.deepEqual([r1.status, r1.failed, r1.saved.todos, r1.saved.daily_journals], ['PARTIAL', ['daily_journals'], 1, 0]);
  const row = rowOf(db, sid);
  assert.deepEqual([row.apply_status, structuredProblems(row.extracted_data), row.server_state.ended, journalOf(db).length], ['APPLIED', [], false, 0]);
  assert.match(row.transcript ?? '', /팀플 발표/);
  assert.equal(db.rows('ai_calls').filter((c) => c.point === 'T5' && c.ok === false).length, 1);

  const r2 = await commit(deps, sid);
  assert.deepEqual([r2.status, r2.saved.daily_journals], ['DONE', 1]);
  assert.equal(fake.order.filter((p) => p === 'T2').length, 1);
  assert.deepEqual([db.rows('todos').length, journalOf(db).map((j) => j.ai_summary)], [1, [DIARY.diary]]);
});

test('일기: memorable은 같은 대화의 말한 사건과 같을 때만 입력에 (짐작한 사건 · 사건 목록에 없는 글은 뺌)', async () => {
  const db = seed();
  const { deps, sid } = await chat(db, [[DAY_TALK]], [dayExtract()]);
  await commit(deps, sid);
  const x = rowOf(db, sid).extracted_data as Structured;
  const memo = (memorable: string | null) => (journalFacts([{ ...x, day_review: { ...x.day_review, memorable } }], REVIEW) as { memorable: string[] }).memorable;
  assert.deepEqual(memo('교수님께 칭찬받음'), ['교수님께 칭찬받음']); // stated 사건
  assert.deepEqual(memo('교수님께  칭찬 받음'), ['교수님께  칭찬 받음']); // 띄어쓰기만 다름
  assert.deepEqual(memo('친구와 다툼'), []); // inferred 사건
  assert.deepEqual(memo('여행을 다녀옴'), []); // 사건 목록에 없음
  // 짐작한 사건이 memorable이어도 모델 입력에 안 들어감 (전체 흐름)
  const db2 = seed();
  const c2 = await chat(db2, [[DAY_TALK]], [dayExtract({ day_review: { events: [{ text: '팀플 발표를 끝냄', time: null, important: true, source: 'stated' }, { text: '친구와 다툼', time: null, important: false, source: 'inferred' }], memorable: '친구와 다툼' } })]);
  await commit(c2.deps, c2.sid);
  assert.equal(c2.fake.seen.T5[0].includes('친구와 다툼'), false);
});

test('일기: 모델을 부르는 사이 사용자가 일기를 고치면 UPDATE 0줄 → 덮지 않고 saved.daily_journals 0', async () => {
  const db = seed();
  const j: Record<string, unknown> = { journal_id: 'j-old', user_id: ME, record_date: REVIEW, source_session_id: null, ai_summary: '예전 AI 일기', edited_summary: null, is_edited: false };
  db.rows('daily_journals').push(j);
  const editWhileCalling = () => {
    Object.assign(j, { edited_summary: '내가 고친 일기', is_edited: true }); // 읽은 뒤 · 쓰기 전에 앱에서 고침
    return DIARY;
  };
  const { fake, deps, sid } = await chat(db, [[DAY_TALK]], [dayExtract()], [editWhileCalling]);
  const r = await commit(deps, sid);
  assert.deepEqual([r.status, r.saved.daily_journals, r.failed], ['DONE', 0, []]);
  assert.equal(fake.order.filter((p) => p === 'T5').length, 1);
  assert.deepEqual(journalOf(db).map((x) => [x.ai_summary, x.edited_summary, x.is_edited, x.source_session_id]), [['예전 AI 일기', '내가 고친 일기', true, null]]);
});

// ───────── 위험 판정(safety_flag) 대화는 일기 입력에서 통째로 뺌 ─────────

// 위험 판정 대화 — final-core가 사건 글은 비우지만 습관 · 목표 · 행동은 JSON에 남음. 표시 글자로 T5 입력에 새는지 봄
const unsafeExtract = () => dayExtract({
  safety_flag: true,
  behavior: [beh('WAKE', { time: '05:55' })],
  habit_signals: [{ habit: 'late_bedtime', note: '위험메모-습관', date: REVIEW, recurring: false, source: 'stated' }],
  goals_routine: { goals: [{ habit: 'other', goal_text: '위험메모-목표', source: 'stated' }], wanted_routine: '위험메모-루틴' },
});
const UNSAFE_MARKS = ['위험메모-습관', '위험메모-목표', '위험메모-루틴', '05:55'];

test('위험 판정: 그 대화 하나뿐이면 T5를 부르지 않고 일기도 없음 (대화 · JSON 저장은 그대로)', async () => {
  const db = seed();
  const { fake, deps, sid } = await chat(db, [['위험한 말 예시']], [unsafeExtract()]);
  const r = await commit(deps, sid);
  assert.deepEqual([r.status, r.saved.daily_journals, r.failed], ['DONE', 0, []]);
  assert.equal(fake.order.includes('T5'), false);
  assert.equal(journalOf(db).length, 0);
  const x = rowOf(db, sid).extracted_data as Structured;
  assert.deepEqual([x.other.safety_flag, x.habit_signals.length, x.goals_routine.goals.length, structuredProblems(x)], [true, 1, 1, []]); // JSON은 안 바꿈
  // 메모가 어디에 있든(행동 메모 포함) 그 세션은 일기 입력이 안 됨
  assert.equal(journalFacts([{ ...x, behavior: x.behavior.map((b) => ({ ...b, note: '위험메모-행동' })) }], REVIEW), null);
});

test('위험 판정: 앞 정상 대화의 AI 일기 · 고친 일기는 위험 판정 대화 뒤에도 그대로 (T5 안 부름)', async () => {
  const db = seed();
  const first = await chat(db, [[DAY_TALK]], [dayExtract()]);
  await commit(first.deps, first.sid);
  const before = structuredClone(journalOf(db));
  const second = await chat(db, [['위험한 말 예시']], [unsafeExtract()]);
  assert.equal((await commit(second.deps, second.sid)).saved.daily_journals, 0);
  assert.equal(second.fake.order.includes('T5'), false);
  assert.deepEqual(journalOf(db), before);

  const db2 = seed();
  db2.rows('daily_journals').push({ journal_id: 'j-old', user_id: ME, record_date: REVIEW, source_session_id: null, ai_summary: '예전 AI 일기', edited_summary: '내가 고친 일기', is_edited: true });
  const c = await chat(db2, [['위험한 말 예시']], [unsafeExtract()]);
  await commit(c.deps, c.sid);
  assert.deepEqual(journalOf(db2).map((j) => [j.ai_summary, j.edited_summary, j.is_edited, j.source_session_id]), [['예전 AI 일기', '내가 고친 일기', true, null]]);
});

test('위험 판정: 뒤에 정상 대화가 오면 정상 대화 내용만 T5에 (위험 대화의 습관 · 목표 · 행동은 안 들어감)', async () => {
  const db = seed();
  const unsafe = await chat(db, [['위험한 말 예시']], [unsafeExtract()]);
  await commit(unsafe.deps, unsafe.sid);
  const ok = await chat(db, [[DAY_TALK]], [dayExtract()]);
  const r = await commit(ok.deps, ok.sid);
  assert.deepEqual([r.status, r.saved.daily_journals], ['DONE', 1]);
  const screen = ok.fake.seen.T5[0];
  assert.ok(screen.includes('팀플 발표를 끝냄') && screen.includes('08:10'));
  for (const s of UNSAFE_MARKS) assert.ok(!screen.includes(s), `빠져야 함: ${s}`);
  assert.deepEqual(journalOf(db).map((j) => [j.ai_summary, j.source_session_id]), [[DIARY.diary, ok.sid]]);
});

// ───────── 하루 한 대화방 — [완료]해도 같은 날은 같은 세션, 다음 [완료]가 새 말까지 다시 정리 ─────────

const LATER = new Date('2026-10-29T23:10:00+09:00');
const umbrella = (over: Partial<FinalExtract> = {}) => dayExtract({ todos: [todo('우산', { due_date: TOMORROW })], daily_record: { sleep_time: null, sleep_satisfaction: 4, condition_note: null }, ...over });

test('같은 날: 완료 → 다시 열면 같은 세션(말 · 카드 복원) → 글 · 음성(Live)으로 이어 말함 → 두 번째 완료가 새 말까지 다시 추출 · 할 일 · 기록 겹침 없음 · 일기 갱신', async () => {
  const db = seed();
  const first = await chat(db, [[DAY_TALK]], [umbrella()]);
  putCards(db, first.sid, [{ status: 'SAVED', appointment_id: 'ap-team' }]); // 카드 [저장]으로 만든 일정
  const r1 = await commit(first.deps, first.sid);
  assert.deepEqual([r1.status, r1.saved], ['DONE', { todos: 1, daily_records: 1, daily_journals: 1 }]);

  // 재진입 (같은 날 23:10) — 새 세션을 만들지 않고 이어 받음
  const evening = umbrella({ day_review: { events: [{ text: '팀플 발표를 끝냄', time: null, important: true, source: 'stated' }, { text: '친구와 떡볶이를 먹음', time: null, important: false, source: 'stated' }], memorable: null } });
  const second = await chat(db, [['저녁엔 친구랑 떡볶이 먹었어'], ['내일 우산 챙기는 거 잊지 말자', '네, 우산 꼭 챙기세요.']], [evening], [{ diary: '발표를 끝내고 친구와 떡볶이를 먹었다.' }], LATER);
  assert.equal(second.sid, first.sid);
  assert.equal(second.session.resumed, true);
  assert.ok(second.session.messages.some((m) => m.text === DAY_TALK)); // 앞 대화 복원
  assert.deepEqual(second.session.cards.map((c) => [c.id, c.status]), [['c1', 'SAVED']]); // 일정 카드 복원 (다시 저장 안 함)
  assert.equal(db.rows('conversation_sessions').length, 1);
  const st = rowOf(db, first.sid).server_state;
  assert.equal(st.counts.user_turns, 3);
  assert.ok(rowOf(db, first.sid).ended_at === null && !st.ended);
  assert.equal((db.rows('conversation_sessions')[0] as { turns: { source?: string }[] }).turns.some((t) => t.source === 'live'), true); // 음성 차례도 같은 세션에

  const r2 = await commit(second.deps, second.sid);
  assert.deepEqual([r2.status, r2.saved], ['DONE', { todos: 0, daily_records: 1, daily_journals: 1 }]); // 할 일은 같은 대화가 만든 것이라 건너뜀
  assert.equal(second.fake.order.filter((p) => p === 'T2').length, 1);
  for (const s of [DAY_TALK, '떡볶이', '우산 꼭 챙기세요']) assert.ok(second.fake.seen.T2[0].includes(s), `T2가 대화 전체를 봐야 함: ${s}`);
  assert.deepEqual(db.rows('todos').map((t) => t.title), ['우산']);
  assert.equal(db.rows('daily_records').length, 1);
  assert.equal(db.rows('appointments').length, 2); // 일정은 카드 몫 — 정리가 새로 만들지 않음
  assert.deepEqual(journalOf(db).map((j) => [j.ai_summary, j.source_session_id]), [['발표를 끝내고 친구와 떡볶이를 먹었다.', first.sid]]);
  assert.equal(rowOf(db, first.sid).server_state.commit?.at_turn, 3);

  // 새 말 없이 또 [완료] — 모델 안 부르고 저장한 답 그대로
  assert.deepEqual(await commit(second.deps, second.sid), r2);
  assert.equal(second.fake.order.filter((p) => p === 'T2' || p === 'T5').length, 2);

  // 사용자가 일기를 고친 뒤 또 말하고 [완료] — 다시 추출은 하지만 고친 일기는 안 덮음
  Object.assign(journalOf(db)[0], { edited_summary: '내가 고친 일기', is_edited: true });
  const third = await chat(db, [['아 그리고 내일 9시 수업']], [evening], [], new Date('2026-10-29T23:40:00+09:00'));
  const r3 = await commit(third.deps, third.sid);
  assert.deepEqual([r3.status, r3.saved.daily_journals, third.fake.order.includes('T5')], ['DONE', 0, false]);
  assert.deepEqual(journalOf(db).map((j) => [j.edited_summary, j.is_edited]), [['내가 고친 일기', true]]);
});

test('정리(T2) 도중 새 말이 오면 STALE — 그 앞까지 저장, 새 말은 다음 [완료]가 다시 추출해 놓치지 않음', async () => {
  const db = seed();
  const { fake, deps, sid } = await chat(db, [['내일 우산 챙겨야 해']], []);
  const extractThenTalk = () => {
    // T2를 부르는 사이 voice-turn이 말을 저장함 (rev · 말 수가 오름)
    const row = db.rows('conversation_sessions').find((s) => s.session_id === sid) as { turns: unknown[]; server_state: ServerState };
    row.turns.push({ n: row.turns.length, role: 'user', text: '그리고 모레 도서관 가야 해', at: NOW.toISOString(), client_turn_id: 'late' });
    row.server_state = { ...row.server_state, rev: row.server_state.rev + 1, counts: { ...row.server_state.counts, user_turns: row.server_state.counts.user_turns + 1 } };
    return emptyExtract({ todos: [todo('우산')] });
  };
  const r1 = (await handleVoiceCommit({ ...deps, llm: fakeClaude({ T2: [extractThenTalk], T5: [DIARY] }).client }, { session_id: sid })) as VoiceCommitOut;
  assert.equal(r1.status, 'STALE');
  assert.equal(rowOf(db, sid).server_state.commit?.at_turn, 1);
  assert.equal(rowOf(db, sid).server_state.counts.user_turns, 2); // 정리가 새 말을 덮어쓰지 않음
  assert.deepEqual(db.rows('todos').map((t) => t.title), ['우산']);

  const again = fakeClaude({ T2: [(screen: string) => (assert.ok(screen.includes('모레 도서관')), emptyExtract({ todos: [todo('우산'), todo('도서관 책', { due_date: '2026-10-31' })] }))], T5: [DIARY] });
  const r2 = (await handleVoiceCommit({ ...deps, llm: again.client }, { session_id: sid })) as VoiceCommitOut;
  assert.equal(r2.status, 'DONE');
  assert.deepEqual(db.rows('todos').map((t) => t.title), ['우산', '도서관 책']);
  assert.equal(fake.order.includes('T2'), false);
});

test('대화방 = 새벽 4시 기준일: 23:59 → 00:40은 [완료] 뒤에도 같은 방, 03:59까지 같은 방, 04:00에 새 방 · 예전 방식으로 끝낸 세션은 이어 받지 않음', async () => {
  const db = seed();
  const night = await chat(db, [['오늘 피곤했어']], [emptyExtract()], undefined, new Date('2026-10-29T23:59:00+09:00'));
  await commit(night.deps, night.sid);

  db.now = AFTER_MIDNIGHT; // 10/30 00:40 — 달력은 바뀌었지만 기준일은 10/29
  const late = await chat(db, [], [], [], AFTER_MIDNIGHT);
  assert.equal(late.sid, night.sid);
  assert.equal(late.session.resumed, true);
  assert.equal(late.session.day.review, REVIEW);
  assert.deepEqual(late.session.messages.filter((m) => m.role === 'user').map((m) => m.text), ['오늘 피곤했어']);
  const at359 = await chat(db, [], [], [], new Date('2026-10-30T03:59:00+09:00'));
  assert.equal(at359.sid, night.sid);

  const at4 = await chat(db, [], [], [], new Date('2026-10-30T04:00:00+09:00'));
  assert.notEqual(at4.sid, night.sid);
  assert.equal(at4.session.resumed, false);
  assert.equal(at4.session.day.review, TOMORROW);
  assert.deepEqual(at4.session.messages.map((m) => m.role), ['ai']); // 새 첫 마디만
  assert.equal(rowOf(db, at4.sid).server_state.prev_session_id, null);

  // 예전 방식([완료]가 ended로 끝낸 세션)은 같은 기준일이어도 새 세션
  (db.rows('conversation_sessions').find((s) => s.session_id === at4.sid) as { server_state: ServerState }).server_state.ended = true;
  const fresh = await chat(db, [], [], [], new Date('2026-10-30T04:10:00+09:00'));
  assert.notEqual(fresh.sid, at4.sid);
});

test('기상 확인 · 기상 알람은 대화방을 바꾸지 않음: 01:00 방에서 기상 기록 · 알람이 생겨도 03:00에 같은 방, 09:00에는 기상과 상관없이 새 방', async () => {
  const db = seed();
  const night = await chat(db, [['오늘 팀플 발표 끝냈어']], [], [], AT_1AM);
  db.rows('daily_records').push({ record_id: 'r-wake', user_id: ME, record_date: TOMORROW, wake_confirmed_at: '2026-10-30T02:30:00+09:00', data_source: 'APP' });
  db.rows('alarms').push({ alarm_id: 'al-w', user_id: ME, participant_id: null, routine_id: null, alarm_type: 'WAKE', scheduled_at: '2026-10-29T21:00:00Z', intensity: 'NORMAL', is_enabled: true });
  const same = await chat(db, [], [], [], new Date('2026-10-30T03:00:00+09:00'));
  assert.equal(same.sid, night.sid);
  assert.equal(same.session.day.review, REVIEW);
  db.rows('daily_records').length = 0; // 기상 기록이 없어도
  const day = await chat(db, [], [], [], AT_9AM);
  assert.notEqual(day.sid, night.sid);
  assert.equal(day.session.day.review, TOMORROW);
  assert.equal(rowOf(db, day.sid).server_state.prev_session_id, null);
  assert.deepEqual(day.session.uncommitted_session_ids, [night.sid]); // 전 기준일 방은 정리 목록으로
});

// ───────── 예전 규칙으로 만든 방(배포 전: 기상 전 = 전날 기준일)을 04:00 뒤에 엶 — 같은 방의 다음 구간, 기록은 구간마다 제 기준일 ─────────
//   지금 규칙에서는 방 = 기준일이라 생기지 않지만, 배포 전 아침(기상 전)에 연 방은 이 길로 이어짐 — 앞 구간 started_at을 04:00 뒤로 옮겨 흉내

const AT_1AM = new Date('2026-10-30T01:00:00+09:00'); // 기상 전 → 기준일 10/29
const AT_9AM = new Date('2026-10-30T09:00:00+09:00'); // 08:30 기상 확인 뒤 → 기준일 10/30
/** 예전 규칙 방 흉내 — 기준일 10/29인 방을 10/30 08:00에 연 것으로 */
const legacy = (db: FakeDb, sid: string) => {
  (db.rows('conversation_sessions').find((x) => x.session_id === sid) as { started_at: string }).started_at = '2026-10-30T08:00:00+09:00';
};
const eventsOf = (text: string) => emptyExtract({ day_review: { events: [{ text, time: null, important: true, source: 'stated' }], memorable: null } });

test('예전 규칙 방(기준일 10/29) → 오전 9시 재접속: 같은 대화방(말 · 카드 이어짐) · 기록은 기준일별 — 01시 말은 10/29, 09시 말은 10/30 일기로', async () => {
  const db = seed();
  db.now = AT_1AM;
  const night = await chat(db, [['오늘 팀플 발표 끝냈어'], ['내일 2시에 도서관에서 스터디 있어']], [], [], AT_1AM);
  assert.equal(night.session.day.review, REVIEW);
  putCards(db, night.sid, [
    { status: 'READY', summary: '스터디', draft: { title: '스터디', date: TOMORROW, time: '14:00', place: '도서관', importance: null, transport: null, repeat: [], items: [], alarms: { WAKE: true, PREPARE: true, DEPARTURE: true } } },
    { kind: 'ALARM_EDIT', status: 'READY', draft: null, edit: { appointment_id: 'a1', times: { WAKE: '2026-10-30T07:00:00+09:00' } } },
    { status: 'SAVED', appointment_id: 'ap-team', summary: '팀플' },
  ]);

  legacy(db, night.sid);
  db.now = AT_9AM;
  const fake = fakeClaude({ T2F: [T2F_NONE], T1: [T1_OK, T1_OK], T2: [eventsOf('팀플 발표를 끝냄'), eventsOf('아침에 일찍 일어남')], T5: [{ diary: '10/29 일기' }, { diary: '10/30 일기' }] });
  let t = 0;
  const deps: CommitDeps = { userId: ME, userDb: db as unknown as Db, service: db as unknown as Db, llm: fake.client, model: 'gemini-3.5-flash-lite', now: () => AT_9AM, clock: () => (t += 40), sleep: async () => {} };
  const s = (await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut;
  // 화면: 같은 방 — 01시 말이 그대로 보이고, 오늘 첫 마디가 뒤에 붙음
  assert.equal(s.resumed, true);
  assert.equal(s.day.review, TOMORROW);
  const texts = s.messages.map((m) => m.text);
  assert.ok(texts.includes('오늘 팀플 발표 끝냈어') && texts.indexOf('내일 2시에 도서관에서 스터디 있어') < texts.length - 1);
  assert.equal(s.messages.at(-1)?.role, 'ai');
  // 카드: 번호 · 상태 그대로, 어제 문맥 별칭을 쓰는 열린 알람 카드만 저장 불가, 약속 id는 그대로 풀림
  assert.deepEqual(s.cards.map((c) => [c.id, c.status]), [['c1', 'READY'], ['c2', 'FAILED'], ['c3', 'SAVED']]);
  assert.equal(s.cards[1].error, CARRIED_STALE_ERROR);
  assert.equal(s.cards[1].edit?.appointment_id, rowOf(db, night.sid).server_state.refs.appointments.a1.appointment_id); // 앞 구간 a1 → DB id (새 문맥의 a1과 안 섞임)
  // 서버: 기록은 새 기준일 세션(같은 방의 다음 구간)
  const sid = s.session_id as string;
  assert.notEqual(sid, night.sid);
  assert.equal(rowOf(db, sid).server_state.prev_session_id, night.sid);
  assert.deepEqual(s.prev_session_ids, [night.sid]); // 앱이 앞 구간의 '저장됨' 표시를 옮길 수 있게
  assert.equal(rowOf(db, sid).server_state.counts.user_turns, 0);

  // 이어 받은 열린 일정 카드를 9시에 저장 → 새 구간에서 처리, 새 카드 번호는 c4부터
  const saved = await handleVoiceTurn(deps, { session_id: sid, rev: s.rev, client_turn_id: cid(), card_action: { id: 'c1', action: 'SAVED', appointment_id: 'aaaaaaaa-0000-4000-8000-000000000001', alarms: [] } });
  assert.equal(saved.cards.find((c) => c.id === 'c1')?.status, 'SAVED');
  assert.equal(rowOf(db, sid).server_state.core.pendingSeq, 3);
  const said = await handleVoiceTurn(deps, { session_id: sid, rev: saved.rev, client_turn_id: cid(), text: '오늘은 아침에 일찍 일어났어' });
  assert.equal(said.reply?.text, T1_OK.reply);
  assert.ok(!fake.seen.T2F[0].includes('팀플 발표 끝냈어')); // 모델 화면에는 이 구간 말만 — 어제 날짜의 '오늘 · 내일'이 섞이지 않게

  // 같은 날 다시 열면 같은 구간 (새 세션 안 만듦), 화면 말은 두 구간 다
  const again = (await handleVoiceSession({ ...deps, now: () => new Date('2026-10-30T21:00:00+09:00') }, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut;
  assert.equal(again.session_id, sid);
  assert.ok(again.messages.some((m) => m.text === '오늘 팀플 발표 끝냈어') && again.messages.some((m) => m.text === '오늘은 아침에 일찍 일어났어'));
  const room = await roomTurns(deps, (await loadSession(deps, sid)));
  assert.deepEqual(room.filter((x) => x.role === 'user').map((x) => x.text), ['오늘 팀플 발표 끝냈어', '내일 2시에 도서관에서 스터디 있어', '오늘은 아침에 일찍 일어났어']); // Live 앞 대화도 이것

  // [완료] 한 번 → 앞 구간(10/29)을 먼저 그 기준일로, 이 구간(10/30)을 제 기준일로
  const r = await commit(deps, sid);
  assert.equal(r.status, 'DONE');
  assert.deepEqual(fake.order.filter((p) => p === 'T2' || p === 'T5'), ['T2', 'T5', 'T2', 'T5']);
  assert.ok(fake.seen.T2[0].includes('오늘 팀플 발표 끝냈어') && !fake.seen.T2[0].includes('일찍 일어났어'));
  assert.ok(fake.seen.T2[1].includes('일찍 일어났어') && !fake.seen.T2[1].includes('팀플 발표 끝냈어'));
  assert.equal(rowOf(db, night.sid).extracted_data.session.reference_date, REVIEW);
  assert.equal(rowOf(db, sid).extracted_data.session.reference_date, TOMORROW);
  assert.deepEqual(db.rows('daily_journals').map((j) => [j.record_date, j.ai_summary, j.source_session_id]).sort(), [[REVIEW, '10/29 일기', night.sid], [TOMORROW, '10/30 일기', sid]]);
  // 다시 [완료] — 새 말이 없으니 두 구간 모두 모델 안 부름
  assert.deepEqual(await commit(deps, sid), r);
  assert.equal(fake.order.filter((p) => p === 'T2').length, 2);

  // 다음 날 04:00 뒤는 이 방을 잇지 않고 새 방
  const nextDay = (await handleVoiceSession({ ...deps, now: () => new Date('2026-10-31T04:00:00+09:00') }, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut;
  assert.notEqual(nextDay.session_id, sid);
  assert.equal(rowOf(db, nextDay.session_id as string).server_state.prev_session_id, null);
});

test('앞 구간 정리가 실패하면 이 구간 결과는 저장하되 PARTIAL(previous_session) — 다시 보내면 앞 구간만 이어서 정리', async () => {
  const db = seed();
  db.now = AT_1AM;
  const night = await chat(db, [['오늘 팀플 발표 끝냈어']], [], [], AT_1AM);
  legacy(db, night.sid);
  db.now = AT_9AM;
  // T2 순서: 앞 구간(실패 · 다시 시도도 실패) → 이 구간 → (다시 보냄) 앞 구간
  const day = await chat(db, [['오늘은 아침에 일찍 일어났어']], [upstreamError(), upstreamError(), eventsOf('아침에 일찍 일어남'), eventsOf('팀플 발표를 끝냄')], [{ diary: '10/30 일기' }, { diary: '10/29 일기' }], AT_9AM);
  assert.equal(rowOf(db, day.sid).server_state.prev_session_id, night.sid);
  const r1 = await commit(day.deps, day.sid);
  assert.deepEqual([r1.status, r1.failed], ['PARTIAL', ['previous_session']]);
  assert.equal(rowOf(db, night.sid).server_state.commit?.status, 'FAILED');
  assert.equal(rowOf(db, day.sid).server_state.commit?.status, 'DONE');
  assert.equal(rowOf(db, night.sid).server_state.counts.user_turns, 1); // 앞 구간 말은 그대로
  const r2 = await commit(day.deps, day.sid);
  assert.equal(r2.status, 'DONE');
  assert.equal(day.fake.order.filter((p) => p === 'T2').length, 4); // 실패 2(다시 시도 포함) + 이 구간 1 + 앞 구간 1 — 이 구간은 다시 안 뽑음
  assert.deepEqual(db.rows('daily_journals').map((j) => j.record_date).sort(), [REVIEW, TOMORROW]);
});

test('0시 ~ 기상 전에 첫 마디만 있던 방은 이을 것이 없어 기상 뒤에는 그냥 새 세션 (앞 구간 연결 없음)', async () => {
  const db = seed();
  db.now = AT_1AM;
  const night = await chat(db, [], [], [], AT_1AM);
  legacy(db, night.sid);
  db.now = AT_9AM;
  const day = await chat(db, [], [], [], AT_9AM);
  assert.notEqual(day.sid, night.sid);
  assert.equal(day.session.resumed, false);
  assert.equal(rowOf(db, day.sid).server_state.prev_session_id, null);
  assert.equal(day.session.messages.length, 1);
});

// ───────── 긴 대화 (사용자 말 90 ~ 100) ─────────

const manyLines = (n: number, from = 1): [string][] => Array.from({ length: n }, (_, i) => [`말 ${from + i}: 오늘 있었던 일을 조금 길게 이야기해 보면 수업 끝나고 도서관에 갔다가 저녁을 먹었어`]);

test('긴 대화(사용자 말 95): 다시 열어도 말 · 카드 그대로, T1 · T2F 화면은 최근 줄만이라 크기가 묶이고 T2는 대화 전체', async () => {
  const db = seed();
  const { fake, deps, sid } = await chat(db, manyLines(95), [emptyExtract({ todos: [todo('우산', { due_date: TOMORROW })] })]);
  putCards(db, sid, [
    { status: 'SAVED', appointment_id: 'ap-team', summary: '팀플' },
    { status: 'READY', summary: '스터디', draft: { title: '스터디', date: TOMORROW, time: '14:00', place: '도서관', importance: null, transport: null, repeat: [], items: [], alarms: { WAKE: true, PREPARE: true, DEPARTURE: true } } },
  ]);
  const s = (await handleVoiceSession({ ...deps, now: () => LATER }, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut;
  assert.equal(s.session_id, sid);
  assert.equal(s.messages.length, 1 + 95 * 2);
  assert.deepEqual(s.cards.map((c) => [c.id, c.status]), [['c1', 'SAVED'], ['c2', 'READY']]);
  assert.equal(s.limits.turns_left, 5);
  // 모델 화면 크기: T1 · T2F는 창(40줄)이 찬 뒤로는 화면 길이가 거의 그대로 (대화 길이에 비례해 늘지 않음)
  for (const point of ['T1', 'T2F'] as const) {
    const sizes = fake.seen[point].map((x) => x.length).slice(30);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) < 2_000, `${point} 화면이 대화 길이에 따라 커짐: ${Math.min(...sizes)} → ${Math.max(...sizes)}`);
    const last = fake.seen[point].at(-1) ?? '';
    assert.ok(!last.includes('말 1:') && last.includes('말 95:'));
  }
  // [완료] — T2는 대화 전체(첫 말 · 끝 말)
  const r = await commit(deps, sid);
  assert.equal(r.status, 'DONE');
  const t2 = fake.seen.T2[0];
  assert.ok(t2.includes('말 1:') && t2.includes('말 95:'));
  assert.equal(rowOf(db, sid).server_state.commit?.at_turn, 95);
  assert.deepEqual(structuredProblems(rowOf(db, sid).extracted_data), []);
  assert.equal((rowOf(db, sid).transcript ?? '').split('\n').length, 1 + 95 * 2);
});

test('긴 대화 정리 실패(T2 시간 초과 · 다시 시도까지): 말 · 카드 · 기존 기록은 그대로, 계속 말할 수 있고 다시 [완료]하면 새 말까지 정리 · 상한(100) 뒤에도 정리됨', async () => {
  const db = seed();
  db.rows('todos').push({ todo_id: 't-old', user_id: ME, title: '과제', todo_type: 'TASK', due_date: TOMORROW, appointment_id: null, source_session_id: null, is_done: false, created_at: '2026-10-28T10:00:00+09:00' });
  const timeout = () => new LlmClientError('timeout', '응답이 19000ms 안에 오지 않음');
  const { fake, deps, sid } = await chat(db, manyLines(92), [timeout(), timeout()]);
  putCards(db, sid, [{ status: 'SAVED', appointment_id: 'ap-team', summary: '팀플' }]);
  const snap = () => structuredClone({ turns: (db.rows('conversation_sessions').find((x) => x.session_id === sid) as { turns: unknown[] }).turns, cards: rowOf(db, sid).server_state.cards });
  const before = snap();

  const e = await failure(commit(deps, sid));
  assert.equal(e.code, 'LLM_UNAVAILABLE');
  assert.equal(fake.order.filter((p) => p === 'T2').length, 2); // 시간 초과는 한 번 다시 시도
  assert.equal(rowOf(db, sid).server_state.commit?.status, 'FAILED');
  assert.deepEqual(snap(), before);
  assert.deepEqual(db.rows('todos').map((x) => x.title), ['과제']);
  assert.equal(rowOf(db, sid).extracted_data ?? null, null);

  // 실패 뒤에도 대화는 이어짐 — 100번째까지 말하고 101번째는 대화 길이 템플릿
  const more = await chat(db, manyLines(8, 93), [emptyExtract({ todos: [todo('우산', { due_date: TOMORROW })] })], [DIARY], LATER);
  assert.equal(more.sid, sid);
  const st = rowOf(db, sid).server_state;
  assert.equal(st.counts.user_turns, 100);
  const over = await handleVoiceTurn(more.deps, { session_id: sid, rev: st.rev, client_turn_id: cid(), text: '백한 번째' });
  assert.equal(over.limits.reached, 'TURN');

  const r = await commit(more.deps, sid);
  assert.equal(r.status, 'DONE');
  assert.ok(more.fake.seen.T2[0].includes('말 1:') && more.fake.seen.T2[0].includes('말 100:'));
  assert.equal(rowOf(db, sid).server_state.commit?.at_turn, 100);
  assert.deepEqual(db.rows('todos').map((x) => x.title), ['과제', '우산']);
});

test('계산이 안 끝난 채 이어 받은 카드: 새 구간 첫 말 전에 계산 결과(results)를 보내도 받음 — 답 없이 카드만 READY, 다음 말은 정상', async () => {
  const db = seed();
  db.now = AT_1AM;
  const night = await chat(db, [['내일 2시에 도서관에서 스터디 있어']], [], [], AT_1AM);
  putCards(db, night.sid, [{ status: 'NEEDS_ESTIMATE', summary: '스터디', draft: { title: '스터디', date: TOMORROW, time: '14:00', place: '도서관', importance: null, transport: null, repeat: [], items: [], alarms: { WAKE: true, PREPARE: true, DEPARTURE: true } } }]);
  legacy(db, night.sid);
  db.now = AT_9AM;
  const day = await chat(db, [], [], [], AT_9AM);
  assert.deepEqual(day.session.cards.map((c) => [c.id, c.status]), [['c1', 'NEEDS_ESTIMATE']]);
  const fake = fakeClaude({ T2F: [T2F_NONE], T1: [T1_OK] });
  const deps = { ...day.deps, llm: fake.client };
  const estimate = { alarms: [{ kind: 'PREPARE', at: '2026-10-30T12:30:00+09:00', enabled: true }, { kind: 'DEPARTURE', at: '2026-10-30T13:20:00+09:00', enabled: true }], level: 2, with_wake: false };
  const r = await handleVoiceTurn(deps, { session_id: day.sid, rev: day.session.rev, client_turn_id: cid(), results: { cards: [{ id: 'c1', status: 'READY', estimate, error: null }], fixes: [] } });
  assert.deepEqual([r.reply, r.cards[0].status], [null, 'READY']);
  assert.equal(fake.order.length, 0);
  const next = await handleVoiceTurn(deps, { session_id: day.sid, rev: r.rev, client_turn_id: cid(), text: '좋아 고마워 오늘도 화이팅' });
  assert.equal(next.reply?.text, T1_OK.reply);
  // 이어 받은 카드가 없는 보통 세션은 예전처럼 말 전 results를 거절
  const plain = await chat(seed(), [], [], [], AT_9AM);
  assert.equal((await failure(handleVoiceTurn(plain.deps, { session_id: plain.sid, rev: plain.session.rev, client_turn_id: cid(), results: { cards: [], fixes: [] } }))).code, 'VALIDATION_FAILED');
});

// ───────── 같은 일정의 반복 언급 · 글자 흔들림 (11/9 웹 시험 재현) ─────────

test('저장한 스터디 뒤 상관없는 말에 T2F가 "스터더 · 도서간"으로 다시 뽑아도 새 카드 없음 · 같은 시각 다른 일정(치과)은 새 카드 · [저장 안 함] 카드는 오타 재추출로 안 살아남 · 다시 열면 카드 상태와 만든 때 그대로', async () => {
  const db = seed();
  const x = (title: string, place: string | null, save = 'UNCONFIRMED') => ({ ref: null, title, date: TOMORROW, time: '14:00', place, importance: null, transport: null, repeat: null, save, unclear: null });
  const fast = (...appointments: unknown[]) => ({ ...T2F_NONE, appointments });
  const fake = fakeClaude({
    T2F: [fast(x('스터디', '도서관')), fast(x('스터더', '도서간', 'CONFIRMED')), fast(x('스터디', '도서관'), x('치과', null)), fast(x('치카', null, 'CONFIRMED'))],
    T1: Array(8).fill(T1_OK),
  });
  let clock = new Date('2026-10-29T21:00:00+09:00');
  let t = 0;
  const deps: CommitDeps = { userId: ME, userDb: db as unknown as Db, service: db as unknown as Db, llm: fake.client, model: 'gemini-3.5-flash-lite', now: () => clock, clock: () => (t += 40), sleep: async () => {} };
  const s = (await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut;
  const sid = s.session_id as string;
  const say = async (rev: number, text: string) => (await handleVoiceTurn(deps, { session_id: sid, rev, client_turn_id: cid(), text })) as VoiceTurnOut;

  // 1) 스터디 → 카드 계산 → 저장
  clock = new Date('2026-10-29T21:14:30+09:00');
  const r1 = await say(s.rev, '내일 오후 2시에 도서관에서 스터디 약속이 있어');
  assert.deepEqual([r1.next, r1.cards.map((c) => [c.id, c.status, c.at])], ['APP_TASKS', [['c1', 'NEEDS_ESTIMATE', '2026-10-29T21:14:30+09:00']]]);
  const estimate = { alarms: [{ kind: 'PREPARE', at: '2026-10-30T12:30:00+09:00', enabled: true }, { kind: 'DEPARTURE', at: '2026-10-30T13:20:00+09:00', enabled: true }], level: 2, with_wake: false };
  const r2 = (await handleVoiceTurn(deps, { session_id: sid, rev: r1.rev, client_turn_id: cid(), results: { cards: [{ id: 'c1', status: 'READY', estimate, error: null }], fixes: [] } })) as VoiceTurnOut;
  const r3 = (await handleVoiceTurn(deps, { session_id: sid, rev: r2.rev, client_turn_id: cid(), card_action: { id: 'c1', action: 'SAVED', appointment_id: 'aaaaaaaa-0000-4000-8000-000000000002', alarms: estimate.alarms.map((a) => ({ ...a, level: 2 })) } })) as VoiceTurnOut;
  assert.equal(r3.cards[0].status, 'SAVED');

  // 2) 상관없는 말 — T2F가 앞 스터디를 글자를 틀리게 다시 뽑음 → 같은 날짜 · 시각 · 한 글자 차이라 새 카드 없음
  clock = new Date('2026-10-29T21:16:42+09:00');
  const r4 = await say(r3.rev, '오늘 수업도 듣고 팀플도 하느라 정말 피곤했어');
  assert.deepEqual([r4.next, r4.cards.map((c) => c.id), r4.reply?.text], ['USER', ['c1'], T1_OK.reply]);

  // 3) 같은 시각이어도 다른 일정은 새 카드 (같은 스터디를 또 말한 것은 그대로)
  const r5 = await say(r4.rev, '내일 2시에 치과 예약도 있어');
  assert.deepEqual(r5.cards.map((c) => [c.id, c.status, c.draft?.title]), [['c1', 'SAVED', '스터디'], ['c2', 'NEEDS_ESTIMATE', '치과']]);

  // 4) [저장 안 함] 뒤 같은 일정을 글자만 틀리게 다시 뽑아도 되살아나지 않음 (장소를 다시 묻지 않음)
  const r6 = (await handleVoiceTurn(deps, { session_id: sid, rev: r5.rev, client_turn_id: cid(), card_action: { id: 'c2', action: 'REJECTED' } })) as VoiceTurnOut;
  const r7 = await say(r6.rev, '치과는 신경 안 써도 돼');
  assert.deepEqual(r7.cards.map((c) => [c.id, c.status]), [['c1', 'SAVED'], ['c2', 'REJECTED']]);
  assert.ok(!(rowOf(db, sid).server_state.events.at(-1)?.clarify ?? []).length);

  // 5) 다시 열기(16:19 상황) — 새로 만들지 않고 그대로, 카드의 만든 때도 그대로
  clock = new Date('2026-10-29T21:19:24+09:00');
  const again = (await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut;
  assert.equal(again.session_id, sid);
  assert.deepEqual(again.cards.map((c) => [c.id, c.status, c.at]), [['c1', 'SAVED', '2026-10-29T21:14:30+09:00'], ['c2', 'REJECTED', '2026-10-29T21:16:42+09:00']]);
  assert.equal(fake.order.filter((p) => p === 'T2F').length, 4);
});

test('만든 때가 없는 예전 카드: 다시 열 때 처음 나온 처리 결과의 사용자 말 때로 채움 (11/9 웹 시험 — 저장한 스터디 · 거절한 스터더가 맨 끝에 붙던 것), 저장한 상태는 그대로', async () => {
  const db = seed();
  const { deps, sid } = await chat(db, [['안녕'], ['내일 오후 2시에 도서관에서 스터디 약속이 있어'], ['오늘 수업도 듣고 팀플도 하느라 정말 피곤했어']]);
  const row = rowOf(db, sid);
  const userAt = (db.rows('conversation_sessions').find((s) => s.session_id === sid) as { turns: { role: string; at: string }[] }).turns.filter((t) => t.role === 'user').map((t) => t.at);
  // DB에 남은 모양 그대로: c1은 2번째 말 뒤 확인 대기(저장함), c2는 3번째 말 뒤 장소 되묻기(거절함), c3은 처리 결과에 없음 — 셋 다 at 없음
  putCards(db, sid, [
    { status: 'SAVED', appointment_id: 'ap-team', summary: '10/30(금) 14:00 스터디 · 도서관', draft: { title: '스터디', date: TOMORROW, time: '14:00', place: '도서관', importance: null, transport: null, repeat: [], items: [], alarms: { WAKE: true, PREPARE: true, DEPARTURE: true } } },
    { status: 'REJECTED', summary: '10/30(금) 14:00 스터더 · 도서간', draft: { title: '스터더', date: TOMORROW, time: '14:00', place: '도서간', importance: null, transport: null, repeat: [], items: [], alarms: { WAKE: true, PREPARE: true, DEPARTURE: true } } },
    { status: 'READY', summary: '' },
  ]);
  row.server_state.events = [
    { after_turn: 3, applied: [], pending: [], rejected: [], clarify: ["'스터더' 장소 (카드의 [장소 고르기])"], alarms: [] },
    { after_turn: 2, applied: [], pending: [{ id: 'c1', kind: 'APPOINTMENT', summary: '10/30(금) 14:00 스터디 · 도서관' }], rejected: [], clarify: [], alarms: [] },
  ];
  const s = (await handleVoiceSession({ ...deps, now: () => LATER }, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut;
  assert.deepEqual(s.cards.map((c) => [c.id, c.status, c.at]), [['c1', 'SAVED', userAt[1]], ['c2', 'REJECTED', userAt[2]], ['c3', 'READY', userAt[2]]]); // c3은 앞 카드 때
  assert.equal(rowOf(db, sid).server_state.cards.every((c) => c.at === undefined), true); // 저장된 상태는 안 바꿈(응답에만)
  // 만든 때가 있는 카드는 그대로
  assert.equal(withCardTimes({ ...row.server_state, cards: [{ ...row.server_state.cards[0], at: '2026-10-29T21:00:00+09:00' }] }, [])[0].at, '2026-10-29T21:00:00+09:00');
});

test('23시 대화를 [완료] 없이 두고 04:00 뒤 열면: 새 방 + 전 기준일 방을 정리 목록(uncommitted_session_ids)으로 알려 줌 — 정리하면 전 기준일로 기록, 정리 뒤엔 다시 안 알림 · 00:40에는 같은 방이라 안 알림', async () => {
  const db = seed();
  const night = await chat(db, [['오늘 팀플 발표 끝냈어']], [eventsOf('팀플 발표를 끝냄')]); // 22:30, [완료] 안 함
  const late = await chat(db, [], [], [], AFTER_MIDNIGHT);
  assert.equal(late.sid, night.sid);
  assert.deepEqual(late.session.uncommitted_session_ids, []);
  db.now = AT_9AM;
  const day = await chat(db, [], [], [], AT_9AM);
  assert.notEqual(day.sid, night.sid); // 04:00 뒤 새 방 (요구사항)
  assert.deepEqual(day.session.uncommitted_session_ids, [night.sid]);
  assert.equal(rowOf(db, night.sid).server_state.counts.user_turns, 1); // 전날 방 말은 그대로
  // 앱이 정리 요청을 보냄 → 전 기준일(10/29)로 저장
  assert.equal((await commit({ ...night.deps, now: () => AT_9AM }, night.sid)).status, 'DONE');
  assert.equal(rowOf(db, night.sid).extracted_data.session.reference_date, REVIEW);
  const again = (await handleVoiceSession({ ...day.deps, now: () => new Date('2026-10-30T09:10:00+09:00') }, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut;
  assert.deepEqual(again.uncommitted_session_ids, []);
  // 같은 기준일 방 · 말 없는 방은 알리지 않음
  assert.deepEqual(night.session.uncommitted_session_ids, []);
});
