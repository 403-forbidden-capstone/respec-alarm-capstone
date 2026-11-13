// 개인화 기상 대본 — 가짜 Gemini(LlmClient) · 가짜 DB로: 한 번 호출로 4단계 · 필수 정보 보충 · 느낌표 · 실패 대체 · 캐시 · 한도 · 개인화 끔
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LlmClientError, type AiCallRecord, type LlmClient, type LlmRequest } from './ai/llm.ts';
import { runBriefing, type BriefingSource } from './briefing-run.ts';
import { briefingClips, type BriefingInput } from './briefing.ts';
import { FakeDb } from './fake-db.ts';
import {
  finalizeScripts,
  missingFacts,
  wakeScriptInput,
  wakeScriptKey,
  wakeScriptsFor,
  WAKE_SCRIPT_USER_PER_DAY,
  type WakeScriptDeps,
  type WakeScriptInput,
  type WakeScripts,
} from './wake-script.ts';

const TZ = 'Asia/Seoul';
const kst = (h: number, m = 0) => Date.UTC(2026, 10, 14, h - 9, m);
const ALARM = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

// 기획 예시 데이터 (2026-11-14 · 팀플 발표 · 전공 수업 · 헬스장)
const briefInput = (over: Partial<BriefingInput> = {}): BriefingInput => ({
  kind: 'WAKE',
  memo: { wakeEarly: true, overslept: true, lateByOversleep: true, snoozeRepeat: false, goals: ['알람 미루지 않고 바로 일어나기'] },
  appointments: [
    { title: '팀플 발표', atMs: kst(10), importance: 'HIGH' },
    { title: '전공 수업', atMs: kst(14), importance: 'NORMAL' },
    { title: '헬스장', atMs: kst(18), importance: 'LOW' },
  ],
  todos: [
    { title: '노트북', type: 'ITEM' },
    { title: '발표 자료', type: 'ITEM' },
    { title: '운동복', type: 'ITEM' },
  ],
  departAtMs: null,
  timeZone: TZ,
  ...over,
});

// 모델이 잘 만든 대본 (기획 예시 그대로)
const GOOD: WakeScripts = {
  level1: '좋은 아침이야. 오늘은 오전 10시에 팀플 발표가 있고, 오후 2시에 전공 수업, 저녁 6시에 헬스장 일정이 있어. 노트북이랑 발표 자료, 운동복도 잊지 말고 챙기자. 어제 알람을 미루지 않고 바로 일어나기로 다짐했지. 오늘부터 실천해 보자.',
  level2: '이제 정말 일어나야 해. 오늘 오전 10시 팀플 발표부터 오후 2시 전공 수업, 저녁 6시 헬스장까지 일정이 많잖아. 노트북, 발표 자료, 운동복도 챙겨야 하고. 어제 알람 미루지 않고 바로 일어나기로 다짐했으니까 이제 그만 자고 일어나자. 지금 준비를 시작해야 해!',
  level3: '야! 너 어제 늦잠 자서 지각했다며! 오늘 오전 10시에 팀플 발표 있고, 오후 2시에 전공 수업, 저녁 6시에 헬스장도 가야 하잖아! 노트북이랑 발표 자료, 운동복까지 챙겨야 하는데 계속 자면 어떡해. 어제 알람 미루지 않고 바로 일어나기로 했잖아! 얼른 일어나서 준비해!',
  level4: '야! 지금 안 일어나면 오전 10시 팀플 발표 늦는다고! 오후 2시 전공 수업에 저녁 6시 헬스장도 있잖아! 노트북, 발표 자료, 운동복 챙겨야지! 어제 알람 미루지 않고 바로 일어나기로 다짐했잖아! 지금 당장 일어나서 준비해! 빨리 일어나!',
};

// 가짜 Gemini — 준비한 답(글 · 오류)을 차례로, 받은 요청을 남김
function fakeGemini(answers: (string | Error)[]): { client: LlmClient; requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    client: {
      async create(params) {
        requests.push(params);
        const a = answers.shift();
        if (a === undefined) throw new Error('준비한 답이 없음 — 호출 수가 틀림');
        if (a instanceof Error) throw a;
        return { content: [{ type: 'text', text: a }], stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 600 }, model: 'gemini-3.5-flash-lite' };
      },
    },
  };
}

