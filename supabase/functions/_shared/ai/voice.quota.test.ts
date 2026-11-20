// voice-turn 호출 수 · 사용량 관문 시험 — 기본(차례로) 흐름에서 말 하나에 모델을 몇 번 부르는지, 관문이 막을 때 무엇을 돌려주는지
// 가짜 DB + 가짜 모델(지점별 미리 정한 출력, 준비한 수보다 많이 부르면 오류). 네트워크 · 키 없음
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { HttpError } from '../errors.ts';
import { FakeDb } from '../fake-db.ts';
import type { Db } from '../supabase.ts';
import { fakeClaude, upstreamError, type FakeScript } from './fake-claude.ts';
import { LlmClientError } from './llm.ts';
import { LIMIT_AI_DAY_TEXT } from './opening.ts';
import { QuotaGate, QuotaLog, type QuotaLimits, type Usage } from './quota.ts';
import { extractNeeded, handleVoiceTurn, mightBeSchedule, type VoiceDeps, type VoiceTurnOut } from './turn.ts';
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

// 앞서 쓴 사용량을 메모리 기록에 채운 관문 — 1분 요청은 지금, 나머지 하루 요청은 1시간 전, 1분 토큰은 한 줄로 (한 번 어림 5,000)
const gateOf = (limits: Partial<QuotaLimits>, usage: Partial<Usage> = {}) => {
  const log = new QuotaLog();
  log.callTokens = 5000;
  const now = Date.now();
  const minute = usage.minuteRequests ?? 0;
  for (let i = 0; i < minute; i++) log.entries.push({ at: now, tokens: 0 });
  for (let i = minute; i < (usage.dayRequests ?? 0); i++) log.entries.push({ at: now - 3600_000, tokens: 0 });
  if (usage.minuteTokens) log.entries.push({ at: now, tokens: usage.minuteTokens });
  return new QuotaGate({ rpm: 0, tpm: 0, rpd: 0, concurrency: 0, ...limits }, log);
};

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

// ───────── 음성 차례 (Gemini Live가 이미 소리로 답한 말 — spoken_reply) ─────────
const voiceTurn = (sid: string, rev: number, t: string, spoken: string) => ({ ...text(sid, rev, t), spoken_reply: spoken });
const turnsOf = (db: FakeDb) => (db.rows('conversation_sessions')[0] as { turns: { role: string; text: string; source?: string }[] }).turns;

test('음성 차례: 말 + Live 답을 같은 대화에 쌓고 T2F만 (T1 0번, 답은 null — Live가 이미 함)', async () => {
  const { fake, deps, sid, rev, db } = await start({ T2F: [T2F_NONE], T1: [] });
  const r = (await handleVoiceTurn(deps, voiceTurn(sid, rev, '오늘 좀 피곤했어', '많이 피곤했겠어요. 푹 쉬어요.'))) as VoiceTurnOut;
  assert.equal(r.next, 'USER');
  assert.equal(r.reply, null);
  assert.deepEqual(fake.order, ['T2F']);
  assert.deepEqual(turnsOf(db).slice(-2).map((t) => [t.role, t.text, t.source]), [['user', '오늘 좀 피곤했어', undefined], ['ai', '많이 피곤했겠어요. 푹 쉬어요.', 'live']]);
});

test('음성 차례에 일정 → 글과 같은 카드 흐름 (APP_TASKS + 카드, T1 0번)', async () => {
  const { fake, deps, sid, rev } = await start({ T2F: [clean(DATA.T2F.new_appt)], T1: [] });
  const r = (await handleVoiceTurn(deps, voiceTurn(sid, rev, '내일 10시 강남역에서 캡스톤 발표 있어', '발표가 있군요. 화면의 카드를 확인해 주세요.'))) as VoiceTurnOut;
  assert.equal(r.next, 'APP_TASKS');
  assert.ok(r.cards.length > 0);
  assert.deepEqual(fake.order, ['T2F']);
});

test('음성 다음 글 차례: T1이 음성으로 한 말과 Live 답을 문맥으로 받음', async () => {
  const { fake, deps, sid, rev } = await start({ T2F: [T2F_NONE, T2F_NONE], T1: [T1_OK] });
  const v = (await handleVoiceTurn(deps, voiceTurn(sid, rev, '오늘 도서관에서 공부했어', '도서관에서 열심히 했네요.'))) as VoiceTurnOut;
  await handleVoiceTurn(deps, text(sid, v.rev, '근데 좀 피곤해'));
  assert.deepEqual(fake.order, ['T2F', 'T2F', 'T1']);
  assert.match(fake.seen.T1[0], /오늘 도서관에서 공부했어/);
  assert.match(fake.seen.T1[0], /도서관에서 열심히 했네요/);
});

test('음성 차례가 사용량 관문에 막혀도 던지지 않고 말 · 답은 남김 (모델 0번, 추출만 건너뜀)', async () => {
  const { fake, deps, sid, rev, db } = await start({ T2F: [], T1: [] }, { quota: gateOf({ rpm: 5 }, { minuteRequests: 5 }) });
  const r = (await handleVoiceTurn(deps, voiceTurn(sid, rev, '내일 9시 수업', '수업이 있군요.'))) as VoiceTurnOut;
  assert.equal(r.next, 'USER');
  assert.deepEqual(fake.order, []);
  assert.deepEqual(turnsOf(db).slice(-2).map((t) => t.text), ['내일 9시 수업', '수업이 있군요.']);
  assert.equal(r.notice, 'RATE_LIMITED'); // 앱이 "요청이 몰려 일정을 확인하지 못했어요"를 띄움
});

