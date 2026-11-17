// Gemini 기상 대본 · 음성을 언제 만드는지 — 알람을 만들 · 고칠 때는 안 만들고, 알람 날 새벽 4시 · 전날 대화 정리 뒤에만 (briefing-handler.ts holdGemini)
//   잘못 만든 새벽 알람이 사용자 하루 TTS 한도(2)를 먼저 써 버려 정작 기상 알람 음성을 못 만들던 문제
//   Gemini는 fetch를 바꿔 끼워 흉내 (대본 = generateContent, 음성 = interactions). 한도 예약(reserve_alarm_tts)은 가짜 DB rpc로 셈
import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';

import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';

const env: Record<string, string> = { GEMINI_API_KEY: 'test-key' };
(globalThis as { Deno?: unknown }).Deno ??= { env: { get: (k: string) => env[k] } };
const { briefAlarm } = await import('./briefing-handler.ts');
const { COMMIT_LAG_MS } = await import('./briefing-refresh.ts');

const A = '11111111-1111-4111-8111-111111111111';
const kst = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 10, d, h - 9, m)).toISOString();

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const SCRIPTS = { level1: '좋은 아침이에요. 오늘 오전 10시에 팀플 발표가 있어요.', level2: '일어날 시간이에요. 오전 10시 팀플 발표 잊지 마세요.', level3: '이제 정말 일어나야 해요. 오전 10시 팀플 발표예요.', level4: '지금 바로 일어나요. 오전 10시 팀플 발표예요.' };

/** 가짜 Gemini — calls.script = 대본(Flash-Lite) 호출, calls.tts = 음성 호출 (보낸 글을 남김) */
function fakeGemini(ttsOk = true) {
  const calls = { script: 0, tts: [] as string[] };
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes(':generateContent')) {
      calls.script++;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(SCRIPTS) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } }), { status: 200 });
    }
    calls.tts.push(String(init?.body ?? ''));
    if (!ttsOk) return new Response('{"error":{"message":"tts down"}}', { status: 500 });
    return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: 'UklGRg==' }] }] }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

