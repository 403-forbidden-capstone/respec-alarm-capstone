// alarm-briefing 판단 부분 — 가짜 TTS · 가짜 한도(Mock)로: 3 · 4단계 Gemini · 캐시 · 한도 초과 · 429 · 동시 요청 · 출발 브리핑
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { briefingDays, runBriefing, type BriefingSource, type GeminiDeps } from './briefing-run.ts';
import { LlmClientError } from './ai/llm.ts';
import type { TtsRequest } from './ai/tts.ts';
import { GEMINI_STAGE } from './briefing.ts';

const kst = (h: number, m = 0) => Date.UTC(2026, 10, 11, h - 9, m);

// 10시 약속 · 준비 50 · 이동 40 → 8:25는 3단계, 8:30부터는 4단계. 기상 알람이 길어질 때도 전환
const source = (over: Partial<BriefingSource> = {}): BriefingSource => ({
  kind: 'WAKE',
  scheduledAtMs: kst(7, 30),
  timeZone: 'Asia/Seoul',
  prefs: {},
  importance: 'LOW',
  appointmentAtMs: kst(10),
  prepMinutes: 50,
  travelMinutes: 40,
  departAtMs: kst(9, 10),
  done: false,
  appointments: [
    { title: '팀플 회의', atMs: kst(10), importance: 'LOW' },
    { title: '지난 일', atMs: kst(6), importance: 'NORMAL' },
  ],
  todos: [],
  sessions: [{ schema_version: 'structured.v1', session: { reference_date: '2026-11-10' }, goals_routine: { goals: [{ habit: 'irregular_wake', goal_text: '일찍', source: 'stated' }] } }],
  ...over,
});

// allow: 예약 가능 횟수(숫자) 또는 늘 가능/불가. fail: 모든 호출 실패, failVoice: 그 목소리만 실패
function fakes(opts: { allow?: boolean | number; fail?: unknown; failVoice?: string } = {}) {
  const calls: TtsRequest[] = [];
  const records: { ok: boolean; errorCode: string | null }[] = [];
  let allowChecks = 0;
  const deps: GeminiDeps = {
    tts: async (req) => {
      calls.push(req);
      await new Promise((r) => setTimeout(r, 5));
      if (opts.fail) throw opts.fail;
      if (opts.failVoice === req.voice) throw new Error('down');
      return { mime: 'audio/wav', data: 'UklGRg==' };
    },
    quota: {
      reserve: async () => {
        allowChecks++;
        const ok = typeof opts.allow === 'number' ? allowChecks <= opts.allow : (opts.allow ?? true);
        return ok ? `call-${allowChecks}` : null;
      },
      finish: async (_id, r) => void records.push({ ok: r.ok, errorCode: r.errorCode }),
    },
  };
  return { deps, calls, records, allowChecks: () => allowChecks };
}

test('기준일: 11/11 아침 알람 → 전날 밤 대화 기준일 11/10', () => {
  assert.deepEqual(briefingDays(kst(7), 'Asia/Seoul'), { day: '2026-11-11', review: '2026-11-10' });
});

const level = (o: { audio: { level: number }[] }) => o.audio.map((a) => a.level);

test('긴급이 될 수 있는 기상 알람 → 4단계(긴급 Kore) 먼저, 3단계(엄마 Gacrux) 다음 — 단계마다 한 번, 1 · 2단계는 Android TTS 문장', async () => {
  const f = fakes();
  const out = await runBriefing(source(), new Set(), f.deps);
  assert.equal(out.gemini, 'MADE');
  assert.deepEqual(out.levels, { 4: 'MADE', 3: 'MADE' });
  assert.deepEqual(f.calls.map((c) => [c.voice, c.style]), [[GEMINI_STAGE[4].voice, GEMINI_STAGE[4].style], [GEMINI_STAGE[3].voice, GEMINI_STAGE[3].style]]);
  assert.deepEqual(f.calls.map((c) => c.voice), ['Kore', 'Gacrux']); // 사용자 Android TTS 선택과 무관하게 고정
  assert.equal(f.calls[0].text, out.clips.find((c) => c.level === 4)?.text);
  assert.equal(f.calls[1].text, out.clips.find((c) => c.level === 3)?.text);
  assert.match(f.calls[0].text, /^야! 너 안 일어나\?! 지금 안 일어나면 진짜 늦어!/);
  assert.doesNotMatch(f.calls[0].text, /speak|Emotion/i); // 대사와 영어 지시는 따로
  assert.deepEqual(level(out), [4, 3]);
  assert.deepEqual(out.audio.map((a) => a.hash), [4, 3].map((l) => out.clips.find((c) => c.level === l)?.hash));
  assert.deepEqual(out.clips.map((c) => c.level), [1, 2, 3, 4]);
  assert.match(out.clips[0].text, /어제 다짐한 "일찍", 오늘 실천해 보자/);
  assert.doesNotMatch(out.clips[0].text, /지난 일/);
  assert.deepEqual(f.records, [{ ok: true, errorCode: null }, { ok: true, errorCode: null }]);
});