test('음성 인사는 모델 0번, Live 답이 비면 내 말만 남김', async () => {
  const { fake, deps, sid, rev, db } = await start({ T2F: [], T1: [] });
  await handleVoiceTurn(deps, voiceTurn(sid, rev, '안녕', ''));
  assert.deepEqual(fake.order, []);
  assert.deepEqual(turnsOf(db).slice(-1).map((t) => [t.role, t.text]), [['user', '안녕']]);
});

// ───────── 음성 차례 — 되물음 · 추출 실패 · 나눠 말한 일정 (11/8 웹 시험) ─────────
const appt = (over: Record<string, unknown> = {}) => ({
  ...T2F_NONE,
  appointments: [{ ref: null, title: '산책', date: '2026-10-30', time: '14:00', place: null, importance: null, transport: null, repeat: null, save: 'UNCONFIRMED', unclear: null, ...over }],
});
const results = (sid: string, rev: number, client_turn_id: string, id = 'c1') => ({
  session_id: sid, rev, client_turn_id, results: { cards: [{ id, status: 'READY', estimate: (DATA as unknown as { results: { wake_0740: unknown } }).results.wake_0740, error: null }], fixes: [] },
});

test('음성 차례에 날짜가 빠진 일정 → 카드 없이 ask로 되물을 것을 돌려줌 (T1 추가 호출 없음 — Live가 소리로 물음)', async () => {
  const { fake, deps, sid, rev } = await start({ T2F: [appt({ date: null, unclear: '날짜를 말하지 않음' })], T1: [] });
  const r = (await handleVoiceTurn(deps, voiceTurn(sid, rev, '초롱이랑 2시에 산책 약속 있어', '산책 좋네요.'))) as VoiceTurnOut;
  assert.equal(r.next, 'USER');
  assert.deepEqual(r.cards, []);
  assert.equal(r.reply, null); // 글 질문 없음 — Live 답과 겹치지 않게
  assert.deepEqual(fake.order, ['T2F']);
  assert.equal(r.ask?.length, 1);
  assert.match(r.ask![0], /산책.*날짜/);
});

test('텍스트 차례의 같은 말은 ask 없이 T1이 글로 되물음 (기존 그대로)', async () => {
  const { fake, deps, sid, rev } = await start({ T2F: [appt({ date: null, unclear: '날짜를 말하지 않음' })], T1: [T1_OK] });
  const r = (await handleVoiceTurn(deps, text(sid, rev, '초롱이랑 2시에 산책 약속 있어'))) as VoiceTurnOut;
  assert.deepEqual(fake.order, ['T2F', 'T1']);
  assert.ok(r.reply?.text);
  assert.equal(r.ask, undefined);
});

test('음성 차례 추출 실패(시간 초과 · 오류) → 말은 남기고 notice EXTRACT_FAILED, 일반 말은 T1 없음', async () => {
  const { fake, deps, sid, rev, db } = await start({ T2F: [new Error('boom')], T1: [] });
  const r = (await handleVoiceTurn(deps, voiceTurn(sid, rev, '내일 2시에 산책 있어', '좋아요.'))) as VoiceTurnOut;
  assert.equal(r.notice, 'EXTRACT_FAILED');
  assert.equal(r.reply, null);
  assert.deepEqual(fake.order, ['T2F']);
  assert.deepEqual(turnsOf(db).slice(-2).map((t) => t.text), ['내일 2시에 산책 있어', '좋아요.']);
});

test('나눠 말한 일정: 이름 없음 → 되물음, 이름 → 카드 1장, 장소 → 같은 카드를 고침 (새 카드 없음)', async () => {
  const { fake, deps, sid, rev } = await start({
    T2F: [appt({ title: '', unclear: '일정 이름을 모름' }), appt(), appt({ place: '공원' })],
    T1: [T1_OK],
  });
  const r1 = (await handleVoiceTurn(deps, voiceTurn(sid, rev, '내일 초롱이랑 2시에', '네, 2시요.'))) as VoiceTurnOut;
  assert.deepEqual(r1.cards, []);
  assert.equal(r1.reply, null);
  assert.match(r1.ask?.[0] ?? '', /이름/); // Live가 "어떤 일정인가요?"를 소리로 물음
  const t2 = voiceTurn(sid, r1.rev, '산책 약속 있다고', '산책이군요.');
  const r2 = (await handleVoiceTurn(deps, t2)) as VoiceTurnOut;
  assert.equal(r2.next, 'APP_TASKS');
  assert.equal(r2.cards.length, 1);
  const r2b = (await handleVoiceTurn(deps, results(sid, r2.rev, t2.client_turn_id))) as VoiceTurnOut;
  assert.equal(r2b.cards[0].status, 'READY');
  const r3 = (await handleVoiceTurn(deps, voiceTurn(sid, r2b.rev, '아마 공원에 갈 것 같아', '공원 좋네요.'))) as VoiceTurnOut;
  assert.equal(r3.cards.length, 1); // 같은 일정 — 새 카드 아님
  assert.equal(r3.cards[0].id, r2.cards[0].id);
  assert.equal(r3.cards[0].draft?.place, '공원');
  assert.deepEqual(fake.order, ['T2F', 'T2F', 'T1', 'T2F']); // T1은 카드 계산(results) 뒤 안내 한 번뿐
});

