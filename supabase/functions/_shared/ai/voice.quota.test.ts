// voice-turn 호출 수 · 사용량 관문 시험 — 기본(차례로) 흐름에서 말 하나에 모델을 몇 번 부르는지, 관문이 막을 때 무엇을 돌려주는지
// 가짜 DB + 가짜 모델(지점별 미리 정한 출력, 준비한 수보다 많이 부르면 오류). 네트워크 · 키 없음
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { HttpError } from '../errors.ts';
import { FakeDb } from '../fake-db.ts';
import type { Db } from '../supabase.ts';
import { fakeClaude, type FakeScript } from './fake-claude.ts';
import { LIMIT_AI_DAY_TEXT } from './opening.ts';
import { QuotaGate, type QuotaLimits, type Usage } from './quota.ts';
import { extractNeeded, handleVoiceTurn, type VoiceDeps, type VoiceTurnOut } from './turn.ts';
import { handleVoiceSession, type VoiceSessionOut } from './voice-session.ts';

const DATA = JSON.parse(readFileSync(new URL('./testdata/s3-dev-014.json', import.meta.url), 'utf8')) as {
  T2F: Record<string, Record<string, unknown>>;
  T1: Record<string, Record<string, unknown>>;
};
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));
const T2F_NONE = { appointments: [], alarm_changes: [], fact_feedback: [], prep_adjustment: null, safety_flag: false };
const T1_OK = clean(DATA.T1.preview);