test('여유가 많은 알람(긴급 불가) · 준비 · 이동 모름 · 이미 출발 → 4단계는 안 부르고 3단계(스누즈로 옴)만', async () => {
  for (const over of [{ scheduledAtMs: kst(6) - 24 * 60 * 60_000 }, { travelMinutes: null }, { done: true }] as Partial<BriefingSource>[]) {
    const f = fakes();
    const out = await runBriefing(source(over), new Set(), f.deps);
    assert.deepEqual(out.levels, { 3: 'MADE' }, JSON.stringify(over));
    assert.deepEqual(f.calls.map((c) => c.voice), ['Gacrux']);
    assert.deepEqual(level(out), [3]);
    assert.equal(out.clips.length, 4); // Android 브리핑은 그대로
  }
});

test('폰에 열쇠가 있으면 다시 안 만듦 (미루기마다 새로 부르지 않음) — 단계마다 따로', async () => {
  const first = await runBriefing(source(), new Set(), fakes().deps);
  const f = fakes();
  const again = await runBriefing(source(), new Set(first.audio.map((a) => a.hash)), f.deps);
  assert.equal(again.gemini, 'CACHED');
  assert.equal(f.calls.length + f.allowChecks(), 0);
  // 4단계만 폰에 있으면 3단계만 새로
  const only4 = first.audio.find((a) => a.level === 4)!.hash;
  const g = fakes();
  const part = await runBriefing(source(), new Set([only4]), g.deps);
  assert.deepEqual(part.levels, { 4: 'CACHED', 3: 'MADE' });
  assert.deepEqual(g.calls.map((c) => c.voice), ['Gacrux']);
});

test('한도 초과 → 부르지 않고 LIMITED (폰은 예비 WAV · Android TTS), 429 → 기록하고 LIMITED, 그 밖 실패 → FAILED', async () => {
  const limited = fakes({ allow: false });
  const a = await runBriefing(source(), new Set(), limited.deps);
  assert.equal(a.gemini, 'LIMITED');
  assert.deepEqual(a.levels, { 4: 'LIMITED', 3: 'LIMITED' });
  assert.equal(limited.calls.length, 0);
  assert.deepEqual(a.audio, []);
  assert.equal(a.clips.find((c) => c.level === 4)?.text.startsWith('야! 너 안 일어나'), true); // Android 대체 문장은 그대로

  const r429 = fakes({ fail: new LlmClientError('rate_limit', 'quota', { status: 429 }) });
  assert.equal((await runBriefing(source(), new Set(), r429.deps)).gemini, 'LIMITED');
  assert.deepEqual(r429.records, [{ ok: false, errorCode: 'rate_limit' }, { ok: false, errorCode: 'rate_limit' }]);

  // 네트워크 · 타임아웃 · 서버 오류
  for (const fail of [new LlmClientError('connection', 'offline'), new LlmClientError('timeout', 'slow'), new Error('down')]) {
    const boom = fakes({ fail });
    const c = await runBriefing(source(), new Set(), boom.deps);
    assert.equal(c.gemini, 'FAILED');
    assert.deepEqual(c.audio, []);
  }
});

test('한도가 하나뿐이면 실제 지각 위험인 4단계를 먼저 만들고 3단계는 LIMITED (→ 폰은 3단계 예비 WAV)', async () => {
  const f = fakes({ allow: 1 });
  const out = await runBriefing(source(), new Set(), f.deps);
  assert.deepEqual(out.levels, { 4: 'MADE', 3: 'LIMITED' });
  assert.deepEqual(level(out), [4]);
  assert.equal(out.gemini, 'LIMITED');
  assert.deepEqual(f.calls.map((c) => c.voice), ['Kore']);
});

test('단계마다 따로 성공 · 실패 — 4단계가 실패해도 3단계 음성은 저장', async () => {
  const f = fakes({ failVoice: 'Kore' });
  const out = await runBriefing(source(), new Set(), f.deps);
  assert.deepEqual(out.levels, { 4: 'FAILED', 3: 'MADE' });
  assert.deepEqual(level(out), [3]);
  assert.equal(out.audio[0].hash, out.clips.find((c) => c.level === 3)?.hash);
  assert.equal(out.gemini, 'FAILED');
});

test('같은 음성을 동시에 두 번 요청해도 Gemini는 단계마다 한 번', async () => {
  const f = fakes();
  const [x, y] = await Promise.all([runBriefing(source(), new Set(), f.deps), runBriefing(source(), new Set(), f.deps)]);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(x.audio.map((a) => a.hash), y.audio.map((a) => a.hash));
});

test('키 없음 → NOT_CONFIGURED, 사용자가 끄면 아무것도 안 만듦, 예전 상한 3 설정은 무시', async () => {
  assert.equal((await runBriefing(source(), new Set(), { tts: null, quota: fakes().deps.quota })).gemini, 'NOT_CONFIGURED');
  const f = fakes();
  assert.deepEqual(await runBriefing(source({ prefs: { enabled: false } }), new Set(), f.deps), { enabled: false, rule: null, clips: [], audio: [], gemini: 'NOT_NEEDED' });
  // 이전 사용자 설정의 상한/자동 강화 끔은 이제 긴급 단계를 차단하지 않음.
  const capped = await runBriefing(source({ prefs: { coachMax: 3, escalate: false } }), new Set(), f.deps);
  assert.equal(capped.gemini, 'MADE');
  assert.deepEqual(capped.clips.map((c) => c.level), [1, 2, 3, 4]);
  assert.equal(f.calls.length, 2);
});