test('같은 일정을 다시 말해도 카드는 1장 (중복 생성 없음)', async () => {
  const { deps, sid, rev } = await start({ T2F: [appt(), appt()], T1: [T1_OK] });
  const t1 = voiceTurn(sid, rev, '내일 2시에 산책 있어', '좋아요.');
  const r1 = (await handleVoiceTurn(deps, t1)) as VoiceTurnOut;
  const r1b = (await handleVoiceTurn(deps, results(sid, r1.rev, t1.client_turn_id))) as VoiceTurnOut;
  const r2 = (await handleVoiceTurn(deps, voiceTurn(sid, r1b.rev, '내일 2시에 산책 있다니까', '네, 알고 있어요.'))) as VoiceTurnOut;
  assert.equal(r2.cards.length, 1);
});

// ───────── 글 차례 일정 등록 — 11/12 사고 ("다음 주 월요일 … 일정에 추가해 줘" → 카드 없이 "내일 챙길 일정 있나요?") ─────────
// NOW = 10/29(목) 20:30 → 다음 주 월요일 = 11/2, 내일 = 10/30. T2F 출력은 실제 Gemini Flash-Lite가 이 말에 낸 모양 그대로(날짜만 NOW 기준)
const MEETING = '다음 주 월요일 오전 10시에 캡스톤 팀 회의가 있어. 장소는 학교 도서관이고, 중요한 회의라 늦으면 안 돼. 일정에 추가해 줘.';
const meeting = (over: Record<string, unknown> = {}) =>
  appt({ title: '캡스톤 팀 회의', date: '2026-11-02', time: '10:00', place: '학교 도서관', importance: 'HIGH', save: 'CONFIRMED', ...over });
const needsPlace = (sid: string, rev: number, client_turn_id: string, place: string) => ({
  session_id: sid, rev, client_turn_id, results: { cards: [{ id: 'c1', status: 'NEEDS_PLACE', estimate: null, error: `'${place}'의 위치를 골라 주세요` }], fixes: [] },
});
const timeout = () => new LlmClientError('timeout', '응답이 9000ms 안에 오지 않음');

test('다음 주 일정: 일정명 · 날짜 · 시각 · 장소 · 중요도가 다 있으면 APPT_NEW 카드 (T1은 카드 계산 뒤에만)', async () => {
  const { fake, deps, sid, rev } = await start({ T2F: [meeting()], T1: [] });
  const r = (await handleVoiceTurn(deps, text(sid, rev, MEETING))) as VoiceTurnOut;
  assert.equal(r.next, 'APP_TASKS');
  assert.equal(r.reply, null); // "내일 일정 있나요?" 같은 일반 답 없음
  assert.equal(r.cards.length, 1);
  assert.deepEqual([r.cards[0].kind, r.cards[0].status], ['APPT_NEW', 'NEEDS_ESTIMATE']);
  assert.deepEqual(
    { title: r.cards[0].draft?.title, date: r.cards[0].draft?.date, time: r.cards[0].draft?.time, place: r.cards[0].draft?.place, importance: r.cards[0].draft?.importance },
    { title: '캡스톤 팀 회의', date: '2026-11-02', time: '10:00', place: '학교 도서관', importance: 'HIGH' },
  );
  assert.equal(r.cards[0].summary, '11/2(월) 10:00 캡스톤 팀 회의 · 학교 도서관');
  assert.deepEqual(fake.order, ['T2F']);
});

test('내일 일정: 같은 흐름으로 내일 날짜 카드', async () => {
  const { deps, sid, rev } = await start({ T2F: [meeting({ date: '2026-10-30' })], T1: [] });
  const r = (await handleVoiceTurn(deps, text(sid, rev, '내일 오전 10시에 학교 도서관에서 캡스톤 팀 회의 있어'))) as VoiceTurnOut;
  assert.equal(r.next, 'APP_TASKS');
  assert.equal(r.cards[0].draft?.date, '2026-10-30');
  assert.match(r.cards[0].summary, /^10\/30\(금\) 10:00 캡스톤 팀 회의/);
});

test('장소를 특정하지 못한 일정: 앱이 NEEDS_PLACE로 알리면 카드는 남고(무시 안 함) T1이 장소 고르기를 안내', async () => {
  const { fake, deps, sid, rev } = await start({ T2F: [meeting()], T1: [T1_OK] });
  const t = text(sid, rev, MEETING);
  const r = (await handleVoiceTurn(deps, t)) as VoiceTurnOut;
  const r2 = (await handleVoiceTurn(deps, needsPlace(sid, r.rev, t.client_turn_id, '학교 도서관'))) as VoiceTurnOut;
  assert.equal(r2.next, 'USER');
  assert.equal(r2.cards.length, 1);
  assert.equal(r2.cards[0].status, 'NEEDS_PLACE');
  assert.ok(r2.reply?.text);
  assert.match(fake.seen.T1[0], /학교 도서관/); // T1 화면에 장소를 골라야 하는 카드가 실림
  assert.deepEqual(fake.order, ['T2F', 'T1']);
});

