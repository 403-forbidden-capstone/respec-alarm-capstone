// 브리핑 몸통(briefAlarm) — 앱 길(alarm-briefing)과 기기 길(alarm-briefing-device)이 같은 결과 · 기기 길은 본인 기상 알람만 · 대본 캐시 재사용 · refresh_at (#515)
//   Gemini는 fetch를 바꿔 끼워 흉내 (대본 = generateContent, TTS는 실패로 → 문장만). Deno.env는 시험용으로 채움
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';

const env: Record<string, string> = { GEMINI_API_KEY: 'test-key' };
(globalThis as { Deno?: unknown }).Deno ??= { env: { get: (k: string) => env[k] } };
const { briefAlarm } = await import('./briefing-handler.ts');
const { COMMIT_LAG_MS } = await import('./briefing-refresh.ts');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const kst = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 10, d, h - 9, m)).toISOString();

const realFetch = globalThis.fetch;
let scriptCalls = 0;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function fakeGemini() {
  scriptCalls = 0;
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).includes(':generateContent')) {
      scriptCalls++;
      const scripts = { level1: '좋은 아침이에요. 오늘 오전 10시에 팀플 발표가 있어요.', level2: '일어날 시간이에요. 오전 10시 팀플 발표 잊지 마세요.', level3: '이제 정말 일어나야 해요. 오전 10시 팀플 발표예요.', level4: '지금 바로 일어나요. 오전 10시 팀플 발표예요.' };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(scripts) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } }), { status: 200 });
    }
    return new Response('{"error":{"message":"tts off in test"}}', { status: 500 });
  }) as typeof fetch;
}

function seed() {
  const db = new FakeDb();
  db.now = new Date(kst(13, 23));
  for (const u of [A, B]) db.rows('profiles').push({ user_id: u, timezone: 'Asia/Seoul', alarm_voice_prefs: null });
  const alarm = (user: string, type: string, over: Record<string, unknown> = {}) => {
    const id = db.newId();
    db.rows('alarms').push({ alarm_id: id, user_id: user, alarm_type: type, scheduled_at: kst(14, 7, 30), is_enabled: true, participant_id: null, voice_tone: null, intensity: 'NORMAL', intensity_source: 'AUTO', ...over });
    return id;
  };
  const appt = db.newId();
  db.rows('appointments').push({ appointment_id: appt, creator_id: A, title: '팀플 발표', appointment_at: kst(14, 10), importance: 'HIGH', exception_kind: null });
  db.rows('appointment_participants').push({ participant_id: db.newId(), appointment_id: appt, user_id: A });
  // 전날 밤 대화 — 아직 새벽 정리 전
  db.rows('conversation_sessions').push({ session_id: db.newId(), user_id: A, session_type: 'BEFORE_SLEEP', ended_at: null, server_state: { v: 1, day: { review: '2026-11-13' }, counts: { user_turns: 2, llm_calls: 2 }, ended: false } });
  return { db, wake: alarm(A, 'WAKE'), depart: alarm(A, 'DEPARTURE'), off: alarm(A, 'WAKE', { is_enabled: false }), other: alarm(B, 'WAKE') };
}
const device = (db: FakeDb, user: string) => ({ userId: user, db: db as never, service: db as never, kinds: ['WAKE'] as const });
const notFound = (e: unknown) => e instanceof HttpError && e.code === 'NOT_FOUND';

test('기기 길: 본인 기상 알람만 — 남의 알람 · 출발 알람 · 꺼진 알람은 NOT_FOUND (서버 키로 읽어도 user_id로 막힘)', async () => {
  fakeGemini();
  const { db, depart, off, other } = seed();
  await assert.rejects(briefAlarm(device(db, A), { alarm_id: other }), notFound);
  await assert.rejects(briefAlarm(device(db, B), { alarm_id: depart }), notFound);
  await assert.rejects(briefAlarm(device(db, A), { alarm_id: depart }), notFound);
  await assert.rejects(briefAlarm(device(db, A), { alarm_id: off }), notFound);
  await assert.rejects(briefAlarm(device(db, A), { alarm_id: 'nope' }), (e) => e instanceof HttpError && e.code === 'VALIDATION_FAILED');
  assert.equal(scriptCalls, 0);
});

test('앱 길과 기기 길이 같은 브리핑 · 대본은 한 번만 만들고 다음은 캐시(wake_scripts) · 정리 전이면 refresh_at = 04:10', async (t) => {
  fakeGemini();
  const { db, wake } = seed();
  t.mock.method(Date, 'now', () => db.now.getTime()); // refresh_at은 지금 시각보다 앞설 수 없어서, 실제 시각이 04:10을 넘으면 기대값이 바뀜 → 시드 시각(전날 23:00)으로 고정
  const app = await briefAlarm({ userId: A, db: db as never, service: db as never, kinds: ['WAKE', 'DEPARTURE'] }, { alarm_id: wake, have: [] });
  assert.equal(app.script, 'MADE');
  assert.equal(scriptCalls, 1);
  assert.equal(db.rows('wake_scripts').length, 1);

  const bg = await briefAlarm(device(db, A), { alarm_id: wake, have: [] });
  assert.equal(bg.script, 'CACHED');
  assert.equal(scriptCalls, 1); // Gemini를 다시 안 부름
  assert.deepEqual(bg.clips, app.clips);
  for (const c of bg.clips) assert.match(c.text, /팀플 발표/);
  assert.equal(bg.refresh_at, Date.parse('2026-11-14T04:00:00+09:00') + COMMIT_LAG_MS);

  // 새벽 정리가 끝나면 refresh_at 없음
  const st = db.rows('conversation_sessions')[0].server_state as Record<string, unknown>;
  st.commit = { status: 'DONE', at_turn: 2, started_at: kst(14, 4), attempts: 1 };
  assert.equal((await briefAlarm(device(db, A), { alarm_id: wake })).refresh_at, null);
});