test('출발 알람: 그 일정 + 준비물 + 출발 촉구, 여유 0분 이하에 4단계 Gemini, 3단계는 말소리 강일 때만', async () => {
  const f = fakes();
  const dep = source({ kind: 'DEPARTURE', scheduledAtMs: kst(9, 20), voiceTone: 'NEUTRAL', appointments: [{ title: '면접', atMs: kst(10), importance: 'HIGH' }], todos: [{ title: '이력서', type: 'ITEM' }] });
  const out = await runBriefing(dep, new Set(), f.deps);
  assert.equal(out.clips[0].text, '오전 10시 면접 갈 시간이야. 챙길 것: 이력서. 이제 출발하자.');
  assert.deepEqual(out.levels, { 4: 'MADE' });
  assert.deepEqual((await runBriefing({ ...dep, voiceTone: 'DIRECT' }, new Set(), fakes().deps)).levels, { 4: 'MADE', 3: 'MADE' });
  // 여유 5분 — 예전엔 3단계였지만 이제 시작 단계 그대로 (중 → Gemini 없음, 강 → 3단계만)
  assert.equal((await runBriefing({ ...dep, scheduledAtMs: kst(9, 15) }, new Set(), fakes().deps)).gemini, 'NOT_NEEDED');
  assert.deepEqual((await runBriefing({ ...dep, scheduledAtMs: kst(9, 15), voiceTone: 'DIRECT' }, new Set(), fakes().deps)).levels, { 3: 'MADE' });
  const calm = await runBriefing({ ...dep, scheduledAtMs: kst(9) }, new Set(), fakes().deps); // 여유 20분 = 출발은 한 번 읽고 끝, Gemini 없음
  assert.equal(calm.gemini, 'NOT_NEEDED');
});

test('말소리(voice_tone) → 저장할 규칙의 시작 단계: 약 1 · 중 2 · 강 3 (폰 manifest에 저장돼 오프라인에도 유지)', async () => {
  for (const [voiceTone, start] of [['CALM', 1], ['NEUTRAL', 2], ['DIRECT', 3], [null, 2]] as const) {
    const out = await runBriefing(source({ voiceTone }), new Set(), fakes().deps);
    assert.equal(out.rule?.startLevel, start, String(voiceTone));
    assert.equal(out.rule?.urgentAtMs, kst(10) - 90 * 60_000); // 버퍼 없이 약속 − 준비 − 이동
    assert.equal(out.clips.length, 4); // 문장은 1~4단계 다 — 미루기 · 긴급 전환용
  }
  // 말소리만 바꾸면 규칙만 바뀌고 음성 열쇠는 같음 → 다시 받을 때 Gemini를 또 안 부름
  const a = await runBriefing(source({ voiceTone: 'CALM' }), new Set(), fakes().deps);
  const b = await runBriefing(source({ voiceTone: 'DIRECT' }), new Set(), fakes().deps);
  assert.deepEqual(a.clips.map((c) => c.hash), b.clips.map((c) => c.hash));
});

test('예약 함수가 던지거나(DB 오류) null이면 Gemini를 안 부르고 LIMITED — Android TTS 문장은 그대로', async () => {
  const f = fakes();
  const out = await runBriefing(source(), new Set(), { ...f.deps, quota: { reserve: async () => Promise.reject(new Error('db down')), finish: async () => undefined } });
  assert.equal(out.gemini, 'LIMITED');
  assert.equal(f.calls.length, 0);
  assert.equal(out.clips.length, 4);
});

test('여러 사용자 · 알람이 동시에 와도 원자적 예약 한도(분당 2)를 넘겨 부르지 않음', async () => {
  let reserved = 0;
  let calls = 0;
  // DB 함수처럼 확인 + 예약이 한 번에 (await 사이에 끼어들 틈이 없음)
  const quota = { reserve: async () => (reserved < 2 ? `call-${++reserved}` : null), finish: async () => undefined };
  const tts = async () => (calls++, await new Promise((r) => setTimeout(r, 5)), { mime: 'audio/wav', data: 'UklGRg==' });
  const outs = await Promise.all(
    Array.from({ length: 6 }, (_, i) => runBriefing(source({ appointments: [{ title: `일정${i}`, atMs: kst(10), importance: 'LOW' }] }), new Set(), { tts, quota })),
  );
  assert.equal(calls, 2);
  assert.equal(outs.reduce((n, o) => n + o.audio.length, 0), 2);
  // 동시에 온 알람들이 4단계를 먼저 잡음 — 3단계 때문에 4단계가 밀리지 않음
  assert.ok(outs.flatMap((o) => o.audio).every((a) => a.level === 4));
});