test('추출 시간 초과(일정일 수도 있는 글): T1으로 넘기지 않고 LLM_UNAVAILABLE(extract_failed) — 말 · rev는 그대로, [다시 시도]가 추출부터 다시 해 카드', async () => {
  const { fake, deps, sid, rev, db } = await start({ T2F: [timeout(), meeting()], T1: [] });
  const t = text(sid, rev, MEETING);
  let err: unknown = null;
  try {
    await handleVoiceTurn(deps, t);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof HttpError);
  assert.equal(err.code, 'LLM_UNAVAILABLE');
  const d = err.details as { code: string; extract_failed: boolean; rev: number; cards: unknown[] };
  assert.deepEqual([d.code, d.extract_failed, d.rev, d.cards], ['TIMEOUT', true, rev, []]);
  assert.deepEqual(fake.order, ['T2F']); // T1("내일 챙길 일정 있나요?") 안 부름
  assert.equal(turnsOf(db).some((x) => x.text === MEETING), false); // 말을 쌓지 않음
  assert.deepEqual(db.rows('ai_calls').map((c) => [c.point, c.error_code]), [['T2F', 'TIMEOUT']]); // 실패한 호출도 기록
  const r = (await handleVoiceTurn(deps, t)) as VoiceTurnOut; // [다시 시도] = 같은 client_turn_id · rev
  assert.equal(r.next, 'APP_TASKS');
  assert.equal(r.cards[0].draft?.title, '캡스톤 팀 회의');
  assert.deepEqual(fake.order, ['T2F', 'T2F']);
  assert.equal(turnsOf(db).filter((x) => x.text === MEETING).length, 1);
});

test('추출 실패(5xx 두 번)도 같음 — details.code UPSTREAM', async () => {
  const { fake, deps, sid, rev } = await start({ T2F: [upstreamError(), upstreamError()], T1: [] });
  await assert.rejects(handleVoiceTurn(deps, text(sid, rev, MEETING)), (e: HttpError) => (e.details as { code: string; extract_failed: boolean }).code === 'UPSTREAM' && (e.details as { extract_failed: boolean }).extract_failed);
  assert.deepEqual(fake.order, ['T2F', 'T2F']);
});

test('일정이 아닌 글의 추출 실패는 기존 그대로 T1 답 (대화가 멈추지 않음), 음성 차례도 기존 그대로 notice', async () => {
  const { fake, deps, sid, rev } = await start({ T2F: [timeout()], T1: [T1_OK] });
  const r = (await handleVoiceTurn(deps, text(sid, rev, '오늘 좀 피곤했어'))) as VoiceTurnOut;
  assert.ok(r.reply?.text);
  assert.equal(r.notice, 'EXTRACT_FAILED');
  assert.deepEqual(fake.order, ['T2F', 'T1']);
});

test('mightBeSchedule: 사고 메시지 · 내일 · 회의는 일정일 수도 있음, 일반 말은 아님', () => {
  assert.equal(mightBeSchedule(MEETING), true);
  assert.equal(mightBeSchedule('내일 9시 수업'), true);
  assert.equal(mightBeSchedule('오늘 좀 피곤했어'), false);
  assert.equal(mightBeSchedule('아무것도 하기 싫어'), false);
});

// ───────── 준비물 바로 등록 (T2F.v2-d items → todos ITEM, 11/12) ─────────
// NOW = 10/29(목) 20:30 → 내일 = 10/30
const withItems = (items: { title: string; date: string }[], over: Record<string, unknown> = {}) => ({ ...T2F_NONE, items, ...over });
const itemRows = (db: FakeDb) => db.rows('todos').map((t) => [t.title, t.todo_type, t.due_date, t.appointment_id]);
const oldItem = (title: string) => ({ todo_id: `old-${title}`, user_id: ME, title, todo_type: 'ITEM', due_date: '2026-10-30', appointment_id: null, source_session_id: 'other', is_done: false, created_at: '2026-10-28T10:00:00+09:00' });

test('준비물: "내일 노트북 챙겨야 돼" → 대화 끝을 기다리지 않고 todos에 ITEM(내일)으로 바로 저장, 카드 없음 · T1이 저장된 것을 앎', async () => {
  const { fake, deps, sid, rev, db } = await start({ T2F: [withItems([{ title: '노트북', date: '2026-10-30' }])], T1: [T1_OK] });
  const r = (await handleVoiceTurn(deps, text(sid, rev, '내일 노트북 챙겨야 돼'))) as VoiceTurnOut;
  assert.deepEqual(itemRows(db), [['노트북', 'ITEM', '2026-10-30', null]]);
  assert.equal(db.rows('todos')[0].source_session_id, sid);
  assert.deepEqual(r.cards, []); // 일정 변경 카드로 잘못 띄우지 않음
  assert.equal(r.next, 'USER');
  assert.deepEqual(fake.order, ['T2F', 'T1']);
  assert.match(fake.seen.T1[0], /준비물 목록에 추가\(홈 준비물에 보임\): 노트북/);
});

