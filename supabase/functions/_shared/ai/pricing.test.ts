// 비용 계산 시험 — 실험실(ai-lab) tests/llm.test.ts의 pricing 사례 중 Haiku 5.5 몫을 옮김
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { costBreakdown, costUsd, priceCardOf, roundUsd } from './pricing.ts';

const near = (a: number | null, b: number, eps = 1e-12) => assert.ok(a !== null && Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

describe('pricing — Haiku 5.5', () => {
  it('기본 요율: 입력 $0.10 · 출력 $0.50 /MTok', () => {
    near(costUsd('claude-haiku-5-5', { input_tokens: 1000, output_tokens: 500 }), 0.00035);
    near(costUsd('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 0 }), 0.01); // 10만까지는 기본 요율
    near(costUsd('claude-haiku-5-5', { input_tokens: 0, output_tokens: 1_000_000 }), 0.5);
  });

  it('캐시 쓰기 1.25배 · 읽기 0.1배', () => {
    // 100×0.1 + 2000×0.125 + 5000×0.01 = 310 → $0.00031
    near(costUsd('claude-haiku-5-5', { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 2000, cache_read_input_tokens: 5000 }), 0.00031);
  });

  it('프롬프트 10만 토큰 초과는 비싼 요율(출력까지), 정확히 10만은 기본', () => {
    near(costUsd('claude-haiku-5-5', { input_tokens: 150_000, output_tokens: 1000 }), 0.0775);
    near(costUsd('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 0 }), 0.01);
    // 캐시 읽기도 프롬프트 길이에 들어감: 1000 + 120000 → 비싼 요율
    near(costUsd('claude-haiku-5-5', { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 120_000 }), 0.0065);
    assert.equal(costBreakdown('claude-haiku-5-5', { input_tokens: 1000, cache_read_input_tokens: 120_000 })?.rate.input, 0.5);
  });

  it('분해: 어느 항목이 돈을 썼는지', () => {
    const b = costBreakdown('claude-haiku-5-5', { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 800, cache_read_input_tokens: 3000 });
    assert.ok(b);
    assert.equal(b.prompt_tokens, 4800);
    near(b.input_usd, 0.0001);
    near(b.cache_write_usd, 0.0001);
    near(b.cache_read_usd, 0.00003);
    near(b.output_usd, 0.00025);
    near(b.total_usd, 0.00048);
  });

  it('날짜 꼬리가 붙은 id도 같은 단가', () => {
    assert.ok(priceCardOf('claude-haiku-5-5-20261001'));
    near(costUsd('claude-haiku-5-5-20261001', { input_tokens: 1000, output_tokens: 500 }), 0.00035);
  });

  it('다른 모델(ANTHROPIC_MODEL로 바꾼 경우) · 빈 이름은 단가를 몰라 null — 던지지 않음', () => {
    assert.equal(costUsd('claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 500 }), null);
    assert.equal(costUsd('gpt-x', { input_tokens: 1, output_tokens: 1 }), null);
    assert.equal(costUsd('', { input_tokens: 1, output_tokens: 1 }), null);
    assert.equal(costUsd('toString', { input_tokens: 1, output_tokens: 1 }), null);
    assert.equal(costBreakdown('gpt-x', {}), null);
  });

  it('null · 빠진 · 음수 토큰 칸은 0으로 (음수 비용이 누적을 깎지 않게)', () => {
    near(costUsd('claude-haiku-5-5', { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: null }), 0.000001);
    near(costUsd('claude-haiku-5-5', { input_tokens: -1_000_000, output_tokens: 1000 }), 0.0005);
    near(costUsd('claude-haiku-5-5', {}), 0);
  });

  it('roundUsd: 부동소수 찌꺼기 제거', () => {
    assert.equal(roundUsd(0.1 + 0.2), 0.3);
    assert.equal(roundUsd(0.0000000004), 0);
  });
});