/** 사용자 A · 11/14 07:30 기상 알람(10시 팀플 발표) · 11/13 밤 대화(정리 전). 시각은 at(지금)으로 */
function seed(t: TestContext, nowIso: string, wakeAt = kst(14, 7, 30), opts: { appointment?: boolean; conversation?: boolean } = {}) {
  const db = new FakeDb();
  const clock = { now: Date.parse(nowIso) };
  db.now = new Date(clock.now);
  t.mock.method(Date, 'now', () => clock.now);
  const setNow = (iso: string) => {
    clock.now = Date.parse(iso);
    db.now = new Date(clock.now);
  };
  let reserves = 0;
  db.rpcHandlers.reserve_alarm_tts = () => `call-${++reserves}`;
  db.rows('profiles').push({ user_id: A, timezone: 'Asia/Seoul', alarm_voice_prefs: null });
  const day = Number(new Date(Date.parse(wakeAt) + 9 * 3_600_000).getUTCDate());
  const participant = db.newId();
  if (opts.appointment ?? true) {
    const appt = db.newId();
    db.rows('appointments').push({ appointment_id: appt, creator_id: A, title: '팀플 발표', appointment_at: kst(day, 10), importance: 'HIGH', exception_kind: null });
    db.rows('appointment_participants').push({ participant_id: participant, appointment_id: appt, user_id: A, prepare_minutes: 30, est_travel_minutes: 20, departed_at: null, arrived_at: null, appointments: null });
  }
  const alarm = (scheduled_at: string, type = 'WAKE', over: Record<string, unknown> = {}) => {
    const id = db.newId();
    db.rows('alarms').push({ alarm_id: id, user_id: A, alarm_type: type, scheduled_at, is_enabled: true, participant_id: null, voice_tone: 'DIRECT', intensity: 'NORMAL', intensity_source: 'AUTO', ...over });
    return id;
  };
  const review = new Date(Date.parse(wakeAt) + 9 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
  if (opts.conversation ?? true) {
    db.rows('conversation_sessions').push({ session_id: db.newId(), user_id: A, session_type: 'BEFORE_SLEEP', ended_at: null, server_state: { v: 1, day: { review }, counts: { user_turns: 2, llm_calls: 2 }, ended: false } });
  }
  const structured = () => {
    for (const r of db.rows('conversation_sessions')) {
      (r.server_state as Record<string, unknown>).commit = { status: 'DONE', at_turn: 2, started_at: new Date(clock.now).toISOString(), attempts: 1 };
    }
  };
  return { db, wake: alarm(wakeAt), alarm, participant, setNow, structured, reserves: () => reserves };
}
const app = (db: FakeDb) => ({ userId: A, db: db as never, service: db as never, kinds: ['WAKE', 'DEPARTURE'] as const });
const device = (db: FakeDb) => ({ userId: A, db: db as never, service: db as never, kinds: ['WAKE'] as const });

test('1. 밤 12시에 내일 아침 알람을 만들면 — 문장 브리핑만 주고 대본 · Gemini TTS 호출 0회 (4:10 다시 받기는 그대로)', async (t) => {
  const calls = fakeGemini();
  const s = seed(t, kst(14, 0));
  const out = await briefAlarm(app(s.db), { alarm_id: s.wake, have: [] });
  assert.equal(calls.tts.length, 0);
  assert.equal(calls.script, 0);
  assert.equal(s.reserves(), 0); // 한도 예약도 안 함
  assert.equal(out.gemini, 'NOT_NEEDED');
  assert.equal(out.script, undefined);
  assert.deepEqual(out.clips.map((c) => c.level), [1, 2, 3, 4]); // 템플릿 문장은 다 있음 → 폰은 Android TTS · 예비 WAV
  assert.equal(out.refresh_at, Date.parse(kst(14, 4, 10))); // 정리 뒤 백그라운드가 다시 받음
});

test('2. 잘못 만든 새벽 2시 알람 → 받고 → 지움 — Gemini TTS 0회, 정리 뒤 진짜 기상 알람은 한도 안에서 음성을 만듦', async (t) => {
  const calls = fakeGemini();
  const s = seed(t, kst(14, 0));
  const wrong = s.alarm(kst(14, 2));
  await briefAlarm(app(s.db), { alarm_id: wrong, have: [] }); // 앱이 알람을 맞춘 뒤 바로 받음
  s.setNow(kst(14, 1, 50));
  await briefAlarm(device(s.db), { alarm_id: wrong, have: [] }); // 울리기 직전 다시 받아도 4시 전 알람은 기본 음성
  assert.equal(calls.tts.length, 0);
  assert.equal(calls.script, 0);

  s.db.rows('alarms').splice(s.db.rows('alarms').findIndex((a) => a.alarm_id === wrong), 1); // 사용자가 지움
  await assert.rejects(briefAlarm(app(s.db), { alarm_id: wrong }), (e) => e instanceof HttpError && e.code === 'NOT_FOUND');
  assert.equal(calls.tts.length, 0);
  assert.equal(s.reserves(), 0);

  s.setNow(kst(14, 4, 10));
  s.structured();
  const out = await briefAlarm(device(s.db), { alarm_id: s.wake, have: [] });
  assert.ok(out.audio.length > 0);
  assert.equal(s.reserves(), calls.tts.length); // 기상 알람 몫만 예약
});

test('3. 새벽 4시 정리 전이면 미루고(refresh_at), 정리가 끝나면 그날 최신 대본(Flash-Lite) → 그 대본으로 Gemini TTS', async (t) => {
  const calls = fakeGemini();
  const s = seed(t, kst(14, 4, 10));
  const early = await briefAlarm(device(s.db), { alarm_id: s.wake, have: [] }); // 4:10 갱신인데 배치가 밀려 아직 정리 전
  assert.equal(calls.script + calls.tts.length, 0);
  assert.equal(early.refresh_at, Date.parse(kst(14, 4, 20)));

  s.setNow(kst(14, 4, 20));
  s.structured();
  const out = await briefAlarm(device(s.db), { alarm_id: s.wake, have: [] });
  assert.equal(out.refresh_at, null);
  assert.equal(out.script, 'MADE');
  assert.equal(calls.script, 1);
  assert.ok(calls.tts.length >= 1);
  // 만든 음성 = 대본이 들어간 3 · 4단계 문장 (열쇠가 같은 clip의 글)
  for (const a of out.audio) {
    const clip = out.clips.find((c) => c.level === a.level)!;
    assert.equal(a.hash, clip.hash);
    assert.match(clip.text, /팀플 발표/);
    assert.ok(calls.tts.some((body) => body.includes(clip.text.slice(0, 10))));
  }
  assert.ok(out.audio.some((a) => a.level === 3));
});

test('4. 며칠 뒤 알람 — 그날 4시 전에는 몇 번을 받아도 대본 · TTS 0회, 그날 4시 · 정리 뒤 처음 만듦', async (t) => {
  const calls = fakeGemini();
  const s = seed(t, kst(14, 12), kst(17, 7, 30));
  for (const now of [kst(14, 12), kst(15, 9), kst(16, 23, 59), kst(17, 3, 59)]) {
    s.setNow(now);
    await briefAlarm(app(s.db), { alarm_id: s.wake, have: [] });
  }
  assert.equal(calls.script + calls.tts.length, 0);
  assert.equal(s.reserves(), 0);

  s.setNow(kst(17, 4, 10));
  s.structured();
  await briefAlarm(device(s.db), { alarm_id: s.wake, have: [] });
  assert.equal(calls.script, 1);
  assert.ok(calls.tts.length >= 1);
});

test('5. 같은 대본 · 음성 설정으로 다시 받으면(앱 열기 · 백그라운드 갱신 반복) 폰에 있는 열쇠(have)라 TTS 다시 안 부름', async (t) => {
  const calls = fakeGemini();
  const s = seed(t, kst(14, 4, 10));
  s.structured();
  const first = await briefAlarm(device(s.db), { alarm_id: s.wake, have: [] });
  const made = calls.tts.length;
  assert.ok(made >= 1);
  const have = first.audio.map((a) => a.hash);
  s.setNow(kst(14, 6, 0));
  const again = await briefAlarm(app(s.db), { alarm_id: s.wake, have });
  const bg = await briefAlarm(device(s.db), { alarm_id: s.wake, have });
  assert.equal(calls.tts.length, made);
  assert.equal(calls.script, 1); // 대본도 캐시(wake_scripts)
  assert.equal(again.script, 'CACHED');
  assert.equal(again.gemini, 'CACHED');
  assert.equal(bg.gemini, 'CACHED');
  assert.deepEqual(again.clips, first.clips);
  assert.equal(s.reserves(), made);
});

test('6. Gemini TTS가 실패해도 문장 브리핑(1~4단계)은 그대로 — 폰은 저장 뒤 예비 WAV · Android TTS로 울림', async (t) => {
  const calls = fakeGemini(false);
  t.mock.method(console, 'warn', () => undefined);
  const s = seed(t, kst(14, 4, 10));
  s.structured();
  const out = await briefAlarm(device(s.db), { alarm_id: s.wake, have: [] });
  assert.ok(calls.tts.length >= 1);
  assert.equal(out.enabled, true);
  assert.equal(out.gemini, 'FAILED');
  assert.deepEqual(out.audio, []);
  assert.deepEqual(out.clips.map((c) => c.level), [1, 2, 3, 4]);
  for (const c of out.clips) assert.ok(c.text.length > 0);
});

test('정리 확인(DB)이 실패하면 정리됐는지 모름 → 대본 · TTS 미루고 10분 뒤 다시', async (t) => {
  const calls = fakeGemini();
  t.mock.method(console, 'warn', () => undefined);
  const s = seed(t, kst(14, 4, 10));
  const db = s.db as unknown as { from: (table: string) => unknown };
  const realFrom = db.from.bind(db);
  // 정리 확인 쿼리(select server_state)만 실패 — 하루 재료 읽기(같은 표)는 그대로
  t.mock.method(db, 'from', (table: string) => {
    const q = realFrom(table) as { select: (cols: string) => unknown };
    if (table !== 'conversation_sessions') return q;
    const select = q.select.bind(q);
    q.select = (cols: string) => {
      if (cols === 'server_state') throw new Error('db down');
      return select(cols);
    };
    return q;
  });
  const out = await briefAlarm(device(s.db), { alarm_id: s.wake, have: [] });
  assert.equal(calls.script + calls.tts.length, 0);
  assert.equal(out.refresh_at, Date.parse(kst(14, 4, 10)) + COMMIT_LAG_MS);
});

test('출발 · 준비 시작 알람 — 앱 길은 기상만 받아 NOT_FOUND, 예전 앱이 출발을 보내도(종류 허용) Gemini 대본 · TTS · 한도 예약 0회', async (t) => {
  const calls = fakeGemini();
  const s = seed(t, kst(14, 4, 10));
  s.structured();
  const depart = s.alarm(kst(14, 9, 10), 'DEPARTURE', { participant_id: s.participant, voice_tone: 'DIRECT' }); // 여유 0분 이하 · 말소리 강 = 예전엔 3 · 4단계 Gemini
  const prepare = s.alarm(kst(14, 8, 30), 'PREPARE', { participant_id: s.participant });
  const live = { userId: A, db: s.db as never, service: s.db as never, kinds: ['WAKE'] as const }; // alarm-briefing/index.ts와 같은 종류
  for (const id of [depart, prepare]) {
    await assert.rejects(briefAlarm(live, { alarm_id: id }), (e) => e instanceof HttpError && e.code === 'NOT_FOUND');
    await assert.rejects(briefAlarm(device(s.db), { alarm_id: id }), (e) => e instanceof HttpError && e.code === 'NOT_FOUND');
  }
  const old = await briefAlarm(app(s.db), { alarm_id: depart, have: [] });
  assert.equal(old.gemini, 'NOT_NEEDED');
  assert.deepEqual(old.audio, []);
  assert.equal(calls.script + calls.tts.length, 0);
  assert.equal(s.reserves(), 0);
});

test('7 · 12. 오늘 일정이 없는 날 — 전날 대화가 정리돼 있어도 기상 대본 · TTS 0회, 사용자가 만든 기상 알람은 지우거나 끄지 않고 문장 브리핑으로', async (t) => {
  const calls = fakeGemini();
  const s = seed(t, kst(14, 4, 10), kst(14, 7, 30), { appointment: false });
  s.structured();
  const repeat = s.alarm(kst(14, 6, 30), 'WAKE', { voice_tone: 'CALM' }); // 사용자가 따로 만든 다른 기상 알람
  const before = JSON.stringify(s.db.rows('alarms'));
  for (const id of [s.wake, repeat]) {
    const out = await briefAlarm(device(s.db), { alarm_id: id, have: [] });
    assert.equal(out.enabled, true);
    assert.equal(out.script, undefined);
    assert.deepEqual(out.audio, []);
    assert.deepEqual(out.clips.map((c) => c.level), [1, 2, 3, 4]); // Android TTS 1 · 2단계 + 3 · 4단계는 예비 WAV · Android TTS
  }
  assert.equal(calls.script + calls.tts.length, 0);
  assert.equal(s.reserves(), 0);
  assert.equal(JSON.stringify(s.db.rows('alarms')), before); // 알람 행은 그대로 (새로 생기거나 꺼지지 않음)
});

test('8. 전날 AI 대화가 없어도 오늘 일정이 있으면 4시 뒤 기상 대본 · TTS를 만듦', async (t) => {
  const calls = fakeGemini();
  const s = seed(t, kst(14, 4, 10), kst(14, 7, 30), { conversation: false });
  const out = await briefAlarm(device(s.db), { alarm_id: s.wake, have: [] });
  assert.equal(out.refresh_at, null); // 기다릴 정리 없음
  assert.equal(out.script, 'MADE');
  assert.equal(calls.script, 1);
  assert.ok(out.audio.length >= 1);
  for (const c of out.clips) assert.match(c.text, /팀플 발표/);
});

