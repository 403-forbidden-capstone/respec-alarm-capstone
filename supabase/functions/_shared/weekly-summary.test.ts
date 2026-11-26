// weekly-summary 시험 — 가짜 모델 · 가짜 DB만 씀. 네트워크 · 키 · 비용 0.
//   기록 0 · 1 · 3 · 7일, 같은 기록이면 다시 안 부름, 추가 · 수정 · 삭제면 다시 만듦, 주차가 바뀌어도 지난 주 요약 유지, 실패 · 한도, 동시 요청은 한 번만
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LlmClientError, type LlmClient, type LlmRequest, type LlmResponse } from './ai/llm.ts';
import { HttpError } from './errors.ts';
import { FakeDb } from './fake-db.ts';
import type { Db } from './supabase.ts';
import { handleWeeklySummary, journalText, parseRequest, WEEKLY_SUMMARY_POINT, WEEKLY_SUMMARY_USER_PER_DAY } from './weekly-summary.ts';

const ME = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-26T21:00:00+09:00'); // 목요일
const WEEK = '2026-11-23'; // 그 주 월요일
const PREV = '2026-11-16';

function fakeModel() {
  const seen: LlmRequest[] = [];
  let fail = false;
  let gate: Promise<void> | null = null; // 있으면 모델 답을 이 약속이 끝날 때까지 늦춤 (동시 요청 시험)
  const client: LlmClient = {
    async create(params): Promise<LlmResponse> {
      seen.push(params);
      if (gate) await gate;
      if (fail) throw new LlmClientError('server', 'fake 5xx', { status: 500 });
      return {
        content: [{ type: 'text', text: JSON.stringify({ summary: `**요약 ${seen.length}**  이번 주 기록을 돌아봤어요.` }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 300, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        model: 'gemini-3.5-flash-lite',
        request_id: `req_ws_${seen.length}`,
      };
    },
  };
  return { client, seen, failNext: (v: boolean) => void (fail = v), hold: (p: Promise<void> | null) => void (gate = p) };
}

// claim_weekly_summary 흉내 (마이그레이션 20261126120000 — 줄이 없으면 잠금만 든 줄, 잠금이 비었거나 지났으면 잡음)
function withClaimRpc(db: FakeDb) {
  db.rpcHandlers.claim_weekly_summary = (a) => {
    const rows = db.rows('weekly_summaries');
    const until = new Date(Date.now() + Number(a.p_seconds) * 1000).toISOString();
    const row = rows.find((r) => r.user_id === a.p_user_id && r.week_start === a.p_week_start);
    if (!row) {
      rows.push({ user_id: a.p_user_id, week_start: a.p_week_start, input_hash: null, summary: null, day_dates: null, model: null, generated_at: null, claimed_until: until });
      return true;
    }
    if (row.claimed_until && Date.parse(row.claimed_until as string) >= Date.now()) return false;
    row.claimed_until = until;
    return true;
  };
}

function setup() {
  const db = new FakeDb();
  db.now = NOW;
  withClaimRpc(db);
  const model = fakeModel();
  const sleep = () => new Promise<void>((done) => setTimeout(done, 1));
  const deps = { userId: ME, userDb: db as unknown as Db, service: db as unknown as Db, llm: model.client as LlmClient | null, model: 'gemini-3.5-flash-lite', now: () => NOW, sleep };
  const journal = (date: string, text: string | null, edited?: string) =>
    db.rows('daily_journals').push({ journal_id: `j-${date}`, user_id: ME, record_date: date, ai_summary: text, edited_summary: edited ?? null, is_edited: edited !== undefined });
  const run = (weekStart = WEEK) => handleWeeklySummary(deps, { week_start: weekStart });
  const userInput = (i = model.seen.length - 1) => JSON.parse(model.seen[i].messages[0].content as string) as { recorded_day_count: number; missing_dates: string[]; days: { date: string; text: string }[] };
  return { db, model, deps, journal, run, userInput };
}

const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

describe('weekly-summary — 기록 일수', () => {
  it('0일: 모델을 안 부르고 summary null', async () => {
    const t = setup();
    const r = await t.run();
    assert.deepEqual(r, { week_start: WEEK, week_end: '2026-11-29', dates: [], summary: null, generated_at: null, stale: false });
    assert.equal(t.model.seen.length, 0);
    assert.equal(t.db.rows('weekly_summaries').length, 0);
  });

  it('1일: 그날 글만 보내고 나머지 6일은 비었다고 알림 · 기상 기록 없이도 만듦', async () => {
    const t = setup();
    t.journal('2026-11-25', '팀플 회의를 하고 일찍 잤다.');
    const r = await t.run();
    assert.equal(t.model.seen.length, 1);
    assert.deepEqual(r.dates, ['2026-11-25']);
    assert.equal(r.summary, '요약 1 이번 주 기록을 돌아봤어요.'); // 마크다운 · 겹친 공백 정리
    const input = t.userInput();
    assert.equal(input.recorded_day_count, 1);
    assert.deepEqual(input.days.map((d) => d.date), ['2026-11-25']);
    assert.equal(input.missing_dates.length, 6);
    assert.equal(t.db.rows('ai_calls').filter((c) => c.point === WEEKLY_SUMMARY_POINT && c.io == null).length, 1);
  });

  it('3일: 글이 빈 일기는 빼고, 고친 일기는 고친 글로', async () => {
    const t = setup();
    t.journal('2026-11-23', '월요일 일기');
    t.journal('2026-11-24', '   ');
    t.journal('2026-11-26', 'AI 원본', '내가 고친 글');
    t.journal('2026-11-27', '금요일 일기');
    const r = await t.run();
    assert.deepEqual(r.dates, ['2026-11-23', '2026-11-26', '2026-11-27']);
    assert.deepEqual(t.userInput().days.map((d) => d.text), ['월요일 일기', '내가 고친 글', '금요일 일기']);
    assert.equal(t.userInput().recorded_day_count, 3);
  });

  it('7일: 빈 날 없음', async () => {
    const t = setup();
    for (const d of days(WEEK, 7)) t.journal(d, `${d} 일기`);
    const r = await t.run();
    assert.equal(r.dates.length, 7);
    assert.deepEqual(t.userInput().missing_dates, []);
  });

  it('주 밖의 일기는 안 셈', async () => {
    const t = setup();
    t.journal('2026-11-22', '지난 일요일');
    t.journal('2026-11-30', '다음 월요일');
    t.journal('2026-11-29', '이번 일요일');
    assert.deepEqual((await t.run()).dates, ['2026-11-29']);
  });
});

describe('weekly-summary — 갱신과 캐시', () => {
  it('기록이 그대로면 다시 안 부름', async () => {
    const t = setup();
    t.journal('2026-11-24', '화요일');
    const a = await t.run();
    const b = await t.run();
    assert.equal(t.model.seen.length, 1);
    assert.deepEqual(b, a);
  });

  it('추가 · 수정 · 삭제마다 다시 만들고, 모두 지우면 요약도 지움', async () => {
    const t = setup();
    t.journal('2026-11-24', '화요일');
    await t.run();
    t.journal('2026-11-25', '수요일'); // 추가
    assert.deepEqual((await t.run()).dates, ['2026-11-24', '2026-11-25']);
    const tue = t.db.rows('daily_journals').find((j) => j.record_date === '2026-11-24')!;
    Object.assign(tue, { edited_summary: '화요일 고침', is_edited: true }); // 수정
    await t.run();
    assert.equal(t.userInput().days[0].text, '화요일 고침');
    t.db.tables.daily_journals = t.db.rows('daily_journals').filter((j) => j.record_date !== '2026-11-25'); // 삭제
    assert.deepEqual((await t.run()).dates, ['2026-11-24']);
    assert.equal(t.model.seen.length, 4);
    t.db.tables.daily_journals = [];
    const empty = await t.run();
    assert.equal(empty.summary, null);
    assert.equal(t.db.rows('weekly_summaries').length, 0);
    assert.equal(t.model.seen.length, 4);
  });

  it('주차가 바뀌어도 지난 주 요약은 남고, 다시 보면 부르지 않음', async () => {
    const t = setup();
    t.journal('2026-11-17', '지난주 화요일');
    const prev = await t.run(PREV);
    t.journal('2026-11-24', '이번 주 화요일');
    const cur = await t.run(WEEK);
    assert.equal(t.db.rows('weekly_summaries').length, 2);
    const again = await t.run(PREV);
    assert.deepEqual(again, prev);
    assert.notEqual(cur.summary, prev.summary);
    assert.equal(t.model.seen.length, 2);
  });
});

describe('weekly-summary — 실패', () => {
  it('모델 실패: 저장된 요약이 있으면 stale로, 없으면 LLM_UNAVAILABLE', async () => {
    const t = setup();
    t.journal('2026-11-24', '화요일');
    t.model.failNext(true);
    await assert.rejects(t.run(), (e) => e instanceof HttpError && e.code === 'LLM_UNAVAILABLE');
    t.model.failNext(false);
    const ok = await t.run();
    t.journal('2026-11-25', '수요일');
    t.model.failNext(true);
    const stale = await t.run();
    assert.deepEqual({ ...stale, stale: false }, ok);
    assert.equal(stale.stale, true);
  });

  it('하루 한도를 넘으면 부르지 않음', async () => {
    const t = setup();
    t.journal('2026-11-24', '화요일');
    for (let i = 0; i < WEEKLY_SUMMARY_USER_PER_DAY; i++) t.db.rows('ai_calls').push({ call_id: `c${i}`, user_id: ME, point: WEEKLY_SUMMARY_POINT, created_at: NOW.toISOString() });
    await assert.rejects(t.run(), (e) => e instanceof HttpError && e.code === 'RATE_LIMITED');
    assert.equal(t.model.seen.length, 0);
  });

  it('키 없음: NOT_CONFIGURED', async () => {
    const t = setup();
    t.deps.llm = null;
    t.journal('2026-11-24', '화요일');
    await assert.rejects(t.run(), (e) => e instanceof HttpError && e.code === 'NOT_CONFIGURED');
  });
});

describe('weekly-summary — 동시 요청', () => {
  it('같은 주를 동시에 3번 요청해도 Gemini는 한 번, 모두 같은 글', async () => {
    const t = setup();
    t.journal('2026-11-24', '화요일');
    let open!: () => void;
    t.model.hold(new Promise<void>((done) => (open = done)));
    const all = Promise.all([t.run(), t.run(), t.run()]);
    await new Promise((done) => setTimeout(done, 20)); // 셋 다 잠금 단계까지 감
    open();
    const [a, b, c] = await all;
    assert.equal(t.model.seen.length, 1);
    assert.deepEqual([b, c], [a, a]);
    assert.equal(a.stale, false);
    assert.equal(t.db.rows('weekly_summaries')[0].claimed_until, null); // 저장하며 잠금도 풂
  });

  it('잠금을 잡은 요청이 실패하면 기다린 요청은 CONFLICT(저장된 글이 없을 때), 잠금은 풀려 다음 요청이 바로 만듦', async () => {
    const t = setup();
    t.journal('2026-11-24', '화요일');
    let open!: () => void;
    t.model.hold(new Promise<void>((done) => (open = done)));
    t.model.failNext(true);
    const first = t.run().then(() => 'ok', (e: HttpError) => e.code);
    const second = t.run().then(() => 'ok', (e: HttpError) => e.code);
    await new Promise((done) => setTimeout(done, 20));
    open();
    assert.deepEqual(await Promise.all([first, second]), ['LLM_UNAVAILABLE', 'CONFLICT']);
    const calls = () => t.db.rows('ai_calls').filter((c) => c.point === WEEKLY_SUMMARY_POINT).length;
    assert.equal(calls(), 1); // 실패한 요청의 호출 한 줄 (5xx 다시 시도는 그 안의 시도)
    t.model.hold(null);
    t.model.failNext(false);
    assert.equal((await t.run()).dates.length, 1);
    assert.equal(calls(), 2);
  });

  it('남의 주 · 다른 주는 잠금이 따로', async () => {
    const t = setup();
    t.journal('2026-11-17', '지난주');
    t.journal('2026-11-24', '이번 주');
    const [prev, cur] = await Promise.all([t.run(PREV), t.run(WEEK)]);
    assert.equal(t.model.seen.length, 2);
    assert.deepEqual([prev.dates, cur.dates], [['2026-11-17'], ['2026-11-24']]);
  });
});

describe('weekly-summary — 요청 · 글 규칙', () => {
  it('월요일 YYYY-MM-DD만 받음', () => {
    assert.equal(parseRequest({ week_start: WEEK }), WEEK);
    for (const bad of [{ week_start: '2026-11-24' }, { week_start: '2026-02-30' }, { week_start: '11/23' }, {}]) {
      assert.throws(() => parseRequest(bad), (e) => e instanceof HttpError && e.code === 'VALIDATION_FAILED');
    }
  });

  it('journalText — 고쳤을 때만 고친 글', () => {
    assert.equal(journalText({ record_date: WEEK, ai_summary: ' AI ', edited_summary: null, is_edited: false }), 'AI');
    assert.equal(journalText({ record_date: WEEK, ai_summary: 'AI', edited_summary: '고침', is_edited: true }), '고침');
    assert.equal(journalText({ record_date: WEEK, ai_summary: 'AI', edited_summary: '남은 글', is_edited: false }), 'AI');
  });
});