test('준비물: 내일 일정이 있어도 기존 일정을 바꾸지 않음 (카드 없음 · 약속 행 그대로) — 여러 개는 하나씩', async () => {
  const { deps, sid, rev, db } = await start({ T2F: [withItems([{ title: '노트북', date: '2026-10-30' }, { title: '충전기', date: '2026-10-30' }])], T1: [T1_OK] });
  db.rows('appointments').push({ appointment_id: 'ap-t', creator_id: ME, title: '캡스톤 발표', appointment_at: '2026-10-30T10:00:00+09:00', dest_name: '강남역', importance: 'HIGH', recurrence_rule: null });
  const before = JSON.stringify(db.rows('appointments'));
  const r = (await handleVoiceTurn(deps, text(sid, rev, '내일 발표 때 노트북이랑 충전기 챙겨야 해'))) as VoiceTurnOut;
  assert.deepEqual(r.cards, []);
  assert.equal(JSON.stringify(db.rows('appointments')), before);
  assert.deepEqual(itemRows(db).map((x) => x[0]), ['노트북', '충전기']);
});

test('준비물 중복: 다음 말에서 T2F가 같은 준비물을 또 내도 한 번만', async () => {
  const same = withItems([{ title: '노트북', date: '2026-10-30' }]);
  const { fake, deps, sid, rev, db } = await start({ T2F: [same, same], T1: [T1_OK, T1_OK] });
  const r1 = (await handleVoiceTurn(deps, text(sid, rev, '내일 노트북 챙겨야 돼'))) as VoiceTurnOut;
  await handleVoiceTurn(deps, text(sid, r1.rev, '잊지 말아야지 노트북'));
  assert.equal(db.rows('todos').filter((t) => t.title === '노트북').length, 1);
  assert.match(fake.seen.T1[1], /사용자 말 2 뒤:\n- 바뀐 것 없음/); // 두 번째 말에서는 다시 알리지 않음
});

test('준비물 중복: 다른 대화가 이미 넣은 같은 날 같은 준비물은 다시 안 넣고 "이미 있음"', async () => {
  const { fake, deps, sid, rev, db } = await start({ T2F: [withItems([{ title: '충전기', date: '2026-10-30' }])], T1: [T1_OK] });
  db.rows('todos').push(oldItem('충전기'));
  await handleVoiceTurn(deps, text(sid, rev, '내일 충전기 가져가야 해'));
  assert.equal(db.rows('todos').length, 1);
  assert.match(fake.seen.T1[0], /준비물 목록에 이미 있음: 충전기/);
});

test('준비물 날짜가 모호하면 저장하지 않고 되물음 — 글은 T1 화면에, 음성은 ask로 (Live가 소리로 물음), 같은 대화에서 되풀이하지 않음', async () => {
  const vague = withItems([{ title: '우산', date: '' }]);
  const { fake, deps, sid, rev, db } = await start({ T2F: [vague, vague], T1: [T1_OK] });
  const r = (await handleVoiceTurn(deps, text(sid, rev, '우산 챙겨야 하는데'))) as VoiceTurnOut;
  assert.equal(db.rows('todos').length, 0);
  assert.match(fake.seen.T1[0], /'우산' 챙길 날짜/);
  const v = (await handleVoiceTurn(deps, voiceTurn(sid, r.rev, '우산 챙겨야 하는데 언제였더라', '우산 챙기셔야 하는군요.'))) as VoiceTurnOut;
  assert.equal(v.ask, undefined);
  const b = await start({ T2F: [vague], T1: [] });
  const v2 = (await handleVoiceTurn(b.deps, voiceTurn(b.sid, b.rev, '우산 챙겨야 해', '네.'))) as VoiceTurnOut;
  assert.deepEqual(v2.ask, ["'우산' 챙길 날짜"]);
});

test('준비물: 지난 날짜는 넣지 않음 · 저장이 실패해도 대화는 이어짐', async () => {
  const { deps, sid, rev, db } = await start({ T2F: [withItems([{ title: '노트북', date: '2026-10-28' }])], T1: [T1_OK] });
  const r = (await handleVoiceTurn(deps, text(sid, rev, '어제 노트북 챙겼어야 했는데'))) as VoiceTurnOut;
  assert.equal(db.rows('todos').length, 0);
  assert.ok(r.reply?.text);
  const b = await start({ T2F: [withItems([{ title: '노트북', date: '2026-10-30' }])], T1: [T1_OK] });
  const from = b.db.from.bind(b.db);
  (b.db as unknown as { from: (t: string) => unknown }).from = (t: string) => {
    if (t === 'todos') throw new Error('db down');
    return from(t);
  };
  const r2 = (await handleVoiceTurn(b.deps, text(b.sid, b.rev, '내일 노트북 챙겨야 돼'))) as VoiceTurnOut;
  assert.ok(r2.reply?.text);
});

