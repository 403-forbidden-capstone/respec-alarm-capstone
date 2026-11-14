// 기상 알람 데이터 읽기(loadWakeData) → runBriefing → 기상 대본 입력 — 가짜 DB로
//   홈탭 직접 입력 일정과 AI 대화로 저장한 일정이 둘 다 대본에 들어가는지, 준비물이 잘리지 않는지, 지난 · 지운 일정이 빠지는지, 전날 대화가 없어도 되는지
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { saveTodos } from './ai/voice-commit.ts';
import { loadWakeData } from './briefing-load.ts';
import { runBriefing } from './briefing-run.ts';
import { FakeDb } from './fake-db.ts';
import type { WakeScriptInput } from './wake-script.ts';

const TZ = 'Asia/Seoul';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const kstIso = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 10, d, h - 9, m)).toISOString();
const ALARM_AT = Date.parse(kstIso(14, 7, 30)); // 11/14 오전 7:30 기상 알람
const DAY = '2026-11-14';

// 일정 한 줄 + 내 참여 한 줄 — 홈탭(H05) · AI 대화 카드 저장 · 시간표 모두 alarm-commit으로 같은 두 표에 씀
function appt(db: FakeDb, title: string, iso: string, over: { importance?: string; exception_kind?: string | null; user?: string } = {}): string {
  const id = db.newId();
  db.rows('appointments').push({ appointment_id: id, creator_id: over.user ?? USER, title, appointment_at: iso, importance: over.importance ?? 'LOW', exception_kind: over.exception_kind ?? null });
  db.rows('appointment_participants').push({ participant_id: db.newId(), appointment_id: id, user_id: over.user ?? USER });
  return id;
}
// 홈탭 일정의 준비물 — 앱(realPlan.createAppointment)이 넣는 모양 그대로: 일정 id + 일정 날짜
const homeItem = (db: FakeDb, appointmentId: string, title: string, over: Record<string, unknown> = {}) =>
  db.rows('todos').push({ todo_id: db.newId(), user_id: USER, appointment_id: appointmentId, title, todo_type: 'ITEM', due_date: DAY, is_done: false, created_at: kstIso(13, 20), ...over });

function seed() {
  const db = new FakeDb();
  // 홈탭에서 직접 넣은 일정 + 준비물 25개 (예전 limit(20)이면 잘림)
  const lecture = appt(db, '전공 수업', kstIso(14, 14));
  for (let i = 1; i <= 25; i++) homeItem(db, lecture, `준비물${i}`);
  // AI 대화 카드로 저장한 일정 — 일정은 같은 alarm-commit 길, 대화 중 준비물은 voice-commit saveTodos가 넣음
  const team = appt(db, '팀플 발표', kstIso(14, 10), { importance: 'HIGH' });
  // 지난 일정(알람보다 이른) · 이번만 지운 회차 · 다른 날 · 남의 일정
  const early = appt(db, '새벽 운동', kstIso(14, 6));
  homeItem(db, early, '요가매트');
  const canceled = appt(db, '취소된 스터디', kstIso(14, 16), { exception_kind: 'CANCELED' });
  homeItem(db, canceled, '스터디 교재');
  const tomorrow = appt(db, '내일 면접', kstIso(15, 10));
  homeItem(db, tomorrow, '이력서', { due_date: '2026-11-15' });
  appt(db, '남의 일정', kstIso(14, 11), { user: OTHER });
  homeItem(db, lecture, '이미 챙긴 것', { is_done: true });
  return { db, lecture, team };
}

