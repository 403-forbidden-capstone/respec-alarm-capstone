// AI 호출 사용량 제어 — Gemini 프로젝트 한도(RPM · TPM · RPD)를 넘기 전에 서버가 먼저 막음. voice-turn의 글 대화(T1) · 일정 추출(T2F)에만 씀
//   한도는 Google 프로젝트 전체(모든 사용자 합) 기준이라 사용자별 상한(opening.ts MAX_AI_CALLS_PER_DAY)과 따로 셈
//   사용량은 이 서버 인스턴스의 메모리(QuotaLog)에서 셈 — DB를 쓰지 않음 (캡스톤 발표 · 소수 사용자용)
//   설정(비밀값, 0 = 끔): AI_LIMIT_RPM · AI_LIMIT_TPM · AI_LIMIT_RPD · AI_LIMIT_CONCURRENCY. 비우면 아래 기본값
//   기본값 = gemini-3.5-flash-lite 프로젝트 한도(11/6 확인: RPM 15 · TPM 250,000 · RPD 500)보다 낮게 잡은 값 (작업자 결정)
// TPM은 입력 토큰 기준. 토큰은 보낸 뒤에야 알 수 있어서 한 번에 CALL_TOKENS_GUESS로 어림해 미리 셈
export interface QuotaLimits {
  rpm: number; // 1분 요청 수 (Google에 실제로 보낸 수 — 다시 시도 포함)
  tpm: number; // 1분 입력 토큰 수
  rpd: number; // 하루 요청 수 — 최근 24시간으로 셈 (Google은 태평양 시간 0시에 초기화 → 24시간 창이 더 보수적)
  concurrency: number; // 동시에 보내는 요청 수
}

export const DEFAULT_QUOTA: QuotaLimits = { rpm: 8, tpm: 200_000, rpd: 300, concurrency: 4 };

// 한 번 호출의 입력 토큰 어림값 — 실측 T1 · T2F 입력(약 2,300~4,800)보다 넉넉히
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
  minuteTokens: number; // 최근 1분 입력 토큰 (어림)
  dayRequests: number;
  callTokens: number; // 한 번 호출의 입력 토큰 어림값
}

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

/** 이 서버 인스턴스에서 보낸 요청 기록 — 1분 · 24시간 창으로 셈 */
// shortcut: 메모리라 인스턴스마다 따로 세고 인스턴스가 새로 뜨면 0부터 — 사용자가 늘면 DB(ai_calls)로 셀 것
export class QuotaLog {
  entries: { at: number; tokens: number }[] = [];
  inFlight = 0;
  callTokens = CALL_TOKENS_GUESS;
  now: () => number = () => Date.now();

  usage(): Usage {
    const t = this.now();
    this.entries = this.entries.filter((e) => e.at > t - 24 * 3600_000);
    const minute = this.entries.filter((e) => e.at > t - 60_000);
    return { minuteRequests: minute.length, minuteTokens: minute.reduce((n, e) => n + e.tokens, 0), dayRequests: this.entries.length, callTokens: this.callTokens };
  }
}

const sharedLog = new QuotaLog();

/** 요청 하나(Run)의 관문 — 보내기 직전 acquire(자리 잡기), 끝나면 release. 판정과 기록이 한 번에(await 없이) 일어나 같은 인스턴스 안 동시 요청도 한도를 못 넘음 */
export class QuotaGate {
  private readonly limits: QuotaLimits;
  private readonly log: QuotaLog;
  private held = 0;

  constructor(limits: QuotaLimits, log: QuotaLog = sharedLog) {
    this.limits = limits;
    this.log = log;
  }

  /** 미리 보기 — need개를 보낼 여유가 있는지 (자리를 잡지는 않음) */
  async check(need: number): Promise<GateVerdict> {
    return checkQuota(this.limits, this.log.usage(), this.log.inFlight, need);
  }

  /** 요청 하나를 보내기 직전 — 통과하면 기록하고 자리를 잡음. 보낸 뒤 꼭 release */
  async acquire(): Promise<GateVerdict> {
    const v = checkQuota(this.limits, this.log.usage(), this.log.inFlight, 1);
    if (v.ok) {
      this.log.entries.push({ at: this.log.now(), tokens: this.log.callTokens });
      this.log.inFlight++;
      this.held++;
    }
    return v;
  }

  release(): void {
    if (this.held > 0) {
      this.held--;
      this.log.inFlight--;
    }
  }
}