test('영어 일정 등록: "team meeting next Monday at 10am at the library" → APPT_NEW 카드, 영어 말도 일정일 수도 있는 말', async () => {
  const { deps, sid, rev } = await start({ T2F: [appt({ title: 'team meeting', date: '2026-11-02', time: '10:00', place: 'library' })], T1: [] });
  const msg = 'I have a team meeting next Monday at 10am at the library. Please add it.';
  const r = (await handleVoiceTurn(deps, text(sid, rev, msg))) as VoiceTurnOut;
  assert.equal(r.next, 'APP_TASKS');
  const c = r.cards[0];
  assert.deepEqual([c.kind, c.draft?.title, c.draft?.date, c.draft?.time, c.draft?.place], ['APPT_NEW', 'team meeting', '2026-11-02', '10:00', 'library']);
  assert.equal(mightBeSchedule(msg), true);
  assert.equal(mightBeSchedule('I need to bring my charger tomorrow'), true);
  assert.equal(mightBeSchedule('I feel tired today'), false);
});

test('영어 일정 추출 시간 초과도 [다시 시도] 안내(extract_failed)', async () => {
  const { fake, deps, sid, rev } = await start({ T2F: [timeout()], T1: [] });
  await assert.rejects(handleVoiceTurn(deps, text(sid, rev, 'Dentist appointment tomorrow at 3pm')), (e: HttpError) => (e.details as { extract_failed?: boolean }).extract_failed === true);
  assert.deepEqual(fake.order, ['T2F']);
});

test('준비물 말도 일정일 수도 있는 말로 봄 (추출 실패면 [다시 시도])', () => {
  assert.equal(mightBeSchedule('나가기 전에 충전기 가져가야 해'), true);
  assert.equal(mightBeSchedule('내일 노트북 챙겨야 돼'), true);
});

// ───────── 나가기 전 할 일 → 계산된 기상 확인 (2026-11-19 팀 결정) — 음성(Live) · 글 같은 길 ─────────
//   T2F.v2-e가 pre_tasks · wake_reply를 뽑음. 계산 결과(results) 뒤 기상 질문을 ask로 돌려줌 → 앱이 Live에 넣어 소리로 물음
const withTask = (over: Record<string, unknown> = {}) => ({ ...appt(), pre_tasks: [{ title: '과제' }], ...over });

test('음성: 일정 + 할 일 → 계산 뒤 기상 질문을 ask로(저장 확인은 미룸) → "6시 반에 일어날게"면 기상만 바꿔 다시 계산', async () => {
  const { deps, sid, rev } = await start({
    T2F: [withTask(), withTask({ wake_reply: { choice: 'TIME', time: '06:30' } })],
    T1: [T1_OK, T1_OK],
  });
  const t1 = voiceTurn(sid, rev, '내일 2시에 산책 있는데 나가기 전에 과제 해야 돼', '알겠어요.');
  const r1 = (await handleVoiceTurn(deps, t1)) as VoiceTurnOut;
  assert.equal(r1.next, 'APP_TASKS');
  assert.deepEqual(r1.cards.map((c) => [c.kind, c.pre_task]), [['APPT_NEW', { title: '과제', wake: 'ASK', time: null }]]);
  const r1b = (await handleVoiceTurn(deps, results(sid, r1.rev, t1.client_turn_id))) as VoiceTurnOut;
  assert.equal(r1b.cards[0].status, 'READY');
  assert.deepEqual(r1b.ask, ["'산책' 기상 알람이 07:40으로 계산됨 — 나가기 전 할 일(과제)이 있다고 했으니 이 시각에 일어날지, 몇 시에 일어날지"]);
  const t2 = voiceTurn(sid, r1b.rev, '6시 반에 일어날게', '좋아요.');
  const r2 = (await handleVoiceTurn(deps, t2)) as VoiceTurnOut;
  assert.equal(r2.next, 'APP_TASKS');
  assert.equal(r2.cards.length, 1); // 같은 카드 — 새 카드 없음
  assert.deepEqual([r2.cards[0].pre_task, r2.cards[0].edit?.times], [{ title: '과제', wake: 'SET', time: '06:30' }, { WAKE: '2026-10-30T06:30:00+09:00' }]);
});

test('글: 같은 흐름 — 계산 뒤 T1이 글로 묻고(ask는 함께 오지만 글 화면은 안 씀), 시각 없는 답은 다시 물음', async () => {
  const { fake, deps, sid, rev } = await start({
    T2F: [withTask(), withTask({ wake_reply: { choice: 'VAGUE', time: '' } })],
    T1: [T1_OK, T1_OK],
  });
  const t1 = text(sid, rev, '내일 2시에 산책 있는데 나가기 전에 과제 해야 돼');
  const r1 = (await handleVoiceTurn(deps, t1)) as VoiceTurnOut;
  const r1b = (await handleVoiceTurn(deps, results(sid, r1.rev, t1.client_turn_id))) as VoiceTurnOut;
  assert.ok(r1b.reply?.text);
  assert.match(r1b.ask?.[0] ?? '', /07:40으로 계산됨/);
  const r2 = (await handleVoiceTurn(deps, text(sid, r1b.rev, '좀 일찍 일어날게'))) as VoiceTurnOut;
  assert.equal(r2.next, 'USER');
  assert.deepEqual([r2.cards[0].pre_task?.wake, r2.cards[0].edit], ['ASK', null]);
  assert.deepEqual(fake.order, ['T2F', 'T1', 'T2F', 'T1']);
});