test('홈탭 일정 · AI 대화 일정 모두, 준비물은 잘리지 않고, 지난 · 지운 · 다른 날 · 남의 것 · 끝낸 것은 빠짐 (전날 대화 없음)', async () => {
  const { db, team } = seed();
  await saveTodos(db as never, USER, 'session-1', [
    { title: '발표 자료', todo_type: 'ITEM', appointment_id: team, due_date: null }, // AI가 일정에 붙인 준비물 (날짜 없음)
    { title: '우산', todo_type: 'ITEM', appointment_id: null, due_date: DAY }, // AI가 날짜만 붙인 준비물
    { title: '과제 제출', todo_type: 'TASK', appointment_id: null, due_date: DAY },
  ]);

  const data = await loadWakeData(db as never, USER, { scheduledAtMs: ALARM_AT, timeZone: TZ, participantId: null });
  assert.deepEqual(data.sessions, []); // 전날 대화가 없는 사용자
  assert.deepEqual(data.appointments.map((a) => a.title).sort(), ['새벽 운동', '전공 수업', '팀플 발표'].sort()); // 지운 회차 · 내일 · 남의 것 없음
  const items = data.todos.filter((t) => t.type === 'ITEM').map((t) => t.title);
  assert.equal(items.filter((t) => t.startsWith('준비물')).length, 25);
  for (const t of ['발표 자료', '우산']) assert.ok(items.includes(t), t);
  for (const t of ['요가매트', '스터디 교재', '이력서', '이미 챙긴 것']) assert.ok(!items.includes(t), t);
  assert.deepEqual(data.todos.filter((t) => t.type === 'TASK').map((t) => t.title), ['과제 제출']);

  // runBriefing까지 — 알람 시각 이후 일정만, 대본 입력과 모든 단계 문장에 일정 · 준비물 전부, 1 · 2단계 느낌표 없음
  const seen: WakeScriptInput[] = [];
  const out = await runBriefing(
    { kind: 'WAKE', scheduledAtMs: ALARM_AT, timeZone: TZ, prefs: {}, importance: 'LOW', appointmentAtMs: null, prepMinutes: null, travelMinutes: null, done: false, ...data },
    new Set(),
    { tts: null, quota: { reserve: async () => null, finish: async () => undefined }, script: async (x) => (seen.push(x), { scripts: null, status: 'FAILED' }) },
  );
  assert.deepEqual(seen[0].appointments.map((a) => `${a.time} ${a.title}`), ['오전 10시 팀플 발표', '오후 2시 전공 수업']); // 새벽 운동(지난 일정) 빠짐
  assert.equal(seen[0].items.length, 27);
  assert.deepEqual([seen[0].goals, seen[0].previousDay], [[], undefined]);
  for (const c of out.clips) {
    for (const w of ['오전 10시 팀플 발표', '오후 2시 전공 수업', '준비물1', '준비물25', '발표 자료', '우산']) assert.ok(c.text.includes(w), `${c.level}단계 ${w}`);
    assert.doesNotMatch(c.text, /새벽 운동|요가매트|취소된 스터디|스터디 교재|면접|이력서/);
  }
  assert.doesNotMatch(out.clips[0].text + out.clips[1].text, /[!！]/);
});

test('일정이 없어도 그날 마감 준비물 · 할 일은 안내 · 같은 줄은 한 번만 · 전날 대화가 있으면 그 기준일 것만 읽음', async () => {
  const db = new FakeDb();
  const id = appt(db, '팀플 발표', kstIso(14, 10));
  homeItem(db, id, '노트북'); // 일정에 붙고 날짜도 있음 — 두 번 읽혀도 한 번만
  const empty = new FakeDb();
  empty.rows('todos').push({ todo_id: empty.newId(), user_id: USER, appointment_id: null, title: '우산', todo_type: 'ITEM', due_date: DAY, is_done: false });
  const none = await loadWakeData(empty as never, USER, { scheduledAtMs: ALARM_AT, timeZone: TZ, participantId: null });
  assert.deepEqual([none.appointments, none.todos.map((t) => t.title)], [[], ['우산']]);

  const one = await loadWakeData(db as never, USER, { scheduledAtMs: ALARM_AT, timeZone: TZ, participantId: null });
  assert.deepEqual(one.todos.map((t) => t.title), ['노트북']);

  db.rows('conversation_sessions').push(
    { session_id: db.newId(), user_id: USER, extracted_data: { schema_version: 'structured.v1', session: { reference_date: '2026-11-13' } } },
    { session_id: db.newId(), user_id: USER, extracted_data: { schema_version: 'structured.v1', session: { reference_date: '2026-11-12' } } },
  );
  const withTalk = await loadWakeData(db as never, USER, { scheduledAtMs: ALARM_AT, timeZone: TZ, participantId: null });
  assert.deepEqual(withTalk.sessions.map((s) => s.session?.reference_date), ['2026-11-13']);
});
