// 모델 단가 · 비용 계산 — Claude Haiku 5.5 단가만. 실험실(ai-lab) src/lib/pricing.ts에서 Haiku 줄만 옮김. 순수 TS
// 단가는 100만 토큰당 달러. 출처: 실험실 pricing.ts(claude-api 문서 2026-10 기준). 단가가 바뀌면 실험실과 같이 여기를 고침.
//   입력 $0.10 · 출력 $0.50, 캐시 쓰기(5분) = 입력 × 1.25, 캐시 읽기 = 입력 × 0.1
//   프롬프트(입력 + 캐시 쓰기 + 캐시 읽기)가 10만 토큰을 넘으면 입력 $0.50 · 출력 $2.50 (출력까지 전부) — 우리 프롬프트는 최대 수천 토큰이라 닿을 일 없음
//   생각(thinking) 토큰은 output_tokens에 이미 들어 있다.
// 다른 모델(ANTHROPIC_MODEL로 바꾼 경우)은 단가를 모르니 null — ai_calls.cost_usd는 NULL로 남고 호출은 그대로 됨.
// 한 판 안에서 비용이 어느 항목에 쓰였는지 보려고 costBreakdown도 둠.

export interface Rate {
  input: number; // $/MTok
  output: number; // $/MTok
}

interface PriceCard {
  base: Rate;
  // 프롬프트가 threshold 토큰을 넘으면 이 요율
  long: { threshold: number; rate: Rate };
  cacheWriteMult: number;
  cacheReadMult: number;
}

export const HAIKU_5_5 = 'claude-haiku-5-5';

const PRICES: Record<string, PriceCard> = {
  [HAIKU_5_5]: {
    base: { input: 0.1, output: 0.5 },
    long: { threshold: 100_000, rate: { input: 0.5, output: 2.5 } },
    cacheWriteMult: 1.25,
    cacheReadMult: 0.1,
  },
};

// SDK Usage와 호환되는 최소 모양 (시험에서 일부만 넣어도 됨)
export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

// 날짜 꼬리가 붙은 id("claude-haiku-5-5-20261001")도 같은 단가로 본다. 모르는 모델이면 null
export function priceCardOf(model: string): PriceCard | null {
  if (Object.prototype.hasOwnProperty.call(PRICES, model)) return PRICES[model];
  const stripped = model.replace(/-\d{8}$/, '');
  return Object.prototype.hasOwnProperty.call(PRICES, stripped) ? PRICES[stripped] : null;
}

// 토큰 수 읽기 — 숫자가 아니거나 음수면 0 (음수 비용이 누적을 깎지 않게)
const n = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

// 부동소수 찌꺼기 제거 (나노달러 단위)
export function roundUsd(usd: number): number {
  return Math.round(usd * 1e9) / 1e9;
}

export interface CostBreakdown {
  prompt_tokens: number; // 입력 + 캐시 쓰기 + 캐시 읽기
  rate: Rate;
  input_usd: number;
  cache_write_usd: number;
  cache_read_usd: number;
  output_usd: number;
  total_usd: number;
}

// 모르는 모델이면 null
export function costBreakdown(model: string, usage: UsageLike): CostBreakdown | null {
  const card = priceCardOf(model);
  if (!card) return null;
  const input = n(usage.input_tokens);
  const output = n(usage.output_tokens);
  const cw = n(usage.cache_creation_input_tokens);
  const cr = n(usage.cache_read_input_tokens);
  const prompt = input + cw + cr;
  const rate = prompt > card.long.threshold ? card.long.rate : card.base;
  const per = (tokens: number, usdPerM: number) => (tokens * usdPerM) / 1e6;
  const input_usd = per(input, rate.input);
  const cache_write_usd = per(cw, rate.input * card.cacheWriteMult);
  const cache_read_usd = per(cr, rate.input * card.cacheReadMult);
  const output_usd = per(output, rate.output);
  return {
    prompt_tokens: prompt,
    rate,
    input_usd,
    cache_write_usd,
    cache_read_usd,
    output_usd,
    total_usd: roundUsd(input_usd + cache_write_usd + cache_read_usd + output_usd),
  };
}

// 실제 비용 (달러). 모르는 모델이면 null
export function costUsd(model: string, usage: UsageLike): number | null {
  return costBreakdown(model, usage)?.total_usd ?? null;
}
