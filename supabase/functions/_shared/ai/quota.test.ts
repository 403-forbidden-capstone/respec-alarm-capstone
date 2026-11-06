// 사용량 관문 시험 — 순수 판정 · 관문(자리 잡기 · 놓기) · ai_calls에서 사용량 읽기 · callLlm이 막힌 호출을 보내지 않음. 네트워크 없음
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeDb } from '../fake-db.ts';
import type { Db } from '../supabase.ts';
import { seoulIso } from './context.ts';
import { callLlm, type CallOpts, type LlmClient } from './llm.ts';
import { CALL_TOKENS_GUESS, checkQuota, DEFAULT_QUOTA, inFlightNow, promptTokensOf, QuotaGate, quotaFromEnv, readUsage, type Usage } from './quota.ts';

const LIMITS = { rpm: 10, tpm: 1000, rpd: 100, concurrency: 2 };
const use = (u: Partial<Usage> = {}): Usage => ({ minuteRequests: 0, minuteTokens: 0, dayRequests: 0, callTokens: 100, ...u });

describe('checkQuota', () => {
  it('여유가 있으면 통과', () => assert.deepEqual(checkQuota(LIMITS, use(), 0, 2), { ok: true }));
  it('하루 한도가 먼저 (1분 한도도 넘었어도 RPD)', () => {
    const v = checkQuota(LIMITS, use({ dayRequests: 99, minuteRequests: 10 }), 0, 2);
    assert.equal(v.ok === false && v.scope, 'RPD');
  });
  it('1분 요청 · 1분 토큰 · 동시 요청', () => {
    assert.equal((checkQuota(LIMITS, use({ minuteRequests: 9 }), 0, 2) as { scope: string }).scope, 'RPM');
    assert.equal((checkQuota(LIMITS, use({ minuteTokens: 1000 }), 0, 1) as { scope: string }).scope, 'TPM');
    assert.equal((checkQuota(LIMITS, use(), 2, 1) as { scope: string }).scope, 'CONCURRENCY');
  });
  it('TPM은 보내기 전에 어림(need × 한 번 토큰)까지 더해서 넘을 것 같으면 막음', () => {
    // 지금 800 + 2번 × 100 = 1000 → 딱 한도라 통과, 3번이면 1100 → 막음
    assert.deepEqual(checkQuota(LIMITS, use({ minuteTokens: 800 }), 0, 2), { ok: true });
    assert.equal((checkQuota(LIMITS, use({ minuteTokens: 800 }), 0, 3) as { scope: string }).scope, 'TPM');
  });
  it('0이면 그 한도는 끔', () => assert.deepEqual(checkQuota({ rpm: 0, tpm: 0, rpd: 0, concurrency: 0 }, use({ minuteRequests: 1e6, dayRequests: 1e6, minuteTokens: 1e9 }), 99, 5), { ok: true }));
});

describe('quotaFromEnv', () => {
  it('기본값 = 작업자가 정한 보수적 값 (RPM 8 · TPM 200,000 · RPD 300 · 동시 4)', () => {
    assert.deepEqual(DEFAULT_QUOTA, { rpm: 8, tpm: 200_000, rpd: 300, concurrency: 4 });
  });
  it('비우면 기본값, 숫자가 아니거나 음수면 기본값, 0은 끔', () => {
    assert.deepEqual(quotaFromEnv(() => undefined), DEFAULT_QUOTA);
    const set: Record<string, string> = { AI_LIMIT_RPM: '8', AI_LIMIT_TPM: '200000', AI_LIMIT_RPD: '300' };
    assert.deepEqual(quotaFromEnv((n) => set[n]), { rpm: 8, tpm: 200_000, rpd: 300, concurrency: DEFAULT_QUOTA.concurrency });
    const env: Record<string, string> = { AI_LIMIT_RPM: '15', AI_LIMIT_TPM: 'abc', AI_LIMIT_RPD: '-3', AI_LIMIT_CONCURRENCY: '0' };
    assert.deepEqual(quotaFromEnv((n) => env[n]), { rpm: 15, tpm: DEFAULT_QUOTA.tpm, rpd: DEFAULT_QUOTA.rpd, concurrency: 0 });
  });
});

describe('QuotaGate', () => {
  it('이 요청이 보낸 호출은 토큰도 어림으로 더함 — TPM이 한 요청 안에서 쌓이는 것도 막음', async () => {
    const gate = new QuotaGate({ rpm: 0, rpd: 0, concurrency: 0, tpm: 1000 }, async () => use({ minuteTokens: 700, callTokens: 100 }));
    for (let i = 0; i < 3; i++) {
      assert.equal((await gate.acquire()).ok, true, `${i + 1}번째`); // 800 · 900 · 1000
      gate.release();
    }
    const v = await gate.acquire(); // 1100 > 1000
    assert.equal(v.ok === false && v.scope, 'TPM');
  });

  it('사용량은 한 번만 읽고, 이 요청이 보낸 수를 더해 감 (ai_calls는 요청이 끝나야 기록되므로)', async () => {
    let reads = 0;
    const gate = new QuotaGate({ ...LIMITS, rpm: 3 }, async () => {
      reads++;
      return use({ minuteRequests: 1 });
    });
    assert.equal((await gate.acquire()).ok, true);
    gate.release();
    assert.equal((await gate.acquire()).ok, true);
    gate.release();
    const third = await gate.acquire();
    assert.equal(third.ok === false && third.scope, 'RPM');
    assert.equal(reads, 1);
  });

  it('동시 요청 자리는 release로 돌려줌, 막힌 acquire는 자리를 잡지 않음', async () => {
    const start = inFlightNow();
    const gate = new QuotaGate({ ...LIMITS, rpm: 0, concurrency: start + 1 }, async () => use());
    assert.equal((await gate.acquire()).ok, true);
    assert.equal(inFlightNow(), start + 1);
    assert.equal((await gate.acquire()).ok, false);
    assert.equal(inFlightNow(), start + 1);
    gate.release();
    gate.release(); // 잡지 않은 자리는 놓지 않음
    assert.equal(inFlightNow(), start);
  });

  it('사용량을 못 읽으면 막지 않음 (기록 실패로 대화가 멈추지 않게)', async () => {
    const gate = new QuotaGate(DEFAULT_QUOTA, async () => {
      throw new Error('db down');
    });
    const orig = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(await gate.check(2), { ok: true });
    } finally {
      console.error = orig;
    }
  });
});