function deps(client: LlmClient | null, db = new FakeDb()): { d: WakeScriptDeps; db: FakeDb; calls: AiCallRecord[] } {
  const calls: AiCallRecord[] = [];
  return {
    db,
    calls,
    d: {
      service: db as never,
      userId: USER,
      alarmId: ALARM,
      client,
      model: 'gemini-3.5-flash-lite',
      record: async (call) => {
        calls.push(call);
        db.rows('ai_calls').push({ call_id: db.newId(), user_id: USER, point: call.point, created_at: new Date().toISOString() });
      },
    },
  };
}

const ALL_FACTS = ['오전 10시', '팀플 발표', '2시', '전공 수업', '6시', '헬스장', '노트북', '발표 자료', '운동복'];

test('입력 데이터: DB 일정 · 준비물(ITEM만) · 다짐 · 전날 기록만, 시각은 읽는 말 그대로', () => {
  const x = wakeScriptInput(briefInput({ todos: [{ title: '노트북', type: 'ITEM' }, { title: '과제 제출', type: 'TASK' }], departAtMs: kst(9, 10) }), '2026-11-14');
  assert.deepEqual(x, {
    date: '2026-11-14',
    timezone: TZ,
    appointments: [
      { title: '팀플 발표', time: '오전 10시', importance: 'HIGH' },
      { title: '전공 수업', time: '오후 2시' },
      { title: '헬스장', time: '오후 6시' },
    ],
    items: ['노트북'],
    goals: ['알람 미루지 않고 바로 일어나기'],
    previousDay: { overslept: true, lateByOversleep: true },
    departureTime: '오전 9시 10분',
  });
  // 개인화를 끄면(memo null) 전날 대화 내용이 아예 안 들어감
  const off = wakeScriptInput(briefInput({ memo: null }), '2026-11-14');
  assert.deepEqual([off.goals, 'previousDay' in off], [[], false]);
});

test('Gemini 한 번으로 서로 다른 4단계 — 모든 단계에 전체 일정 · 준비물 · 다짐, 1 · 2단계 느낌표 없음, 3 · 4단계는 느낌표 그대로', async () => {
  const g = fakeGemini([JSON.stringify(GOOD)]);
  const { d, calls } = deps(g.client);
  const x = wakeScriptInput(briefInput(), '2026-11-14');
  const r = await wakeScriptsFor(d, x);
  assert.equal(r.status, 'MADE');
  assert.equal(g.requests.length, 1);
  assert.deepEqual([calls.length, calls[0].point, calls[0].ok], [1, 'AW', true]);
  // 실제 데이터가 user 글(JSON)로 감
  assert.deepEqual(JSON.parse(g.requests[0].messages[0].content as string), x);

  const texts = finalizeScripts(r.scripts!, x);
  assert.deepEqual(Object.keys(texts), ['1', '2', '3', '4']);
  assert.equal(new Set(Object.values(texts)).size, 4);
  for (const t of Object.values(texts)) {
    for (const w of ALL_FACTS) assert.ok(t!.includes(w), `${w} 없음: ${t}`);
    assert.deepEqual(missingFacts(t!, x), { appointments: false, items: false, goals: false });
  }
  assert.doesNotMatch(texts[1]! + texts[2]!, /[!！]/);
  assert.match(texts[3]!, /!/);
  assert.match(texts[4]!, /!/);
  // 일정 · 준비물은 DB 문장, 인사 · 다짐 · 기상 유도는 모델 문장 — 다짐은 모델이 말했으니 덧붙이지 않음
  assert.equal(texts[1], '좋은 아침이야. 오늘은 오전 10시 팀플 발표, 오후 2시 전공 수업, 오후 6시 헬스장 일정이 있어. 노트북, 발표 자료, 운동복 잊지 말고 챙기자. 어제 알람을 미루지 않고 바로 일어나기로 다짐했지. 오늘부터 실천해 보자.');
  assert.ok(texts[4]!.startsWith('야! 지금 안 일어나면 오전 10시 팀플 발표 늦는다고! 오후 2시 전공 수업, 오후 6시 헬스장도 있잖아! 노트북, 발표 자료, 운동복 챙겨!'), texts[4]!);
  for (const t of Object.values(texts)) assert.equal((t!.match(/미루/g) ?? []).length, 1, `다짐 중복: ${t}`);
});

