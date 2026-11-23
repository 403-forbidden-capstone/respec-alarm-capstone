// 아침 루틴 음성 진행 — 단계 읽기 · 지침에 붙는 오늘 루틴 · 토큰 본문(지침 · 도구 · 만료) · 다른 본문으로 토큰 요청
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLiveToken, LIVE_MODEL } from './live-token.ts';
import { kstClock, parseRoutineSteps, ROUTINE_LIVE_SYSTEM, routineBriefText, routineLiveTokenBody } from './routine-live.ts';

test('단계 읽기 — order 순서, 이름 없는 칸은 뺌, 분이 없거나 이상하면 1분', () => {
  const steps = parseRoutineSteps([
    { order: 2, title: '창문 열고 불 켜기', offset: 443, minutes: 3, is_alarm: true },
    { order: 1, title: ' 물 한 잔 ', offset: 440, minutes: 3, is_alarm: false },
    { order: 3, title: '', minutes: 5 },
    { order: 4, title: '스트레칭', minutes: -2 },
    'x',
  ]);
  assert.deepEqual(steps, [
    { title: '물 한 잔', minutes: 3 },
    { title: '창문 열고 불 켜기', minutes: 3 },
    { title: '스트레칭', minutes: 1 },
  ]);
  assert.deepEqual(parseRoutineSteps(null), []);
});

test('지침에 붙는 오늘 루틴 — 번호 붙은 단계, 다음 알람 · 첫 일정은 한국 시각, 없으면 없다고', () => {
  const text = routineBriefText({
    title: '일어나자마자 2단계',
    goal: '다시 잠들지 않기',
    steps: [{ title: '물 한 잔', minutes: 3 }, { title: '창문 열고 불 켜기', minutes: 3 }],
    nextAlarm: { type: 'PREPARE', at: '2026-11-23T22:30:00Z' },
    firstPlan: { title: '수업', at: '2026-11-24T00:00:00Z' },
  });
  assert.match(text, /Today's routine: "일어나자마자 2단계" \(goal: 다시 잠들지 않기\), 2 steps:/);
  assert.match(text, /1\. 물 한 잔 \(about 3 min\)\n2\. 창문 열고 불 켜기 \(about 3 min\)/);
  assert.match(text, /prepare alarm \(준비 알람\) at 07:30\./);
  assert.match(text, /First plan of the day: "수업" at 09:00\./);
  const empty = routineBriefText({ title: '루틴', goal: null, steps: [{ title: '세수', minutes: 10 }], nextAlarm: null, firstPlan: null });
  assert.match(empty, /1 step:/);
  assert.match(empty, /No more alarms are set for this morning\.\nNo plan is scheduled for the rest of today\./);
  assert.equal(kstClock('2026-11-23T22:05:00Z'), '07:05');
});

test('토큰 본문 — 루틴 지침 + 날짜 + 오늘 루틴, 도구 셋 잠금, 1분 안 연결 · 10분 만료, 말 글로 받기', () => {
  const now = Date.parse('2026-11-23T22:00:00Z');
  const body = routineLiveTokenBody(now, '\n\nBRIEF') as { expireTime: string; newSessionExpireTime: string; bidiGenerateContentSetup: Record<string, unknown> };
  const setup = body.bidiGenerateContentSetup as { model: string; systemInstruction: { parts: { text: string }[] }; tools: { functionDeclarations: { name: string }[] }[]; inputAudioTranscription: object };
  assert.equal(setup.model, `models/${LIVE_MODEL}`);
  const sys = setup.systemInstruction.parts[0].text;
  assert.ok(sys.startsWith(ROUTINE_LIVE_SYSTEM));
  assert.match(sys, /Date rule/);
  assert.ok(sys.endsWith('BRIEF'));
  assert.deepEqual(setup.tools[0].functionDeclarations.map((f) => f.name), ['step_done', 'step_skipped', 'routine_finished']);
  assert.equal(body.newSessionExpireTime, new Date(now + 60_000).toISOString());
  assert.equal(body.expireTime, new Date(now + 10 * 60_000).toISOString());
  assert.deepEqual(setup.inputAudioTranscription, {});
});

test('createLiveToken — body를 주면 그 본문 그대로 요청 (자기 전 대화 본문 대신)', async () => {
  let sent: unknown = null;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ name: 'auth_tokens/abc' }), { status: 200 });
  }) as unknown as typeof fetch;
  const body = routineLiveTokenBody(Date.parse('2026-11-23T22:00:00Z'), '\n\nBRIEF');
  const res = await createLiveToken('k', { fetchFn, body });
  assert.deepEqual(res, { token: 'auth_tokens/abc', model: LIVE_MODEL });
  assert.deepEqual(sent, body);
});