describe('readUsage', () => {
  it('TPM 토큰 = Google promptTokenCount (input_tokens는 캐시를 뺀 값이라 cache_read_tokens를 다시 더함), 출력은 안 셈', () => {
    assert.equal(promptTokensOf({ input_tokens: 1480, cache_read_tokens: 3282 }), 4762);
    assert.equal(promptTokensOf({ input_tokens: 100, cache_read_tokens: null }), 100);
    assert.equal(promptTokensOf({ input_tokens: null, cache_read_tokens: null }), null); // 응답 없음(실패 · 막힘)
  });

  it('기록이 없으면 한 번 토큰은 어림값', async () => {
    assert.equal((await readUsage(new FakeDb() as unknown as Db, Date.now())).callTokens, CALL_TOKENS_GUESS);
  });

  it('최근 24시간 Gemini 줄만 — 1분 안은 요청 · 입력 토큰, 하루는 요청(attempts 합). Claude · 막힌 호출(attempts 0)은 안 셈', async () => {
    const now = new Date('2026-11-06T21:00:00+09:00').getTime();
    const at = (msAgo: number) => seoulIso(new Date(now - msAgo));
    const db = new FakeDb();
    db.rows('ai_calls').push(
      { model: 'gemini-3.5-flash-lite', attempts: 1, input_tokens: 100, cache_read_tokens: 300, output_tokens: 20, created_at: at(10_000) },
      { model: 'gemini-3.5-flash-lite', attempts: 2, input_tokens: 50, cache_read_tokens: 0, output_tokens: 5, created_at: at(30_000) },
      { model: 'gemini-3.5-flash-lite', attempts: 0, input_tokens: null, cache_read_tokens: null, output_tokens: null, created_at: at(5_000) }, // 관문이 막음
      { model: 'gemini-3.5-flash-lite', attempts: 1, input_tokens: 950, cache_read_tokens: 0, output_tokens: 1, created_at: at(3600_000) }, // 1시간 전
      { model: 'gemini-3.5-flash-lite', attempts: 1, input_tokens: 1, cache_read_tokens: 0, output_tokens: 1, created_at: at(25 * 3600_000) }, // 하루 넘음
      { model: 'claude-haiku-5-5', attempts: 1, input_tokens: 500, cache_read_tokens: 0, output_tokens: 50, created_at: at(1_000) }, // 시간표 사진
    );
    // 1분: 요청 1 + 2 = 3, 입력 토큰 400 + 50 = 450 (출력 20 · 5는 안 셈) / 하루: 요청 4 / 한 번 토큰: (400 + 50 + 950) / 3 ≈ 467
    assert.deepEqual(await readUsage(db as unknown as Db, now), { minuteRequests: 3, minuteTokens: 450, dayRequests: 4, callTokens: 467 });
  });
});

describe('callLlm + 관문', () => {
  const opts = (gate: CallOpts['gate']): CallOpts => ({
    point: 'T1', promptId: 'T1', promptVersion: 'v', model: 'gemini-3.5-flash-lite', system: 's', user: 'u',
    schema: { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false },
    effort: 'low', maxTokens: 64, timeoutMs: 1000, retryOnTimeout: false, gate, sleep: async () => {},
  });

  it('막히면 보내지 않음 — RATE_LIMITED, attempts 0, flags quota:RPM', async () => {
    let sent = 0;
    const client: LlmClient = { create: async () => { sent++; throw new Error('보내면 안 됨'); } };
    const r = await callLlm(client, opts({ acquire: async () => ({ ok: false, scope: 'RPM', retryAfterS: 60 }), release: () => {} }));
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, 'RATE_LIMITED');
    assert.equal(r.call.attempts, 0);
    assert.deepEqual(r.call.flags, ['quota:RPM']);
    assert.equal(sent, 0);
  });

  it('보낼 때마다 acquire · release 짝 (다시 시도도 관문을 다시 지남)', async () => {
    const log: string[] = [];
    let n = 0;
    const client: LlmClient = {
      create: async () => {
        if (n++ === 0) throw Object.assign(new (await import('./llm.ts')).LlmClientError('server', '500'), {});
        return { content: [{ type: 'text', text: '{"reply":"네"}' }], stop_reason: 'end_turn' };
      },
    };
    const r = await callLlm(client, opts({ acquire: async () => (log.push('a'), { ok: true }), release: () => void log.push('r') }));
    assert.equal(r.ok, true);
    assert.deepEqual(log, ['a', 'r', 'a', 'r']);
  });
});