// ───────── 11/20 회귀: "나가기 전에 뭐 좀 해야 돼" 뒤 T1이 기상 대신 준비물을 물음 → 서버가 기상 질문으로 바꿈 ─────────
//   기상 시각은 시험 계산 결과(wake_0740: 기상 07:40 · 준비 07:50 · 출발 08:50) 그대로
const INCIDENT = '내일 1시에 수업이 있어. 아 근데 나가기 전에 뭐 좀 해야 돼.';
const lecture = (over: Record<string, unknown> = {}) => ({ ...appt({ title: '수업', time: '13:00', place: '세종대학교' }), pre_tasks: [{ title: '할 일' }], ...over });
const T1_ITEMS = { reply: '수업 준비물도 따로 챙기실 게 있나요?', acts: [{ type: 'REFLECT', ref: null }], end: false };
const WAKE_ASK = '수업 전에 할 일이 있으시군요. 추천 기상 시각은 오전 7시 40분인데, 그대로 일어나실 건가요, 더 일찍 일어나실 건가요?';
const lastAi = (db: FakeDb) => (db.rows('conversation_sessions')[0] as { turns: { role: string; guard?: string[] }[] }).turns.filter((t) => t.role === 'ai').at(-1);

test('회귀 1: 실제 발화 — 장소 고르기 뒤 계산이 끝나면 T1이 준비물을 물어도 기상 질문이 나가고, 답 전엔 저장 안 됨', async () => {
  const { db, deps, sid, rev } = await start({ T2F: [lecture()], T1: [{ reply: '수업 장소는 카드의 장소 고르기를 눌러 주세요.', acts: [{ type: 'CLARIFY', ref: null }], end: false }, T1_ITEMS] });
  const t1 = text(sid, rev, INCIDENT);
  const r1 = (await handleVoiceTurn(deps, t1)) as VoiceTurnOut;
  assert.deepEqual([r1.next, r1.cards.map((c) => [c.kind, c.draft?.title, c.pre_task])], ['APP_TASKS', [['APPT_NEW', '수업', { title: '할 일', wake: 'ASK', time: null }]]]);
  const r2 = (await handleVoiceTurn(deps, needsPlace(sid, r1.rev, t1.client_turn_id, '세종대학교'))) as VoiceTurnOut;
  assert.equal(r2.cards[0].status, 'NEEDS_PLACE');
  // 사용자가 장소를 고름 → 앱이 새 client_turn_id로 results만
  const r3 = (await handleVoiceTurn(deps, results(sid, r2.rev, cid()))) as VoiceTurnOut;
  assert.deepEqual([r3.reply?.text, r3.reply?.acts], [WAKE_ASK, [{ type: 'CLARIFY', ref: null }]]);
  assert.ok(lastAi(db)?.guard?.includes('ask_wake'));
  assert.match(r3.ask?.[0] ?? '', /07:40으로 계산됨/); // 음성이면 Live로
  assert.deepEqual([r3.cards[0].status, r3.cards[0].pre_task?.wake], ['READY', 'ASK']); // 저장(SAVED) 아님
});

test('회귀 1-1: T1이 기상 시각을 제대로 물으면 그 답을 그대로 둠', async () => {
  const own = { reply: '추천 기상 시각은 오전 7시 40분인데, 그대로 일어나실 건가요?', acts: [{ type: 'CLARIFY', ref: null }], end: false };
  const { db, deps, sid, rev } = await start({ T2F: [lecture()], T1: [own] });
  const t1 = text(sid, rev, INCIDENT);
  const r1 = (await handleVoiceTurn(deps, t1)) as VoiceTurnOut;
  const r2 = (await handleVoiceTurn(deps, results(sid, r1.rev, t1.client_turn_id))) as VoiceTurnOut;
  assert.equal(r2.reply?.text, own.reply);
  assert.ok(!lastAi(db)?.guard?.includes('ask_wake'));
});

test('회귀 2: "7시에 일어날래" — 기상만 07:00으로, 준비 · 출발은 그대로(앱 재계산에 WAKE만 넘김)', async () => {
  const { deps, sid, rev } = await start({ T2F: [lecture(), lecture({ wake_reply: { choice: 'TIME', time: '07:00' } })], T1: [T1_ITEMS] });
  const t1 = text(sid, rev, INCIDENT);
  const r1 = (await handleVoiceTurn(deps, t1)) as VoiceTurnOut;
  const r1b = (await handleVoiceTurn(deps, results(sid, r1.rev, t1.client_turn_id))) as VoiceTurnOut;
  const r2 = (await handleVoiceTurn(deps, text(sid, r1b.rev, '7시에 일어날래'))) as VoiceTurnOut;
  assert.equal(r2.next, 'APP_TASKS');
  assert.deepEqual([r2.cards[0].pre_task, r2.cards[0].edit?.times], [{ title: '할 일', wake: 'SET', time: '07:00' }, { WAKE: '2026-10-30T07:00:00+09:00' }]);
});

