// 자동 정리(voice-commit 배치 길) 시험 — 가짜 DB(fake-db) + 가짜 모델. 실제 Gemini · 운영 DB 없음
// 대화는 voice-session · voice-turn 진짜 길로 쌓고, 정리는 [완료](앱) 없이 runAutoCommit만 부름 = 앱이 꺼져 있는 상황
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeDb } from '../fake-db.ts';
import type { Db } from '../supabase.ts';
import { dueAt, IDLE_MS, MAX_COMMITS_PER_RUN, runAutoCommit, startAutoCommit, type AutoCommitDeps } from './auto-commit.ts';
import { fakeClaude, upstreamError, type FakeScript } from './fake-claude.ts';
import { LIVE_SESSION_MS } from './live-token.ts';
import type { ServerState } from './session.ts';
import { emptyExtract } from './testing.ts';
import { handleVoiceTurn, type VoiceTurnOut } from './turn.ts';
import { handleVoiceCommit, type CommitDeps, type VoiceCommitOut } from './voice-commit.ts';
import { handleVoiceSession, type VoiceSessionOut } from './voice-session.ts';

const ME = 'u-me';
const T2F_NONE = { appointments: [], alarm_changes: [], fact_feedback: [], prep_adjustment: null, safety_flag: false };
const T1_OK = { reply: '그랬군요.', acts: [], end: false };
const DIARY = { diary: '발표를 잘 마친 하루였다.' };
const kst = (s: string) => new Date(`${s}+09:00`);
let seq = 0;
const cid = () => `dddddddd-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function seed(users = [ME]): FakeDb {
  const db = new FakeDb();
  db.now = kst('2026-10-29T22:00:00');
  for (const u of users) db.rows('profiles').push({ user_id: u, nickname: '지민', timezone: 'Asia/Seoul' });
  return db;
}

const wake = (db: FakeDb, at: string, over: Record<string, unknown> = {}) =>
  db.rows('alarms').push({ alarm_id: `al-${++seq}`, user_id: ME, participant_id: null, routine_id: null, alarm_type: 'WAKE', scheduled_at: kst(at).toISOString(), intensity: 'NORMAL', is_enabled: true, ...over });

/** 앱으로 대화 (같은 날 열린 방이면 이어 받음) — [완료]는 안 누름 */
async function chat(db: FakeDb, lines: string[], at: Date, user = ME): Promise<string> {
  db.now = at;
  const fake = fakeClaude({ T2F: lines.map(() => T2F_NONE), T1: lines.map(() => T1_OK) });
  const deps: CommitDeps = { userId: user, userDb: db as unknown as Db, service: db as unknown as Db, llm: fake.client, model: 'm', now: () => at, sleep: async () => {} };
  const s = (await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut;
  let rev = s.rev;
  for (const text of lines) rev = ((await handleVoiceTurn(deps, { session_id: s.session_id, rev, client_turn_id: cid(), text })) as VoiceTurnOut).rev;
  return s.session_id as string;
}

/** 서버 배치 한 번 — 그 시각에 가짜 모델로 */
function run(db: FakeDb, at: Date, script: FakeScript = {}, over: Partial<AutoCommitDeps> = {}) {
  db.now = at;
  const fake = fakeClaude(script);
  return { fake, out: runAutoCommit({ service: db as unknown as Db, llm: fake.client, model: 'm', now: () => at, sleep: async () => {}, ...over }) };
}

const stateOf = (db: FakeDb, sid: string) => (db.rows('conversation_sessions').find((s) => s.session_id === sid) as { server_state: ServerState }).server_state;
const told = (text: string) => emptyExtract({ day_review: { events: [{ text, time: null, important: true, source: 'stated' }], memorable: null } });

// ───────── 정리 시각 ─────────

test('dueAt: 기준일 다음 날 KST 04:00 — 월말 · 연말도', () => {
  assert.equal(dueAt('2026-10-29'), kst('2026-10-30T04:00:00').getTime());
  assert.equal(dueAt('2026-11-30'), kst('2026-12-01T04:00:00').getTime());
  assert.equal(dueAt('2026-12-31'), kst('2027-01-01T04:00:00').getTime());
  assert.ok(IDLE_MS > LIVE_SESSION_MS); // Live 한 번(최대 10분)은 60분 기다림 안에 듦
});

// ───────── 앱 종료 · 기상 알람과 상관없음 ─────────

test('앱이 꺼져 있어도: 04:00에 서버가 정리 (할 일 · 기록 JSON · 일기), [완료] 없이 — 기상 알람 7시가 있어도 2시간 전(05:00)이 아니라 04:00', async () => {
  const db = seed();
  wake(db, '2026-10-30T07:00:00');
  const sid = await chat(db, ['오늘 발표 잘 끝냈어. 내일 우산 챙겨야 해'], kst('2026-10-29T22:30:00'));

  const early = run(db, kst('2026-10-30T03:59:00'));
  assert.deepEqual(await early.out, { pending: 1, waiting: 1, done: [], errors: [], left: 0 });
  assert.deepEqual(early.fake.order, []);

  const extract = { ...told('발표를 잘 끝냄'), todos: [{ title: '우산', type: 'ITEM' as const, due_date: '2026-10-30', appointment_ref: null, appointment_title: null }] };
  const due = run(db, kst('2026-10-30T04:00:00'), { T2: [extract], T5: [DIARY] });
  assert.deepEqual((await due.out).done, [{ session_id: sid, status: 'DONE' }]);
  assert.deepEqual(due.fake.order, ['T2', 'T5']);
  assert.deepEqual(db.rows('todos').map((t) => [t.title, t.user_id]), [['우산', ME]]);
  assert.deepEqual(db.rows('daily_journals').map((j) => [j.user_id, j.record_date, j.ai_summary]), [[ME, '2026-10-29', DIARY.diary]]);
  assert.equal(stateOf(db, sid).commit?.status, 'DONE');
  assert.equal(stateOf(db, sid).ended, false); // 대화방은 그대로 (#448)

  // 정리한 대화는 다시 안 함 · 앱이 나중에 [완료]를 눌러도 저장한 결과를 그대로 (Gemini 안 부름)
  const again = run(db, kst('2026-10-30T04:10:00'));
  assert.deepEqual(await again.out, { pending: 0, waiting: 0, done: [], errors: [], left: 0 });
  const tap = fakeClaude({});
  const r = (await handleVoiceCommit({ userId: ME, userDb: db as unknown as Db, service: db as unknown as Db, llm: tap.client, model: 'm', now: () => kst('2026-10-30T08:00:00') }, { session_id: sid })) as VoiceCommitOut;
  assert.equal(r.status, 'DONE');
  assert.deepEqual([tap.order, again.fake.order], [[], []]);
});

test('기상 알람이 없어도 · 이른 알람(05:00)이 있어도 04:00 정리 — 알람을 바꿔도 정리 때는 그대로', async () => {
  for (const alarmAt of [null, '2026-10-30T05:00:00', '2026-10-30T09:00:00']) {
    const db = seed();
    if (alarmAt) wake(db, alarmAt);
    await chat(db, ['오늘 피곤했어'], kst('2026-10-29T23:00:00'));
    assert.equal((await run(db, kst('2026-10-30T03:59:00')).out).waiting, 1, String(alarmAt));
    assert.deepEqual((await run(db, kst('2026-10-30T04:00:00'), { T2: [emptyExtract()] }).out).done.map((d) => d.status), ['DONE'], String(alarmAt));
  }
});

// ───────── 대화 중 미룸 · 날짜 ─────────

test('03:50까지 대화하면 04:50 뒤에 정리 (마지막 말 60분 대기) — 기준일은 전날', async () => {
  const db = seed();
  const sid = await chat(db, ['잠이 안 와'], kst('2026-10-30T03:50:00'));
  assert.equal(stateOf(db, sid).day.review, '2026-10-29');
  assert.equal((await run(db, kst('2026-10-30T04:00:00')).out).waiting, 1);
  assert.equal((await run(db, kst('2026-10-30T04:49:00')).out).waiting, 1);
  assert.equal((await run(db, kst('2026-10-30T04:50:00'), { T2: [emptyExtract()] }).out).done.length, 1);
});

test('자정 넘은 대화: 23시 방을 00:40에 열면 같은 방(기준일 같음) — 04:00에 한 번 정리, 일기는 그날 한 줄 · 04:00 뒤 대화는 새 방 · 새 기준일이라 안 건드림', async () => {
  const db = seed();
  const night = await chat(db, ['오늘 발표했어'], kst('2026-10-29T22:30:00'));
  const late = await chat(db, ['아 그리고 저녁에 친구 만났어'], kst('2026-10-30T00:40:00'));
  assert.equal(late, night);
  assert.equal(stateOf(db, late).day.review, '2026-10-29');

  const r = run(db, kst('2026-10-30T04:00:00'), { T2: [told('발표하고 친구를 만남')], T5: [DIARY] });
  assert.deepEqual((await r.out).done.map((d) => d.session_id), [night]);
  assert.deepEqual(db.rows('daily_journals').map((j) => [j.record_date, j.ai_summary]), [['2026-10-29', DIARY.diary]]);

  // 10/30 04:00 뒤 대화(기준일 10/30)는 새 방 · 다음 날 04:00 전까지 정리 안 함
  const today = await chat(db, ['오늘은 쉬었어'], kst('2026-10-30T05:00:00'));
  assert.notEqual(today, night);
  assert.equal(stateOf(db, today).day.review, '2026-10-30');
  const evening = run(db, kst('2026-10-31T03:59:00'));
  assert.deepEqual([(await evening.out).waiting, evening.fake.order], [1, []]);
});

test('월말 · 연말 넘김: 11/30 23시 대화는 12/1 04:00, 12/31 대화는 1/1 04:00에 정리 — 기준일은 전날', async () => {
  for (const [talk, before, at, review] of [
    ['2026-11-30T23:00:00', '2026-12-01T03:59:00', '2026-12-01T04:00:00', '2026-11-30'],
    ['2027-01-01T01:00:00', '2027-01-01T03:59:00', '2027-01-01T04:00:00', '2026-12-31'],
  ]) {
    const db = seed();
    const sid = await chat(db, ['오늘 피곤했어'], kst(talk));
    assert.equal(stateOf(db, sid).day.review, review);
    assert.equal((await run(db, kst(before)).out).waiting, 1, talk);
    assert.equal((await run(db, kst(at), { T2: [emptyExtract()] }).out).done.length, 1, talk);
  }
});

test('Live 음성 대화 중(사용자 말이 방금 들어옴)에는 정리하지 않음', async () => {
  const db = seed();
  const at = kst('2026-10-30T06:00:00');
  db.now = at;
  const fake = fakeClaude({ T2F: [T2F_NONE] });
  const deps: CommitDeps = { userId: ME, userDb: db as unknown as Db, service: db as unknown as Db, llm: fake.client, model: 'm', now: () => at, sleep: async () => {} };
  const s = (await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut; // 글 · Live는 같은 방(input_mode는 TEXT만)
  await handleVoiceTurn(deps, { session_id: s.session_id, rev: s.rev, client_turn_id: cid(), text: '어제 늦게 잤어', spoken_reply: '그랬군요' }); // Live 한 차례
  const r = run(db, kst('2026-10-30T06:09:00')); // 04:00은 지났지만 Live 중
  assert.deepEqual([(await r.out).waiting, r.fake.order], [1, []]);
});

// ───────── 추가 발화 · 겹침 · 실패 ─────────

test('정리 중 추가 발화: 그 앞까지 저장(STALE), 새 말은 60분 뒤 다음 실행이 다시 정리 · 할 일 겹침 없음', async () => {
  const db = seed();
  const sid = await chat(db, ['내일 우산 챙겨야 해'], kst('2026-10-29T23:00:00'));
  const umbrella = { title: '우산', type: 'ITEM' as const, due_date: null, appointment_ref: null, appointment_title: null };
  const talkMeanwhile = () => {
    const row = db.rows('conversation_sessions').find((s) => s.session_id === sid) as { turns: unknown[]; server_state: ServerState };
    row.turns.push({ n: row.turns.length, role: 'user', text: '모레 도서관 가야 해', at: '2026-10-30T04:00:00+09:00', client_turn_id: 'late' });
    row.server_state = { ...row.server_state, rev: row.server_state.rev + 1, counts: { ...row.server_state.counts, user_turns: row.server_state.counts.user_turns + 1 } };
    return emptyExtract({ todos: [umbrella] });
  };
  assert.deepEqual((await run(db, kst('2026-10-30T04:00:00'), { T2: [talkMeanwhile] }).out).done, [{ session_id: sid, status: 'STALE' }]);
  assert.equal((await run(db, kst('2026-10-30T04:30:00')).out).waiting, 1); // 새 말 뒤 60분 안
  const again = run(db, kst('2026-10-30T05:00:00'), { T2: [emptyExtract({ todos: [umbrella, { ...umbrella, title: '도서관 책' }] })] });
  assert.deepEqual((await again.out).done, [{ session_id: sid, status: 'DONE' }]);
  assert.deepEqual(db.rows('todos').map((t) => t.title), ['우산', '도서관 책']);
});

test('중복 실행: 같은 때 배치 두 번이 겹쳐도 T2는 한 번', async () => {
  const db = seed();
  await chat(db, ['오늘 피곤했어'], kst('2026-10-29T23:00:00'));
  const at = kst('2026-10-30T04:00:00');
  const a = run(db, at, { T2: [emptyExtract()] });
  const b = run(db, at, { T2: [emptyExtract()] });
  const [ra, rb] = await Promise.all([a.out, b.out]);
  assert.equal(a.fake.order.length + b.fake.order.length, 1);
  assert.deepEqual([...ra.done, ...rb.done].map((d) => d.status).sort(), ['DONE', 'RUNNING']);
});

test('실패 재시도: T2 실패 → 30분 쉬고 다시 (그 사이 Gemini 안 부름) · 성공하면 끝', async () => {
  const db = seed();
  const sid = await chat(db, ['오늘 피곤했어'], kst('2026-10-29T23:00:00'));
  const first = run(db, kst('2026-10-30T04:00:00'), { T2: [upstreamError(), upstreamError()] });
  assert.deepEqual((await first.out).errors, [{ session_id: sid, code: 'LLM_UNAVAILABLE' }]);
  assert.equal(stateOf(db, sid).commit?.status, 'FAILED');
  const soon = run(db, kst('2026-10-30T04:20:00'));
  assert.deepEqual([(await soon.out).waiting, soon.fake.order], [1, []]);
  assert.deepEqual((await run(db, kst('2026-10-30T04:30:00'), { T2: [emptyExtract()] }).out).done, [{ session_id: sid, status: 'DONE' }]);
});

// ───────── Gemini 아끼기 · 한도 ─────────

test('사용자 말이 없는 세션 · 키 없음: Gemini를 안 부름', async () => {
  const db = seed();
  await chat(db, [], kst('2026-10-29T23:00:00'));
  const r = run(db, kst('2026-10-30T09:00:00'));
  assert.deepEqual([await r.out, r.fake.order], [{ pending: 0, waiting: 0, done: [], errors: [], left: 0 }, []]);

  await chat(db, ['하나 더'], kst('2026-10-30T09:10:00'));
  assert.deepEqual(await runAutoCommit({ service: db as unknown as Db, llm: null, model: 'm', now: () => kst('2026-10-31T09:00:00') }), { pending: 0, waiting: 0, done: [], errors: [], left: 0 });
});

test('한 번에 처리하는 수 · 시간 제한: 3개까지, 60초 넘으면 새로 시작 안 함 — 남은 것은 다음 실행', async () => {
  const users = ['u1', 'u2', 'u3', 'u4', 'u5'];
  const db = seed(users);
  for (const u of users) await chat(db, ['오늘 피곤했어'], kst('2026-10-29T23:00:00'), u);
  const at = kst('2026-10-30T04:00:00');
  const first = await run(db, at, { T2: Array(5).fill(emptyExtract()) }).out;
  assert.deepEqual([first.done.length, first.left], [MAX_COMMITS_PER_RUN, 2]);

  const slow = await run(db, at, {}, { elapsed: () => 60_000 }).out;
  assert.deepEqual([slow.done.length, slow.left], [0, 2]);
  const rest = await run(db, at, { T2: [emptyExtract(), emptyExtract()] }).out;
  assert.deepEqual([rest.done.length, rest.left, rest.pending], [2, 0, 2]);
});

// ───────── 응답 먼저 · 정리는 뒤에서 (pg_net 10초 대기) ─────────

/** startAutoCommit을 그 시각에 — waitUntil이 받은 작업과 로그를 돌려줌 */
function start(db: FakeDb, at: Date, script: FakeScript = {}, over: Partial<AutoCommitDeps> = {}) {
  db.now = at;
  const fake = fakeClaude(script);
  const jobs: Promise<unknown>[] = [];
  const logs: { level: 'log' | 'error'; text: string }[] = [];
  const log = { log: (...a: unknown[]) => logs.push({ level: 'log', text: a.join(' ') }), error: (...a: unknown[]) => logs.push({ level: 'error', text: a.join(' ') }) };
  const res = startAutoCommit({ service: db as unknown as Db, llm: fake.client, model: 'm', now: () => at, sleep: async () => {}, ...over }, (p) => jobs.push(p), log);
  return { fake, res, jobs, logs };
}

test('응답 먼저: 정리를 기다리지 않고 바로 답함 · 정리는 waitUntil 작업에서 끝남 · 시작 · 완료 로그(같은 run_id)', async () => {
  const db = seed();
  const sid = await chat(db, ['오늘 발표 잘 끝냈어'], kst('2026-10-29T22:30:00'));
  const s = start(db, kst('2026-10-30T04:00:00'), { T2: [told('발표를 잘 끝냄')], T5: [DIARY] });

  assert.equal(s.res.accepted, true);
  assert.equal(s.jobs.length, 1);
  assert.equal(stateOf(db, sid).commit, undefined); // 답한 때는 아직 정리 전
  assert.deepEqual(s.fake.order, []);
  assert.deepEqual(s.logs.map((l) => l.text), [`[auto-commit] 시작 run=${s.res.run_id}`]);

  await s.jobs[0];
  assert.equal(stateOf(db, sid).commit?.status, 'DONE');
  assert.deepEqual(s.fake.order, ['T2', 'T5']);
  assert.equal(s.logs[1].level, 'log');
  assert.ok(s.logs[1].text.startsWith(`[auto-commit] 완료 run=${s.res.run_id}`));
  assert.ok(s.logs[1].text.includes(`"status":"DONE"`));
});

test('뒤 작업 오류: 정리 실패(T2)는 error 로그 · 세션은 FAILED로 남아 다음 실행이 다시 시도 · 작업은 거절 없이 끝남', async () => {
  const db = seed();
  const sid = await chat(db, ['오늘 피곤했어'], kst('2026-10-29T23:00:00'));
  const s = start(db, kst('2026-10-30T04:00:00'), { T2: [upstreamError(), upstreamError()] });
  await s.jobs[0]; // 거절되면 여기서 던짐
  assert.equal(s.logs[1].level, 'error');
  assert.ok(s.logs[1].text.startsWith(`[auto-commit] 완료 run=${s.res.run_id}`));
  assert.ok(s.logs[1].text.includes('LLM_UNAVAILABLE'));
  assert.equal(stateOf(db, sid).commit?.status, 'FAILED');
  assert.deepEqual((await run(db, kst('2026-10-30T04:30:00'), { T2: [emptyExtract()] }).out).done, [{ session_id: sid, status: 'DONE' }]);
});

test('뒤 작업 오류: 배치 자체가 터지면(DB 읽기 실패) 실패 로그 · 작업은 거절 없이 끝남', async () => {
  const broken = { from: () => { throw new Error('db down'); } } as unknown as Db;
  const s = start(seed(), kst('2026-10-30T04:00:00'), {}, { service: broken });
  assert.equal(s.res.accepted, true);
  await s.jobs[0];
  assert.deepEqual(s.logs.map((l) => [l.level, l.text]), [
    ['log', `[auto-commit] 시작 run=${s.res.run_id}`],
    ['error', `[auto-commit] 실패 run=${s.res.run_id} Error: db down`],
  ]);
});
