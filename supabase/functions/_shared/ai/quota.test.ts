// 사용량 관문 시험 — 순수 판정 · 메모리 기록(1분 · 24시간 창) · 관문(자리 잡기 · 놓기 · 동시 요청) · callLlm이 막힌 호출을 보내지 않음. 네트워크 · DB 없음
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { callLlm, type CallOpts, type LlmClient } from './llm.ts';
import { CALL_TOKENS_GUESS, checkQuota, DEFAULT_QUOTA, QuotaGate, quotaFromEnv, QuotaLog, type Usage } from './quota.ts';

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

const logWith = (callTokens = 100, minuteRequests = 0, minuteTokens = 0): QuotaLog => {
  const log = new QuotaLog();
  log.callTokens = callTokens;
  for (let i = 0; i < minuteRequests; i++) log.entries.push({ at: Date.now(), tokens: 0 });
  if (minuteTokens) log.entries.push({ at: Date.now(), tokens: minuteTokens });
  return log;
};

describe('QuotaGate', () => {
  it('이 요청이 보낸 호출은 토큰도 어림으로 더함 — TPM이 한 요청 안에서 쌓이는 것도 막음', async () => {
    const gate = new QuotaGate({ rpm: 0, rpd: 0, concurrency: 0, tpm: 1000 }, logWith(100, 0, 700));
    for (let i = 0; i < 3; i++) {
      assert.equal((await gate.acquire()).ok, true, `${i + 1}번째`); // 800 · 900 · 1000
      gate.release();
    }
    const v = await gate.acquire(); // 1100 > 1000
    assert.equal(v.ok === false && v.scope, 'TPM');
  });

  it('다시 시도도 한 번으로 셈 — 1분 한도 3, 앞서 1번이면 2번까지', async () => {
    const gate = new QuotaGate({ ...LIMITS, rpm: 3 }, logWith(100, 1));
    assert.equal((await gate.acquire()).ok, true);
    gate.release();
    assert.equal((await gate.acquire()).ok, true);
    gate.release();
    const third = await gate.acquire();
    assert.equal(third.ok === false && third.scope, 'RPM');
  });

  it('같은 기록을 쓰는 관문 여럿이 동시에 와도 합이 한도를 넘지 않음 (RPM 8, 앞서 7 → 1개만)', async () => {
    const log = logWith(6000, 7);
    const gates = [0, 1, 2, 3].map(() => new QuotaGate(DEFAULT_QUOTA, log));
    const vs = await Promise.all(gates.map((g) => g.acquire()));
    assert.equal(vs.filter((v) => v.ok).length, 1);
    assert.equal(log.usage().minuteRequests, 8);
  });

  it('동시 요청 자리는 release로 돌려줌, 막힌 acquire는 자리를 잡지 않음', async () => {
    const log = logWith();
    const gate = new QuotaGate({ ...LIMITS, rpm: 0, concurrency: 1 }, log);
    const other = new QuotaGate({ ...LIMITS, rpm: 0, concurrency: 1 }, log);
    assert.equal((await gate.acquire()).ok, true);
    assert.equal(log.inFlight, 1);
    assert.equal((await other.acquire()).ok, false);
    other.release(); // 잡지 않은 자리는 놓지 않음
    assert.equal(log.inFlight, 1);
    gate.release();
    assert.equal(log.inFlight, 0);
  });
});

describe('QuotaLog', () => {
  it('1분 안은 요청 · 토큰, 하루는 24시간 안 요청 수. 24시간 넘은 기록은 지움', () => {
    const now = new Date('2026-11-07T21:00:00+09:00').getTime();
    const log = new QuotaLog();
    log.now = () => now;
    log.entries.push({ at: now - 10_000, tokens: 400 }, { at: now - 30_000, tokens: 50 }, { at: now - 3600_000, tokens: 950 }, { at: now - 25 * 3600_000, tokens: 1 });
    assert.deepEqual(log.usage(), { minuteRequests: 2, minuteTokens: 450, dayRequests: 3, callTokens: CALL_TOKENS_GUESS });
    assert.equal(log.entries.length, 3);
  });

  it('1분이 지나면 다시 보낼 수 있음 (RPM 8을 다 쓴 뒤)', async () => {
    let now = 1_000_000;
    const log = new QuotaLog();
    log.now = () => now;
    const gate = new QuotaGate(DEFAULT_QUOTA, log);
    for (let i = 0; i < 8; i++) {
      assert.equal((await gate.acquire()).ok, true);
      gate.release();
    }
    assert.equal((await gate.acquire()).ok, false);
    now += 61_000;
    assert.equal((await gate.acquire()).ok, true);
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