test('회귀 3: "그대로 일어날게" — 계산된 기상 유지, 저장 확인으로 넘어감(기상 질문 다시 안 함)', async () => {
  const { deps, sid, rev } = await start({ T2F: [lecture(), lecture({ wake_reply: { choice: 'KEEP', time: '' } })], T1: [T1_ITEMS, T1_OK] });
  const t1 = text(sid, rev, INCIDENT);
  const r1 = (await handleVoiceTurn(deps, t1)) as VoiceTurnOut;
  const r1b = (await handleVoiceTurn(deps, results(sid, r1.rev, t1.client_turn_id))) as VoiceTurnOut;
  const r2 = (await handleVoiceTurn(deps, text(sid, r1b.rev, '그대로 일어날게'))) as VoiceTurnOut;
  assert.deepEqual([r2.next, r2.cards[0].status, r2.cards[0].pre_task?.wake, r2.cards[0].edit], ['USER', 'READY', 'KEEP', null]);
  assert.notEqual(r2.reply?.text, WAKE_ASK);
});

test('회귀 4: 할 일이 없으면 기상 질문 없이 기존 흐름 (T1 답 그대로)', async () => {
  const { db, deps, sid, rev } = await start({ T2F: [appt({ title: '수업', time: '13:00', place: '세종대학교' })], T1: [T1_ITEMS] });
  const t1 = text(sid, rev, '내일 1시에 수업 있어.');
  const r1 = (await handleVoiceTurn(deps, t1)) as VoiceTurnOut;
  const r2 = (await handleVoiceTurn(deps, results(sid, r1.rev, t1.client_turn_id))) as VoiceTurnOut;
  assert.deepEqual([r2.reply?.text, r2.ask, r2.cards[0].pre_task], [T1_ITEMS.reply, undefined, null]);
  assert.ok(!lastAi(db)?.guard?.includes('ask_wake'));
});

test('회귀 5: 과제는 할 일, 노트북은 준비물 — 기상 질문이 먼저, 준비물은 한 번만 저장', async () => {
  const both = lecture({ pre_tasks: [{ title: '과제' }], items: [{ title: '노트북', date: '2026-10-30' }] });
  const { db, deps, sid, rev } = await start({ T2F: [both, both], T1: [T1_ITEMS, T1_OK] });
  const t1 = text(sid, rev, '내일 수업 전에 과제 좀 하고 노트북도 챙겨야 돼.');
  const r1 = (await handleVoiceTurn(deps, t1)) as VoiceTurnOut;
  assert.deepEqual(r1.cards.map((c) => [c.draft?.title, c.pre_task?.title]), [['수업', '과제']]);
  const r1b = (await handleVoiceTurn(deps, results(sid, r1.rev, t1.client_turn_id))) as VoiceTurnOut;
  assert.equal(r1b.reply?.text, WAKE_ASK);
  await handleVoiceTurn(deps, text(sid, r1b.rev, '노트북 챙겨야 돼'));
  assert.deepEqual(db.rows('todos').map((t) => [t.title, t.todo_type]), [['노트북', 'ITEM']]);
});

test('회귀 6: 음성(Live) — 장소 고르기 뒤 results에도 기상 질문이 ask로 옴 (글과 같은 서버 문구)', async () => {
  const { deps, sid, rev } = await start({ T2F: [lecture()], T1: [T1_OK, T1_ITEMS] });
  const t1 = voiceTurn(sid, rev, INCIDENT, '알겠어요.');
  const r1 = (await handleVoiceTurn(deps, t1)) as VoiceTurnOut;
  const r2 = (await handleVoiceTurn(deps, needsPlace(sid, r1.rev, t1.client_turn_id, '세종대학교'))) as VoiceTurnOut;
  assert.equal(r2.ask?.some((l) => l.includes('기상')) ?? false, false);
  const r3 = (await handleVoiceTurn(deps, results(sid, r2.rev, cid()))) as VoiceTurnOut;
  assert.deepEqual(r3.ask, ["'수업' 기상 알람이 07:40으로 계산됨 — 나가기 전 할 일(할 일)이 있다고 했으니 이 시각에 일어날지, 몇 시에 일어날지"]);
  assert.equal(r3.reply?.text, WAKE_ASK);
});

test('회귀 7 (PR #580 리뷰): T1이 기상 시각을 말했지만 준비물을 물으면 기상 질문으로 바꿈', async () => {
  const sneaky = { reply: '출발은 오전 7시 40분이 좋아요. 준비물도 있나요?', acts: [{ type: 'REFLECT', ref: null }], end: false };
  const { db, deps, sid, rev } = await start({ T2F: [lecture()], T1: [sneaky] });
  const t1 = text(sid, rev, INCIDENT);
  const r1 = (await handleVoiceTurn(deps, t1)) as VoiceTurnOut;
  const r2 = (await handleVoiceTurn(deps, results(sid, r1.rev, t1.client_turn_id))) as VoiceTurnOut;
  assert.equal(r2.reply?.text, `출발은 오전 7시 40분이 좋아요. ${WAKE_ASK}`);
  assert.ok(lastAi(db)?.guard?.includes('ask_wake'));
  assert.match(r2.ask?.[0] ?? '', /07:40으로 계산됨/); // Live 전달은 그대로
});