test('모델이 지어낸 일정 · 시각 · 준비물 · 전날 경험 · 지각 단정은 버리고 DB 값 문장으로 · 이모지 · 마크다운 · 괄호 지시 제거', () => {
  const x = wakeScriptInput(briefInput({ memo: { wakeEarly: false, overslept: false, lateByOversleep: false, snoozeRepeat: false, goals: ['알람 미루지 않고 바로 일어나기'] } }), '2026-11-14');
  const texts = finalizeScripts(
    {
      level1: '좋은 아침이야 ☀️ **오늘** 오전 8시 동아리 회의가 있어. (부드럽게) 우산도 꼭 챙기자. 알람 미루지 않고 바로 일어나기로 했지. 천천히 일어나 보자.',
      level2: '일어나！！ 너 어제 늦잠 자서 지각했잖아. 알람을 세 번이나 미뤘잖아. 이러다 늦어. 오늘은 바로 일어나자！',
      level3: '일어나! 열 시에 회의 있잖아! 지금 당장!',
      level4: '일어나! 열 시에 회의 있잖아! 지금 당장!', // 3단계와 같음 → 4단계는 템플릿
    },
    x,
  );
  const all = Object.values(texts).join(' ');
  for (const fake of ['동아리', '8시', '우산', '늦잠', '지각', '미뤘', '열 시', '회의', '이러다 늦어']) assert.ok(!all.includes(fake), `${fake}가 남음: ${all}`);
  assert.equal(texts[1], '오늘은 오전 10시 팀플 발표, 오후 2시 전공 수업, 오후 6시 헬스장 일정이 있어. 노트북, 발표 자료, 운동복 잊지 말고 챙기자. 알람 미루지 않고 바로 일어나기로 했지. 천천히 일어나 보자.');
  // 모델 문장에 다짐이 없으면 DB 다짐 문장을 한 번만
  assert.equal(texts[2], '일어나. 오늘 오전 10시 팀플 발표, 오후 2시 전공 수업, 오후 6시 헬스장 일정이 있잖아. 노트북, 발표 자료, 운동복도 챙겨야 해. 오늘은 바로 일어나자. 어제 다짐한 "알람 미루지 않고 바로 일어나기", 꼭 지키자.');
  assert.equal(texts[3], '일어나! 오늘 오전 10시 팀플 발표, 오후 2시 전공 수업, 오후 6시 헬스장 일정 있잖아! 노트북, 발표 자료, 운동복까지 챙겨야지! 지금 당장! 어제 다짐한 "알람 미루지 않고 바로 일어나기", 꼭 지키자!');
  assert.equal(texts[4], undefined);
});

test('다짐 중복 방지: 모델이 같은 다짐을 두 번 말하면 한 번만, 다른 다짐만 빠졌으면 그것만 덧붙임', () => {
  const x = wakeScriptInput(briefInput({ memo: { wakeEarly: true, overslept: false, lateByOversleep: false, snoozeRepeat: false, goals: ['알람 미루지 않고 바로 일어나기', '아침에 물 한 잔 마시기'] } }), '2026-11-14');
  const t = finalizeScripts({ level1: '좋은 아침이야. 어제 알람 미루지 않고 바로 일어나기로 다짐했지. 알람 미루지 않고 일어나기로 했잖아. 일어나자.', level2: 'a', level3: 'b', level4: 'c' }, x)[1]!;
  assert.equal((t.match(/미루/g) ?? []).length, 1, t);
  assert.ok(t.endsWith('일어나자. 어제 다짐한 "아침에 물 한 잔 마시기", 꼭 지키자.'), t);
  // 실제 Gemini 응답(11/13)처럼 다짐을 줄여 말해도 말한 것으로 봄 · 4단계 "야!"는 DB 문장과 겹치지 않게 한 번만
  const z = wakeScriptInput(briefInput({ memo: { wakeEarly: false, overslept: false, lateByOversleep: false, snoozeRepeat: false, goals: ['아침에 물 한 잔 마시기'] } }), '2026-11-14');
  const l4 = finalizeScripts({ level1: 'a', level2: 'b', level3: 'c', level4: '야! 지금 안 일어나면 오전 10시 팀플 발표 늦는다고! 노트북 챙겨야지! 야! 어제 물 한 잔 마시기로 다짐했잖아! 빨리 일어나!' }, z)[4]!;
  assert.equal(l4, '야! 지금 안 일어나면 오전 10시 팀플 발표 늦는다고! 오후 2시 전공 수업, 오후 6시 헬스장도 있잖아! 노트북, 발표 자료, 운동복 챙겨! 어제 물 한 잔 마시기로 다짐했잖아! 빨리 일어나!');
  // 그냥 "일어나"는 "일찍 일어나기" 다짐을 말한 것으로 치지 않음
  const y = wakeScriptInput(briefInput({ memo: { wakeEarly: true, overslept: false, lateByOversleep: false, snoozeRepeat: false, goals: ['일찍 일어나기'] } }), '2026-11-14');
  assert.match(finalizeScripts({ level1: '얼른 일어나.', level2: 'a', level3: 'b', level4: 'c' }, y)[1]!, /어제 다짐한 "일찍 일어나기"/);
});

