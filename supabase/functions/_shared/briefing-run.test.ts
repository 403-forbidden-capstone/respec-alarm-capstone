// alarm-briefing 판단 부분 — 가짜 TTS(Mock)로: 캐시 열쇠가 있으면 안 부름 · 실패해도 던지지 않음 · 끄면 비움 · 전날 대화 끄기
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { briefingDays, runBriefing, type BriefingSource } from './briefing-run.ts';
import type { TtsRequest } from './ai/tts.ts';

const kst = (h: number, m = 0) => Date.UTC(2026, 10, 11, h - 9, m);

const source = (over: Partial<BriefingSource> = {}): BriefingSource => ({
  scheduledAtMs: kst(7),
  timeZone: 'Asia/Seoul',
  prefs: {},
  importance: 'HIGH',
  prepMinutes: 40,
  departAtMs: kst(8, 40),
  lateCount4w: 0,
  appointments: [
    { title: '팀플 회의', atMs: kst(15), importance: 'HIGH' },
    { title: '어제 지난 일', atMs: kst(6), importance: 'NORMAL' }, // 알람보다 앞 — 안 읽음
  ],
  todos: [],
  sessions: [
    {
      schema_version: 'structured.v1',
      session: { reference_date: '2026-11-10' },
      goals_routine: { goals: [{ habit: 'irregular_wake', goal_text: '일찍 일어나기', source: 'stated' }] },
    },
  ],
  ...over,
});

function fakeTts(fail: Set<number> = new Set()) {
  const calls: TtsRequest[] = [];
  const tts = async (req: TtsRequest) => {
    calls.push(req);
    if (fail.has(calls.length)) throw new Error('503 overloaded');
    return { mime: 'audio/wav', data: Buffer.from(`wav:${req.text.length}`).toString('base64') };
  };
  return { calls, tts };
}

test('기준일: 11/11 아침 알람 → 전날 밤 대화 기준일 11/10 (자정 넘은 시각도 같은 날 알람)', () => {
  assert.deepEqual(briefingDays(kst(7), 'Asia/Seoul'), { day: '2026-11-11', review: '2026-11-10' });
  assert.deepEqual(briefingDays(Date.UTC(2026, 0, 1, -9 + 6), 'Asia/Seoul'), { day: '2026-01-01', review: '2025-12-31' });
});

test('단계별 음성을 미리 만듦 — 같은 목소리, 단계마다 다른 발화 지시, 전날 다짐 + 오늘 일정이 한 문장 흐름', async () => {
  const { calls, tts } = fakeTts();
  const out = await runBriefing(source({ prefs: { coachMax: 4 } }), new Set(), tts);
  assert.equal(out.enabled, true);
  assert.deepEqual(out.audio.map((a) => a.level), [1, 2, 3, 4]);
  assert.deepEqual(out.failed, []);
  assert.ok(calls.every((c) => c.voice === 'Kore' && c.model === 'gemini-3.8-flash-tts'));
  assert.equal(new Set(calls.map((c) => c.style)).size, 4);
  assert.match(calls[0].text, /어제 오늘부터는 일찍 일어나겠다고 했잖아/);
  assert.match(calls[0].text, /오후 3시 팀플 회의/);
  assert.doesNotMatch(calls[0].text, /어제 지난 일/);
  assert.deepEqual(out.rule, { prepMinutes: 40, lateBump: false, allow4: true, maxLevel: 4 });
});

test('폰에 이미 있는 열쇠(have)는 다시 안 만듦 — 같은 내용으로 AI 재호출 없음', async () => {
  const first = await runBriefing(source(), new Set(), fakeTts().tts);
  const { calls, tts } = fakeTts();
  const again = await runBriefing(source(), new Set(first.clips.map((c) => c.hash)), tts);
  assert.equal(calls.length, 0);
  assert.deepEqual(again.audio, []);
  assert.deepEqual(again.clips, first.clips);
});

test('일정이 바뀌면 열쇠가 달라져 새로 만듦 (낡은 일정 안내 방지)', async () => {
  const first = await runBriefing(source(), new Set(), fakeTts().tts);
  const { calls, tts } = fakeTts();
  await runBriefing(source({ appointments: [{ title: '팀플 회의', atMs: kst(16), importance: 'HIGH' }] }), new Set(first.clips.map((c) => c.hash)), tts);
  assert.equal(calls.length, first.clips.length);
});

test('TTS 일부 실패 · 키 없음 → 던지지 않고 failed로 (폰은 기본 알람음)', async () => {
  const out = await runBriefing(source(), new Set(), fakeTts(new Set([2])).tts);
  assert.deepEqual(out.audio.map((a) => a.level), [1, 3]);
  assert.deepEqual(out.failed, [2]);
  const none = await runBriefing(source(), new Set(), null);
  assert.deepEqual(none.audio, []);
  assert.deepEqual(none.failed, [1, 2, 3]);
  assert.equal(none.clips.length, 3); // 문장은 줌 — 화면에 일정 표시
});

test('사용자가 끄면 아무것도 안 만듦 · 전날 대화 끄기 · 자동 강화 끄기', async () => {
  const { calls, tts } = fakeTts();
  assert.deepEqual(await runBriefing(source({ prefs: { enabled: false } }), new Set(), tts), { enabled: false, rule: null, clips: [], audio: [], failed: [] });
  assert.equal(calls.length, 0);
  const priv = await runBriefing(source({ prefs: { personal: false } }), new Set(), tts);
  assert.ok(priv.clips.every((c) => !c.text.includes('어제')));
  const calm = await runBriefing(source({ prefs: { escalate: false } }), new Set(), tts);
  assert.deepEqual(calm.clips.map((c) => c.level), [1]);
});
