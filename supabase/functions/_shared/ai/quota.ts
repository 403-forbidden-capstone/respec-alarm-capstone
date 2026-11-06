// AI 호출 사용량 제어 — Gemini 프로젝트 한도(RPM · TPM · RPD)를 넘기 전에 서버가 먼저 막음
//   한도는 Google 프로젝트 전체(모든 사용자 합) 기준이라 사용자별 상한(opening.ts MAX_AI_CALLS_PER_DAY)과 따로 셈
//   사용량은 ai_calls 표(호출마다 한 줄, attempts = 실제 보낸 요청 수)에서 읽음 — DB 스키마 변경 없음
//   설정(비밀값, 0 = 끔): AI_LIMIT_RPM · AI_LIMIT_TPM · AI_LIMIT_RPD · AI_LIMIT_CONCURRENCY. 비우면 아래 기본값
//   기본값 = gemini-3.5-flash-lite 프로젝트 한도(11/6 확인: RPM 15 · TPM 250,000 · RPD 500)보다 낮게 잡은 값 (작업자 결정)
// TPM은 Google과 같은 입력 토큰 기준: 응답의 promptTokenCount(캐시 적중분 포함) = ai_calls.input_tokens + cache_read_tokens. 출력 토큰은 안 셈
//   토큰은 보낸 뒤에야 알 수 있어서, 보내기 전에는 "한 번에 쓸 토큰"을 최근 24시간 평균으로 어림해 미리 셈 (없으면 CALL_TOKENS_GUESS)
// 순수 TS — 판정(checkQuota)은 순수 함수, 읽기(readUsage)만 DB
import type { Db } from '../supabase.ts';
import { dbMs } from './context-core.ts';
import { seoulIso } from './context.ts';

export interface QuotaLimits {
  rpm: number; // 1분 요청 수 (Google에 실제로 보낸 수 — 다시 시도 포함)
  tpm: number; // 1분 입력 토큰 수
  rpd: number; // 하루 요청 수 — 최근 24시간으로 셈 (Google은 태평양 시간 0시에 초기화 → 24시간 창이 더 보수적)
  concurrency: number; // 동시에 보내는 요청 수
}

export const DEFAULT_QUOTA: QuotaLimits = { rpm: 8, tpm: 200_000, rpd: 300, concurrency: 4 };

// 기록이 없을 때 한 번 호출의 입력 토큰 어림값 — 실험 기록의 T1 · T2F 입력(캐시 포함 약 4,100~4,800)보다 넉넉히
export const CALL_TOKENS_GUESS = 6000;

export function quotaFromEnv(get: (name: string) => string | undefined): QuotaLimits {
  const num = (name: string, fallback: number): number => {
    const v = Number(get(name));
    return get(name) !== undefined && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
  };
  return {
    rpm: num('AI_LIMIT_RPM', DEFAULT_QUOTA.rpm),
    tpm: num('AI_LIMIT_TPM', DEFAULT_QUOTA.tpm),
    rpd: num('AI_LIMIT_RPD', DEFAULT_QUOTA.rpd),
    concurrency: num('AI_LIMIT_CONCURRENCY', DEFAULT_QUOTA.concurrency),
  };
}

export interface Usage {
  minuteRequests: number;
  minuteTokens: number; // 최근 1분 입력 토큰 (캐시 적중분 포함)
  dayRequests: number;
  callTokens: number; // 한 번 호출의 입력 토큰 어림값 (최근 24시간 평균)
}

export const emptyUsage = (): Usage => ({ minuteRequests: 0, minuteTokens: 0, dayRequests: 0, callTokens: CALL_TOKENS_GUESS });

export type QuotaScope = 'RPM' | 'TPM' | 'RPD' | 'CONCURRENCY';
export type GateVerdict = { ok: true } | { ok: false; scope: QuotaScope; retryAfterS: number };

/** need개 요청을 더 보내도 되는지 — 보낸 뒤 한도를 넘을 것 같으면 미리 막음. 하루 한도가 먼저(그날은 끝), 그다음 1분 한도 · 동시 요청 */
export function checkQuota(limits: QuotaLimits, usage: Usage, inFlight: number, need = 1): GateVerdict {
  if (limits.rpd > 0 && usage.dayRequests + need > limits.rpd) return { ok: false, scope: 'RPD', retryAfterS: 3600 };
  if (limits.rpm > 0 && usage.minuteRequests + need > limits.rpm) return { ok: false, scope: 'RPM', retryAfterS: 60 };
  if (limits.tpm > 0 && usage.minuteTokens + need * usage.callTokens > limits.tpm) return { ok: false, scope: 'TPM', retryAfterS: 60 };
  if (limits.concurrency > 0 && inFlight + 1 > limits.concurrency) return { ok: false, scope: 'CONCURRENCY', retryAfterS: 5 };
  return { ok: true };
}