test('잘못된 JSON · 스키마 어긋남 · API 오류 · 키 없음 → 대본 없음(템플릿), 실패도 호출 기록', async () => {
  const x = wakeScriptInput(briefInput(), '2026-11-14');
  for (const [answer, want] of [
    ['{"level1": "앞부분만', 'FAILED'],
    [JSON.stringify({ level1: 'a', level2: 'b' }), 'FAILED'],
    [new LlmClientError('bad_request', '400'), 'FAILED'],
    [new LlmClientError('rate_limit', '429'), 'LIMITED'],
  ] as const) {
    const g = fakeGemini([answer]);
    const { d, calls } = deps(g.client);
    const r = await wakeScriptsFor(d, x);
    assert.deepEqual([r.status, r.scripts, calls.length, calls[0].ok], [want, null, 1, false], String(answer));
  }
  const none = await wakeScriptsFor(deps(null).d, x);
  assert.deepEqual([none.status, none.scripts], ['NOT_CONFIGURED', null]);
});

test('캐시: 같은 데이터면 저장된 대본(Gemini 0번), 준비물 · 다짐이 바뀌면 새로 만들고 음성 열쇠도 바뀜', async () => {
  const g = fakeGemini([JSON.stringify(GOOD), JSON.stringify({ ...GOOD, level3: `${GOOD.level3} 충전기도!` })]);
  const { d, db } = deps(g.client);
  const x = wakeScriptInput(briefInput(), '2026-11-14');
  assert.equal((await wakeScriptsFor(d, x)).status, 'MADE');
  assert.equal(db.rows('wake_scripts').length, 1);
  assert.equal(db.rows('wake_scripts')[0].input_hash, wakeScriptKey(x, 'gemini-3.5-flash-lite'));
  const again = await wakeScriptsFor(d, x);
  assert.deepEqual([again.status, again.scripts, g.requests.length], ['CACHED', GOOD, 1]);

  const changed = briefInput({ todos: [...briefInput().todos, { title: '충전기', type: 'ITEM' }] });
  const x2 = wakeScriptInput(changed, '2026-11-14');
  assert.notEqual(wakeScriptKey(x2, 'gemini-3.5-flash-lite'), wakeScriptKey(x, 'gemini-3.5-flash-lite'));
  const r2 = await wakeScriptsFor(d, x2);
  assert.deepEqual([r2.status, g.requests.length, db.rows('wake_scripts').length], ['MADE', 2, 1]); // 알람마다 한 줄을 고침
  // 다짐만 바뀌어도 지문이 바뀜, 모델이 바뀌어도
  assert.notEqual(wakeScriptKey(wakeScriptInput(briefInput({ memo: null }), '2026-11-14'), 'm'), wakeScriptKey(x, 'm'));
  assert.notEqual(wakeScriptKey(x, 'other-model'), wakeScriptKey(x, 'gemini-3.5-flash-lite'));

  // 바뀐 대본 → 3 · 4단계 Gemini 음성 열쇠도 바뀜 (폰이 새 음성을 받음)
  const rule = { urgentAtMs: null, maxLevel: 4 as const };
  const prof = { voice: 'Kore', tone: 'FIRM' as const };
  const a = briefingClips(rule, prof, briefInput(), undefined, finalizeScripts(GOOD, x));
  const b = briefingClips(rule, prof, changed, undefined, finalizeScripts(r2.scripts!, x2));
  assert.notEqual(a[2].hash, b[2].hash);
});

test(`사용자 하루 ${WAKE_SCRIPT_USER_PER_DAY}번을 넘으면 부르지 않고 템플릿, 개인화할 것이 없으면 부르지 않음`, async () => {
  const g = fakeGemini([]);
  const { d, db } = deps(g.client);
  for (let i = 0; i < WAKE_SCRIPT_USER_PER_DAY; i++) db.rows('ai_calls').push({ call_id: db.newId(), user_id: USER, point: 'AW', created_at: new Date().toISOString() });
  assert.equal((await wakeScriptsFor(d, wakeScriptInput(briefInput(), '2026-11-14'))).status, 'LIMITED');
  const empty: WakeScriptInput = wakeScriptInput(briefInput({ memo: null, appointments: [], todos: [] }), '2026-11-14');
  assert.equal((await wakeScriptsFor(d, empty)).status, 'NOT_NEEDED');
  assert.equal(g.requests.length, 0);
});

