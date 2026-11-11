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