type CallRow = { model: string | null; attempts: number | null; input_tokens: number | null; cache_read_tokens: number | null; created_at: string };

// Google이 TPM에 세는 입력 토큰 = promptTokenCount. gemini.ts가 이를 input_tokens(캐시 뺀 값) + cache_read_tokens(캐시 적중)로 나눠 적으므로 다시 더함
export const promptTokensOf = (r: Pick<CallRow, 'input_tokens' | 'cache_read_tokens'>): number | null =>
  r.input_tokens === null ? null : r.input_tokens + (r.cache_read_tokens ?? 0);

/** 최근 24시간 Gemini 호출 기록에서 1분 · 하루 사용량 (공급자가 다른 호출 — 시간표 사진의 Claude — 은 뺌) */
export async function readUsage(service: Db, nowMs: number): Promise<Usage> {
  const res = await service
    .from('ai_calls')
    .select('model, attempts, input_tokens, cache_read_tokens, created_at')
    .gte('created_at', seoulIso(new Date(nowMs - 24 * 3600_000)));
  if (res.error) throw new Error(`ai_calls 읽기 실패: ${res.error.message}`);
  const usage = emptyUsage();
  let measured = 0;
  let measuredTokens = 0;
  for (const r of (res.data ?? []) as CallRow[]) {
    if (!(r.model ?? '').startsWith('gemini')) continue;
    const sent = r.attempts ?? 0;
    const tokens = promptTokensOf(r);
    usage.dayRequests += sent;
    if (tokens !== null) {
      measured++;
      measuredTokens += tokens;
    }
    if (dbMs(r.created_at) >= nowMs - 60_000) {
      usage.minuteRequests += sent;
      usage.minuteTokens += tokens ?? 0;
    }
  }
  if (measured > 0) usage.callTokens = Math.ceil(measuredTokens / measured);
  return usage;
}

// 이 서버 인스턴스에서 지금 보내는 중인 요청 수
// shortcut: 동시 요청 수는 인스턴스(isolate) 안에서만 셈 — 인스턴스가 여럿 뜨면 합이 한도를 넘을 수 있음. 정확히 막으려면 DB에 예약 줄(표)을 두는 방식으로
let inFlight = 0;
export const inFlightNow = (): number => inFlight;

/**
 * 요청 하나(Run)의 관문 — 처음 한 번 사용량을 읽고, 이 요청이 보낸 수를 더해 가며 판정 (ai_calls는 요청이 끝날 때 기록되므로)
 * 사용량을 못 읽으면 막지 않음(기록 실패로 대화가 멈추지 않게) — 서버 로그만
 */
export class QuotaGate {
  private usage: Usage | null = null;
  private used = 0;
  private held = 0;
  private readonly limits: QuotaLimits;
  private readonly read: () => Promise<Usage>;

  constructor(limits: QuotaLimits, read: () => Promise<Usage>) {
    this.limits = limits;
    this.read = read;
  }

  private async current(): Promise<Usage> {
    if (this.usage === null) {
      try {
        this.usage = await this.read();
      } catch (e) {
        console.error('[quota] 사용량 읽기 실패 — 이번 요청은 막지 않음:', e);
        this.usage = emptyUsage();
      }
    }
    // 이 요청이 이미 보낸 호출은 아직 ai_calls에 없으니 수 · 토큰(어림)을 더함
    const u = this.usage;
    return { ...u, minuteRequests: u.minuteRequests + this.used, dayRequests: u.dayRequests + this.used, minuteTokens: u.minuteTokens + this.used * u.callTokens };
  }

  /** 미리 보기 — need개를 보낼 여유가 있는지 (자리를 잡지는 않음) */
  async check(need: number): Promise<GateVerdict> {
    return checkQuota(this.limits, await this.current(), inFlight, need);
  }

  /** 요청 하나를 보내기 직전 — 통과하면 자리를 잡음. 보낸 뒤 꼭 release */
  async acquire(): Promise<GateVerdict> {
    const v = checkQuota(this.limits, await this.current(), inFlight, 1);
    if (v.ok) {
      this.used++;
      this.held++;
      inFlight++;
    }
    return v;
  }

  release(): void {
    if (this.held > 0) {
      this.held--;
      inFlight--;
    }
  }
}