// --- runBriefing 연결 ---
const source = (over: Partial<BriefingSource> = {}): BriefingSource => ({
  kind: 'WAKE',
  scheduledAtMs: kst(7, 30),
  timeZone: TZ,
  prefs: {},
  importance: 'HIGH',
  appointmentAtMs: kst(10),
  prepMinutes: 50,
  travelMinutes: 40,
  departAtMs: null,
  done: false,
  appointments: briefInput().appointments.slice(),
  todos: briefInput().todos.slice(),
  sessions: [
    {
      schema_version: 'structured.v1',
      session: { reference_date: '2026-11-13' },
      goals_routine: { goals: [{ habit: 'snooze_repeat', goal_text: '알람 미루지 않고 바로 일어나기', source: 'stated' }, { habit: 'other', goal_text: '짐작한 목표', source: 'inferred' }] },
      schedule_outcomes: [{ is_late: true, causes: ['overslept'], source: 'stated' }],
    },
  ],
  ...over,
});
const noTts = { tts: null, quota: { reserve: async () => null, finish: async () => undefined } };

test('runBriefing: 기상 대본이 clips 1~4단계에 들어가고 3 · 4단계 Gemini TTS(엄마 Gacrux · 긴급 Kore) 연결 · Android 값은 그대로', async () => {
  const seen: WakeScriptInput[] = [];
  const out = await runBriefing(source(), new Set(), { ...noTts, script: async (x) => (seen.push(x), { scripts: GOOD, status: 'MADE' }) });
  assert.equal(out.script, 'MADE');
  assert.deepEqual(seen[0].goals, ['알람 미루지 않고 바로 일어나기']); // 짐작(inferred)은 안 씀
  assert.equal(seen[0].date, '2026-11-14');
  assert.deepEqual(out.clips.map((c) => c.level), [1, 2, 3, 4]);
  assert.ok(out.clips[0].text.startsWith('좋은 아침이야. 오늘은 오전 10시 팀플 발표,'), out.clips[0].text);
  assert.doesNotMatch(out.clips[1].text, /!/); // 2단계 "해야 해!" → 마침표
  assert.ok(out.clips[2].text.startsWith('야! 오늘 오전 10시 팀플 발표,') && out.clips[2].text.includes('너 어제 늦잠 자서 지각했다며!'), out.clips[2].text); // 전날 기록이 있어 늦잠 문장은 남김
  assert.deepEqual(out.clips.map((c) => [c.pitch, c.rate]), [[1, 1], [1.7, 1.5], [1.7, 1.5], [1.7, 1.5]]);
  const template = await runBriefing(source(), new Set(), noTts);
  assert.equal(template.script, undefined);
  assert.notEqual(template.clips[3].hash, out.clips[3].hash);
});

test('runBriefing: 대본 실패면 템플릿 — 모든 단계에 전체 일정 · 준비물 · 다짐, 1 · 2단계 느낌표 없음', async () => {
  const out = await runBriefing(source(), new Set(), { ...noTts, script: async () => ({ scripts: null, status: 'FAILED' }) });
  assert.equal(out.script, 'FAILED');
  for (const c of out.clips) {
    for (const w of ['오전 10시 팀플 발표', '오후 2시 전공 수업', '오후 6시 헬스장', '노트북', '발표 자료', '운동복', '알람 미루지 않고 바로 일어나기']) assert.ok(c.text.includes(w), `${c.level}단계 ${w}: ${c.text}`);
  }
  assert.doesNotMatch(out.clips[0].text + out.clips[1].text, /!/);
});

test('runBriefing: 개인화를 끄면 전날 대화를 대본 입력에 안 넣음 · 출발 알람은 대본을 안 만듦', async () => {
  const seen: WakeScriptInput[] = [];
  const script = async (x: WakeScriptInput) => (seen.push(x), { scripts: null, status: 'FAILED' as const });
  await runBriefing(source({ prefs: { personal: false } }), new Set(), { ...noTts, script });
  assert.deepEqual([seen[0].goals, seen[0].previousDay], [[], undefined]);
  await runBriefing(source({ kind: 'DEPARTURE' }), new Set(), { ...noTts, script });
  assert.equal(seen.length, 1);
});
