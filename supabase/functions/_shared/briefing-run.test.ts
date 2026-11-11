// alarm-briefing 판단 부분 — 가짜 TTS · 가짜 한도(Mock)로: 긴급일 때만 Gemini · 캐시 · 한도 초과 · 429 · 동시 요청 · 출발 브리핑
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { briefingDays, runBriefing, type BriefingSource, type GeminiDeps } from './briefing-run.ts';
import { LlmClientError } from './ai/llm.ts';
import type { TtsRequest } from './ai/tts.ts';

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

function fakes(opts: { allow?: boolean; fail?: unknown } = {}) {
  const calls: TtsRequest[] = [];
  const records: { ok: boolean; errorCode: string | null }[] = [];
  let allowChecks = 0;
  const deps: GeminiDeps = {
    tts: async (req) => {
      calls.push(req);
      await new Promise((r) => setTimeout(r, 5));
      if (opts.fail) throw opts.fail;
      return { mime: 'audio/wav', data: 'UklGRg==' };
    },
    quota: {
      reserve: async () => (allowChecks++, opts.allow ?? true ? 'call-1' : null),
      finish: async (_id, r) => void records.push({ ok: r.ok, errorCode: r.errorCode }),
    },
  };
  return { deps, calls, records, allowChecks: () => allowChecks };
}

test('기준일: 11/11 아침 알람 → 전날 밤 대화 기준일 11/10', () => {
  assert.deepEqual(briefingDays(kst(7), 'Asia/Seoul'), { day: '2026-11-11', review: '2026-11-10' });
});

test('긴급이 될 수 있는 기상 알람 → 4단계 문장만 Gemini로 한 번, 1~3단계는 Android TTS 문장', async () => {
  const f = fakes();
  const out = await runBriefing(source(), new Set(), f.deps);
  assert.equal(out.gemini, 'MADE');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].style, /shouting/);
  assert.equal(f.calls[0].voice, 'Kore'); // 4단계 Gemini 목소리는 사용자 Android TTS 선택과 무관하게 고정
  assert.match(f.calls[0].text, /^야!!!!!!!!!! 지금 안 일어나면 진짜 늦어/);
  assert.deepEqual(out.audio.map((a) => a.level), [4]);
  assert.deepEqual(out.clips.map((c) => c.level), [1, 2, 3, 4]);
  assert.match(out.clips[0].text, /어제 오늘부터는 일찍 일어나겠다고 했잖아/);
  assert.doesNotMatch(out.clips[0].text, /지난 일/);
  assert.deepEqual(f.records, [{ ok: true, errorCode: null }]);
});

test('여유가 많은 알람(긴급 불가) · 준비 · 이동 모름 · 이미 출발 → Gemini 안 부름', async () => {
  for (const over of [{ scheduledAtMs: kst(6) - 24 * 60 * 60_000 }, { travelMinutes: null }, { done: true }] as Partial<BriefingSource>[]) {
    const f = fakes();
    const out = await runBriefing(source(over), new Set(), f.deps);
    assert.equal(out.gemini, 'NOT_NEEDED', JSON.stringify(over));
    assert.equal(f.calls.length + f.allowChecks(), 0);
    assert.equal(out.clips.length, 4); // Android 브리핑은 그대로
  }
});

test('폰에 열쇠가 있으면 다시 안 만듦 (미루기마다 새로 부르지 않음)', async () => {
  const first = await runBriefing(source(), new Set(), fakes().deps);
  const f = fakes();
  const again = await runBriefing(source(), new Set([first.audio[0].hash]), f.deps);
  assert.equal(again.gemini, 'CACHED');
  assert.equal(f.calls.length + f.allowChecks(), 0);
});

test('한도 초과 → 부르지 않고 LIMITED (폰은 Android TTS로 전체), 429 → 기록하고 LIMITED, 그 밖 실패 → FAILED', async () => {
  const limited = fakes({ allow: false });
  const a = await runBriefing(source(), new Set(), limited.deps);
  assert.equal(a.gemini, 'LIMITED');
  assert.equal(limited.calls.length, 0);
  assert.equal(a.clips.find((c) => c.level === 4)?.text.startsWith('야!!!!'), true);

  const r429 = fakes({ fail: new LlmClientError('rate_limit', 'quota', { status: 429 }) });
  assert.equal((await runBriefing(source(), new Set(), r429.deps)).gemini, 'LIMITED');
  assert.deepEqual(r429.records, [{ ok: false, errorCode: 'rate_limit' }]);

  const boom = fakes({ fail: new Error('down') });
  const c = await runBriefing(source(), new Set(), boom.deps);
  assert.equal(c.gemini, 'FAILED');
  assert.deepEqual(c.audio, []);
});

test('같은 음성을 동시에 두 번 요청해도 Gemini는 한 번', async () => {
  const f = fakes();
  const [x, y] = await Promise.all([runBriefing(source(), new Set(), f.deps), runBriefing(source(), new Set(), f.deps)]);
  assert.equal(f.calls.length, 1);
  assert.equal(x.audio[0].hash, y.audio[0].hash);
});

test('키 없음 → NOT_CONFIGURED, 사용자가 끄면 아무것도 안 만듦, 상한 3이면 Gemini 없음', async () => {
  assert.equal((await runBriefing(source(), new Set(), { tts: null, quota: fakes().deps.quota })).gemini, 'NOT_CONFIGURED');
  const f = fakes();
  assert.deepEqual(await runBriefing(source({ prefs: { enabled: false } }), new Set(), f.deps), { enabled: false, rule: null, clips: [], audio: [], gemini: 'NOT_NEEDED' });
  // 이전 사용자 설정의 상한/자동 강화 끔은 이제 긴급 4단계를 차단하지 않음.
  const capped = await runBriefing(source({ prefs: { coachMax: 3, escalate: false } }), new Set(), f.deps);
  assert.equal(capped.gemini, 'MADE');
  assert.deepEqual(capped.clips.map((c) => c.level), [1, 2, 3, 4]);
  assert.equal(f.calls.length, 1);
});

test('출발 알람: 그 일정 + 준비물 + 출발 촉구, 여유 0분에만 Gemini', async () => {
  const f = fakes();
  const dep = source({ kind: 'DEPARTURE', scheduledAtMs: kst(9, 20), appointments: [{ title: '면접', atMs: kst(10), importance: 'HIGH' }], todos: [{ title: '이력서', type: 'ITEM' }] });
  const out = await runBriefing(dep, new Set(), f.deps);
  assert.equal(out.clips[0].text, '오전 10시 면접 갈 시간이야. 챙길 것: 이력서. 이제 출발하자!');
  assert.equal(out.gemini, 'MADE');
  const calm = await runBriefing({ ...dep, scheduledAtMs: kst(9, 15) }, new Set(), fakes().deps); // 여유 5분 = Android 3단계
  assert.equal(calm.gemini, 'NOT_NEEDED');
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
  assert.equal(outs.filter((o) => o.gemini === 'MADE').length, 2);
  assert.equal(outs.filter((o) => o.gemini === 'LIMITED').length, 4);
});