const ME = 'u-me';
const NOW = new Date('2026-10-29T20:30:00+09:00');
let seq = 0;
const cid = () => `bbbbbbbb-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const text = (sid: string, rev: number, t: string) => ({ session_id: sid, rev, client_turn_id: cid(), text: t });

async function start(script: FakeScript, extra: Partial<VoiceDeps> = {}) {
  const db = new FakeDb();
  db.now = NOW;
  db.rows('profiles').push({ user_id: ME, nickname: '지민', timezone: 'Asia/Seoul' });
  const fake = fakeClaude(script);
  let t = 0;
  const deps: VoiceDeps = {
    userId: ME, userDb: db as unknown as Db, service: db as unknown as Db, llm: fake.client, model: 'gemini-3.5-flash-lite',
    now: () => NOW, clock: () => (t += 40), sleep: async () => {}, ...extra,
  };
  const s = (await handleVoiceSession(deps, { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume: true })) as VoiceSessionOut;
  return { db, fake, deps, sid: s.session_id as string, rev: s.rev };
}

const gateOf = (limits: Partial<QuotaLimits>, usage: Partial<Usage> = {}) =>
  new QuotaGate({ rpm: 0, tpm: 0, rpd: 0, concurrency: 0, ...limits }, async () => ({ minuteRequests: 0, minuteTokens: 0, dayRequests: 0, callTokens: 5000, ...usage }));

test('기본(차례로): 처리할 게 없는 말 = T2F 1 + T1 1, 미리 부른 T1이 없음', async () => {
  const { fake, deps, sid, rev, db } = await start({ T2F: [T2F_NONE], T1: [T1_OK] });
  const r = (await handleVoiceTurn(deps, text(sid, rev, '오늘 좀 피곤했어'))) as VoiceTurnOut;
  assert.equal(r.next, 'USER');
  assert.ok(r.reply);
  assert.deepEqual(fake.order, ['T2F', 'T1']);
  assert.equal(db.rows('ai_calls').length, 2);
});

test('기본(차례로): 새 일정 말 = T2F 1번만 (앱 일 APP_TASKS — T1은 results 뒤에)', async () => {
  const { fake, deps, sid, rev } = await start({ T2F: [clean(DATA.T2F.new_appt)], T1: [] });
  const r = (await handleVoiceTurn(deps, text(sid, rev, '내일 10시 강남역에서 캡스톤 발표 있어'))) as VoiceTurnOut;
  assert.equal(r.next, 'APP_TASKS');
  assert.deepEqual(fake.order, ['T2F']);
});

test('인사 · 작별은 추출을 건너뜀 = T1 1번', async () => {
  const { fake, deps, sid, rev } = await start({ T2F: [], T1: [T1_OK] });
  await handleVoiceTurn(deps, text(sid, rev, '잘자~ ㅎㅎ'));
  assert.deepEqual(fake.order, ['T1']);
});

test('extractNeeded: 정해진 인사 · 작별만 건너뜀 — 응 · 네 · 일정 · 위험한 말은 추출', () => {
  for (const s of ['잘자', '고마워!', '굿나잇 🌙', 'ㅂㅂ', '안녕~']) assert.equal(extractNeeded(s), false, s);
  for (const s of ['응', '네', '잘자 내일 9시에 깨워줘', '고마워 근데 내일 수업 취소됐어', '그만 살고 싶어']) assert.equal(extractNeeded(s), true, s);
});

test('AI_PARALLEL_PREVIEW: 동시 모드는 예전처럼 T2F ∥ T1 미리 (처리 결과가 없으면 미리 부른 답을 씀 = 2번)', async () => {
  const { fake, deps, sid, rev } = await start({ T2F: [T2F_NONE], T1: [T1_OK] }, { parallelPreview: true });
  await handleVoiceTurn(deps, text(sid, rev, '오늘 좀 피곤했어'));
  assert.deepEqual([...fake.order].sort(), ['T1', 'T2F']);
});

test('관문 1분 한도: 말을 쌓기 전에 LLM_UNAVAILABLE(RATE_LIMITED) — 모델 0번, 대화 그대로라 같은 말을 다시 보낼 수 있음', async () => {
  const { fake, deps, sid, rev, db } = await start({ T2F: [T2F_NONE], T1: [T1_OK] }, { quota: gateOf({ rpm: 5 }, { minuteRequests: 4 }) });
  const before = JSON.stringify(db.rows('conversation_sessions'));
  let err: unknown = null;
  try {
    await handleVoiceTurn(deps, text(sid, rev, '오늘 좀 피곤했어'));
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof HttpError);
  assert.equal(err.code, 'LLM_UNAVAILABLE');
  assert.deepEqual(err.details, { code: 'RATE_LIMITED', scope: 'RPM', retry_after_s: 60 });
  assert.deepEqual(fake.order, []);
  assert.equal(JSON.stringify(db.rows('conversation_sessions')), before);
});

test('정한 한도(RPM 8)에 가까우면 새 말을 막음 — 1분에 7번 썼으면 이 말에 필요한 2번이 안 들어가 차단, 6번이면 통과', async () => {
  const limits = { rpm: 8, tpm: 200_000, rpd: 300 };
  const near = await start({ T2F: [], T1: [] }, { quota: gateOf(limits, { minuteRequests: 7 }) });
  await assert.rejects(handleVoiceTurn(near.deps, text(near.sid, near.rev, '오늘 좀 피곤했어')), (e) => e instanceof HttpError && (e.details as { scope: string }).scope === 'RPM');
  assert.deepEqual(near.fake.order, []);
  const ok = await start({ T2F: [T2F_NONE], T1: [T1_OK] }, { quota: gateOf(limits, { minuteRequests: 6 }) });
  await handleVoiceTurn(ok.deps, text(ok.sid, ok.rev, '오늘 좀 피곤했어'));
  assert.deepEqual(ok.fake.order, ['T2F', 'T1']);
});

test('정한 한도(TPM 200,000)에 가까우면 막음 — 1분 입력 토큰 191,000 + 이 말 2번 × 5,000 = 201,000 > 200,000', async () => {
  const { fake, deps, sid, rev } = await start({ T2F: [], T1: [] }, { quota: gateOf({ rpm: 8, tpm: 200_000, rpd: 300 }, { minuteTokens: 191_000 }) });
  await assert.rejects(handleVoiceTurn(deps, text(sid, rev, '오늘 좀 피곤했어')), (e) => e instanceof HttpError && (e.details as { scope: string }).scope === 'TPM');
  assert.deepEqual(fake.order, []);
});

test('정한 한도(RPD 300): 하루 299번이면 이 말(2번)이 안 들어가 "오늘은 여기까지" — 작별 말(1번)은 통과', async () => {
  const limits = { rpm: 8, tpm: 200_000, rpd: 300 };
  const day = await start({ T2F: [], T1: [] }, { quota: gateOf(limits, { dayRequests: 299 }) });
  const r = (await handleVoiceTurn(day.deps, text(day.sid, day.rev, '오늘 좀 피곤했어'))) as VoiceTurnOut;
  assert.equal(r.reply?.text, LIMIT_AI_DAY_TEXT);
  const bye = await start({ T2F: [], T1: [T1_OK] }, { quota: gateOf(limits, { dayRequests: 299 }) });
  await handleVoiceTurn(bye.deps, text(bye.sid, bye.rev, '잘자'));
  assert.deepEqual(bye.fake.order, ['T1']);
});

test('관문 하루 한도: "오늘은 AI 대화를 더 할 수 없어요" 템플릿 + reached DAY — 모델 0번', async () => {
  const { fake, deps, sid, rev } = await start({ T2F: [], T1: [] }, { quota: gateOf({ rpd: 100 }, { dayRequests: 100 }) });
  const r = (await handleVoiceTurn(deps, text(sid, rev, '오늘 좀 피곤했어'))) as VoiceTurnOut;
  assert.equal(r.reply?.text, LIMIT_AI_DAY_TEXT);
  assert.equal(r.limits.reached, 'DAY');
  assert.deepEqual(fake.order, []);
});

test('관문 미리 보기는 이 턴에 필요한 수만 — 작별 말(T1 1번)은 1분 여유가 1번뿐이어도 통과', async () => {
  const { fake, deps, sid, rev, db } = await start({ T2F: [], T1: [T1_OK] }, { quota: gateOf({ rpm: 1 }) });
  const r = (await handleVoiceTurn(deps, text(sid, rev, '잘자'))) as VoiceTurnOut;
  assert.ok(r.reply);
  assert.deepEqual(fake.order, ['T1']);
  assert.equal(db.rows('ai_calls').length, 1);
});
