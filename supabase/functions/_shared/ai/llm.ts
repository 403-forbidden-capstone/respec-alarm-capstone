// 모델 호출 관문 — 서버가 Claude를 부르는 모든 길이 여기를 지난다 (지점 7개는 prompts/index.ts의 callPoint가 부름).
// 순서: 키 확인 → 요청 만들기 → 호출(시간 초과 · 재시도 1번) → 글 꺼내기 → JSON → 기준 스키마 검증 → 호출 기록(call) 만들기.
// 구조 원칙(docs/ai-lab/프롬프트카드/06-서버지침.md): 앱에는 프롬프트가 없고, 숫자 · 시각 · 저장은 서버가 쥐며,
//   모델 출력은 믿지 않는 입력이라 서버가 다시 검사한다 — 스키마 검증이 그 첫 문이고, 그 뒤 규칙 검사(가드)는 다음 PR.
// 결과는 던지지 않는 값: { ok: true, data, call } / { ok: false, code, message, reason, call }. 호출하는 쪽은 실패하면 AI 칸만 비우고 나머지는 그대로 진행.
//   (스키마가 지원 밖 키워드를 쓰는 것 같은 코드 버그는 던짐 — 크게 터져야 고치므로)
// 순수 TS — Deno · Node API 없음. SDK(npm:@anthropic-ai/sdk)는 anthropic.ts 한 곳에서만 가져오고, 여기서는 최소 인터페이스(LlmClient)로만 부름
//   → node --test에서 가짜 클라이언트로 시험하고, 나중에 공급자가 바뀌어도(Gemini 등) 이 파일은 그대로.
// 실험실 src/lib/llm.ts와 다르게 한 것: 장부 · 예산 · 배치 · 도구 루프 없음(서버는 ai_calls 한 줄로 기록), 재시도 직접 1번(SDK 재시도 끔),
//   시간 초과를 Promise.race로 직접 걺, 실패를 던지지 않고 값으로 돌려줌.

import { HttpError } from '../errors.ts';
import { costUsd } from './pricing.ts';
import { apiLimitProblems, apiSchemaInfo, fromApiOutput, validate, type JsonSchema } from './schema.ts';

export const DEFAULT_MODEL = 'claude-haiku-5-5';

// ---------------------------------------------------------------------------
// 클라이언트 인터페이스 (SDK 모양을 따르되 쓰는 칸만)
// ---------------------------------------------------------------------------

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// 사진 한 장 (base64, 앞의 data:… 머리말 없이). 시간표 사진 읽기처럼 사진을 보는 지점만 씀
export interface LlmImage {
  media_type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  data: string;
}

export type LlmContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: LlmImage['media_type']; data: string } };

export interface LlmRequest {
  model: string;
  max_tokens: number;
  // 글 하나짜리 system에 캐시 표시(5분)를 붙임 — 같은 지점의 두 번째 호출부터 캐시 읽기 단가
  system: string | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[];
  messages: { role: 'user'; content: string | LlmContentBlock[] }[];
  output_config: { effort: Effort; format: { type: 'json_schema'; schema: JsonSchema } };
  thinking?: { type: 'adaptive' };
}

export interface LlmUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens_details?: { thinking_tokens?: number | null } | null;
}

export interface LlmResponse {
  // 블록 종류 중 'text'만 읽음 (thinking · redacted_thinking 등은 건너뜀)
  content: { type: string; text?: string }[];
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
  usage?: LlmUsage | null;
  model?: string | null;
  // 공급자 요청 번호 (문의 · 추적용)
  request_id?: string | null;
}

export interface LlmClient {
  // signal이 abort되면 요청을 멈춰야 함. 실패는 LlmClientError로 던짐 (그 밖의 오류는 'unknown'으로 취급)
  create(params: LlmRequest, options: { signal: AbortSignal }): Promise<LlmResponse>;
}

// ---------------------------------------------------------------------------
// 클라이언트가 던지는 오류
// ---------------------------------------------------------------------------

export type LlmErrorKind =
  | 'rate_limit' // 429
  | 'overloaded' // 529
  | 'server' // 5xx
  | 'timeout' // 연결 시간 초과 · 우리가 건 시간 초과
  | 'connection' // 연결 끊김
  | 'bad_request' // 400
  | 'auth' // 401
  | 'permission' // 403
  | 'not_found' // 404 (모델 이름이 틀린 경우 등)
  | 'too_large' // 413
  | 'billing' // 크레딧 부족 등 결제
  | 'unknown';

export class LlmClientError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | null;
  readonly requestId: string | null;
  // 서버가 알려 준 기다릴 시간(retry-after). 없으면 null
  readonly retryAfterMs: number | null;

  constructor(
    kind: LlmErrorKind,
    message: string,
    opts: { status?: number | null; requestId?: string | null; retryAfterMs?: number | null; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'LlmClientError';
    this.kind = kind;
    this.status = opts.status ?? null;
    this.requestId = opts.requestId ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

function asClientError(e: unknown): LlmClientError {
  if (e instanceof LlmClientError) return e;
  return new LlmClientError('unknown', e instanceof Error ? e.message : String(e), { cause: e });
}

// 다시 시도해 볼 만한 것: 529 · 503 과부하 · 5xx · 연결 오류, 그리고 (지점 설정이 허락하면) 시간 초과. 400 · 401 · 403 · 404는 다시 해도 같음
// 429(한도 초과)는 서버가 2초 안에 다시 하라고 알려 준 때만 — 1분 · 하루 한도는 곧바로 다시 보내면 한도만 더 씀
function isRetryable(e: LlmClientError, retryOnTimeout: boolean): boolean {
  switch (e.kind) {
    case 'rate_limit':
      return e.retryAfterMs != null && e.retryAfterMs <= RETRY_MAX_MS;
    case 'overloaded':
    case 'server':
    case 'connection':
      return true;
    case 'timeout':
      return retryOnTimeout;
    default:
      return false;
  }
}

export const MAX_ATTEMPTS = 2; // 처음 + 다시 1번
export const RETRY_DEFAULT_MS = 500;
export const RETRY_MIN_MS = 200;
export const RETRY_MAX_MS = 2_000;
// 마감 안 다시 시도의 최소 시도 시간 — Gemini Flash-Lite 정상 응답 1.4~4.6초(11/12 실측)라 이보다 짧으면 다시 보내도 못 받음
export const RETRY_MIN_ATTEMPT_MS = 3_000;

// retry-after를 200~2000ms로 자름 (서버가 길게 기다리라고 해도 사용자가 기다리는 요청이라 2초 넘게는 안 기다림), 없으면 500ms
export function retryDelayMs(e: LlmClientError): number {
  if (e.retryAfterMs == null || !Number.isFinite(e.retryAfterMs)) return RETRY_DEFAULT_MS;
  return Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, Math.round(e.retryAfterMs)));
}

// ---------------------------------------------------------------------------
// 결과
// ---------------------------------------------------------------------------

export type LlmFailCode =
  | 'NOT_CONFIGURED' // 키가 없음 — 호출 0번
  | 'TIMEOUT' // 시간 안에 못 받음
  | 'RATE_LIMITED' // 공급자 429
  | 'UPSTREAM' // 공급자 5xx · 과부하 · 연결 오류 · 알 수 없는 오류
  | 'AUTH' // 키가 틀림 · 권한 없음 · 결제 문제 — 설정을 고쳐야 함
  | 'BAD_REQUEST' // 우리 요청이 틀림(400 · 404 · 요청 설정 오류) — 코드를 고쳐야 함
  | 'REFUSED' // 모델이 답을 거절 (stop_reason refusal)
  | 'TRUNCATED' // max_tokens에 닿아 답이 잘림
  | 'BAD_OUTPUT'; // 빈 답 · JSON 깨짐 · 스키마 어긋남

// 화면에 그대로 보여 줘도 되는 짧은 한국어 (errors.ts 규칙). 앱은 코드(LLM_UNAVAILABLE)로 자기 문구를 고름
export const FAIL_MESSAGES: Record<LlmFailCode, string> = {
  NOT_CONFIGURED: 'AI가 아직 준비되지 않았어요',
  TIMEOUT: 'AI 응답이 늦어요. 잠시 후 다시 시도해 주세요',
  RATE_LIMITED: 'AI 요청이 몰렸어요. 잠시 후 다시 시도해 주세요',
  UPSTREAM: 'AI가 지금 답하지 못해요',
  AUTH: 'AI 연결 설정에 문제가 있어요',
  BAD_REQUEST: 'AI 요청을 처리하지 못했어요',
  REFUSED: 'AI가 이 내용에는 답하지 못해요',
  TRUNCATED: 'AI 답이 중간에 끊겼어요',
  BAD_OUTPUT: 'AI 답을 읽지 못했어요',
};

const CODE_OF_KIND: Record<LlmErrorKind, LlmFailCode> = {
  rate_limit: 'RATE_LIMITED',
  overloaded: 'UPSTREAM',
  server: 'UPSTREAM',
  connection: 'UPSTREAM',
  unknown: 'UPSTREAM',
  timeout: 'TIMEOUT',
  auth: 'AUTH',
  permission: 'AUTH',
  billing: 'AUTH',
  bad_request: 'BAD_REQUEST',
  not_found: 'BAD_REQUEST',
  too_large: 'BAD_REQUEST',
};

// ai_calls 표 한 줄과 같은 칸 이름 (user_id · session_id · io · created_at은 부르는 쪽이 붙임)
export interface AiCallRecord {
  point: string; // 'T1' · 'T2F' · …
  prompt_id: string; // 'T1' (ASSIST_E4 · …)
  prompt_version: string; // 'v1.3'
  model: string; // 응답에 적힌 모델(없으면 요청한 모델)
  ok: boolean;
  // 실패 때 LlmFailCode (성공이면 null). ai_calls.error_code 주석은 "LLM_UNAVAILABLE 등"인데, 모든 실패가 그 코드라서 정보가 없어 세분 코드를 적음
  error_code: LlmFailCode | null;
  latency_ms: number; // 첫 시도 시작부터 끝까지 (다시 시도 · 기다림 포함)
  attempts: number; // 호출한 횟수 (키가 없으면 0)
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  thinking_tokens: number | null;
  cost_usd: number | null; // 단가를 아는 모델만. 실패해서 응답이 없으면 null
  stop_reason: string | null;
  request_id: string | null;
  flags: string[]; // 규칙 걸림 코드 — 여기서는 빈 배열, 가드(다음 PR)가 채움
}

export interface LlmSuccess<T> {
  ok: true;
  data: T;
  call: AiCallRecord;
}

export interface LlmFailure {
  ok: false;
  code: LlmFailCode;
  message: string; // 짧은 한국어
  reason: string; // 개발자용 자세한 까닭 (300자까지)
  call: AiCallRecord;
}

export type LlmResult<T = unknown> = LlmSuccess<T> | LlmFailure;

// ---------------------------------------------------------------------------
// 호출
// ---------------------------------------------------------------------------

// 사용량 관문 (ai/quota.ts QuotaGate) — 요청을 보내기 직전에 acquire, 끝나면 release. 막히면 보내지 않고 RATE_LIMITED
export interface CallGate {
  acquire(): Promise<{ ok: true } | { ok: false; scope: string; retryAfterS: number }>;
  release(): void;
}

export interface CallOpts {
  point: string;
  promptId: string;
  promptVersion: string;
  model: string;
  system: string; // 모델에 보내는 그대로
  user: string; // 템플릿을 채운 글
  images?: LlmImage[]; // 사진을 같이 보낼 때 (user 글 앞에 붙음). 호출 기록(io)에는 남기지 않는 것이 부르는 쪽 약속
  schema: JsonSchema; // 기준 스키마 (API 변형 · 검증은 여기서)
  effort: Effort;
  maxTokens: number;
  thinking?: { type: 'adaptive' } | null; // 안 보내는 지점은 생략
  cacheSystem?: boolean; // 기본 true
  timeoutMs: number; // 시도 하나마다
  retryOnTimeout: boolean;
  // 전체 마감(ms, 첫 시도 시작부터). 다시 시도하면 마감을 넘길 것 같을 때(지난 시간 + 기다림 + 시도 시간 > 마감) 다시 시도하지 않음. 없으면 제한 없음
  deadlineMs?: number;
  // 시험에서 바꿔 끼움
  sleep?: (ms: number) => Promise<void>;
  now?: () => number; // ms 단위 단조 시계 (기본 performance.now)
  gate?: CallGate;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const REASON_MAX = 300;
const clip = (s: string): string => (s.length > REASON_MAX ? `${s.slice(0, REASON_MAX - 1)}…` : s);

const imageBlock = (img: LlmImage): LlmContentBlock => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });

// 요청 본문. temperature · top_p · prefill은 보내지 않는다 (Haiku 5.5는 effort로 조절, 마지막이 assistant면 400)
export function buildRequest(opts: CallOpts): LlmRequest {
  const request: LlmRequest = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: opts.cacheSystem === false ? opts.system : [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: opts.images?.length ? [...opts.images.map(imageBlock), { type: 'text', text: opts.user }] : opts.user }],
    output_config: { effort: opts.effort, format: { type: 'json_schema', schema: apiSchemaInfo(opts.schema).schema } },
  };
  if (opts.thinking) request.thinking = opts.thinking;
  return request;
}

// 호출 전에 알 수 있는 우리 쪽 실수 (400이 날 게 뻔한 것) — 돈 · 시간 아끼려고 부르지 않고 BAD_REQUEST로 돌려줌
function setupProblems(opts: CallOpts): string[] {
  const out: string[] = [];
  if (!Number.isInteger(opts.maxTokens) || opts.maxTokens < 1) out.push(`max_tokens는 1 이상 정수 (${opts.maxTokens})`);
  if (!(opts.timeoutMs > 0)) out.push(`timeoutMs는 양수 (${opts.timeoutMs})`);
  if (opts.deadlineMs !== undefined && !(opts.deadlineMs > 0)) out.push(`deadlineMs는 양수 (${opts.deadlineMs})`);
  if (!opts.user.trim()) out.push('user 글이 비어 있음');
  if (opts.cacheSystem !== false && !opts.system.trim()) out.push('system 글이 비어 있음');
  for (const p of apiLimitProblems(apiSchemaInfo(opts.schema).schema)) out.push(`${p} (400)`);
  return out;
}

function numberOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// 시도 하나. 시간 초과는 Promise.race로 직접 건다 — 클라이언트가 signal을 무시해도 약속한 시간 안에 돌아오게.
// 진 쪽 promise의 늦은 거절은 .catch로 받아 unhandled rejection이 되지 않게 함
async function attemptOnce(client: LlmClient, request: LlmRequest, timeoutMs: number): Promise<LlmResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new LlmClientError('timeout', `응답이 ${timeoutMs}ms 안에 오지 않음`));
      controller.abort();
    }, timeoutMs);
  });
  timeout.catch(() => {});
  // async 함수로 감싸서 create가 동기로 던져도 거절로 받음
  const call = (async () => await client.create(request, { signal: controller.signal }))();
  call.catch(() => {});
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function callLlm<T = unknown>(client: LlmClient | null, opts: CallOpts): Promise<LlmResult<T>> {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? defaultSleep;

  const fail = (
    code: LlmFailCode,
    reason: string,
    extra: { latency_ms?: number; attempts?: number; response?: LlmResponse | null; requestId?: string | null; flags?: string[] } = {},
  ): LlmFailure => {
    const call = makeCall(opts, { ok: false, error_code: code, latency_ms: extra.latency_ms ?? 0, attempts: extra.attempts ?? 0, response: extra.response ?? null, requestId: extra.requestId ?? null });
    if (extra.flags) call.flags = extra.flags;
    return { ok: false, code, message: FAIL_MESSAGES[code], reason: clip(reason), call };
  };

  // 키가 없으면 호출 0번 — 앱은 AI 칸만 비우고 알람 · 기록은 그대로
  if (!client) return fail('NOT_CONFIGURED', 'ANTHROPIC_API_KEY가 없어 호출하지 않음');

  const problems = setupProblems(opts);
  if (problems.length > 0) return fail('BAD_REQUEST', `요청 설정 오류: ${problems.join(' / ')}`);

  const request = buildRequest(opts);
  const t0 = now();
  let attempts = 0;
  let response: LlmResponse | null = null;
  let lastError: LlmClientError | null = null;
  let blocked: { scope: string; retryAfterS: number } | null = null;
  let attemptMs = opts.timeoutMs;
  for (;;) {
    if (opts.gate) {
      const v = await opts.gate.acquire();
      if (!v.ok) {
        blocked = v;
        break;
      }
    }
    attempts++;
    try {
      response = await attemptOnce(client, request, attemptMs);
      break;
    } catch (e) {
      lastError = asClientError(e);
      if (attempts >= MAX_ATTEMPTS || !isRetryable(lastError, opts.retryOnTimeout)) break;
      const wait = retryDelayMs(lastError);
      // 마감이 있으면 다시 시도는 남은 시간만큼만 — 빨리 온 503(11/12 T1 1.4초)에 남은 7초를 버리지 않음. 남은 시간이 너무 짧으면 안 함
      if (opts.deadlineMs !== undefined) {
        const left = opts.deadlineMs - (now() - t0) - wait;
        if (left < Math.min(opts.timeoutMs, RETRY_MIN_ATTEMPT_MS)) break;
        attemptMs = Math.min(opts.timeoutMs, left);
      }
      await sleep(wait);
    } finally {
      opts.gate?.release();
    }
  }
  const latency_ms = Math.max(0, Math.round(now() - t0));

  // 관문이 막음 — 앞 시도가 없으면 보낸 요청 0개(attempts 0)로 기록, 있으면 그 시도의 오류를 그대로
  if (!response && blocked !== null && lastError === null) {
    return fail('RATE_LIMITED', `사용량 상한(${blocked.scope})에 닿아 보내지 않음 — ${blocked.retryAfterS}초 뒤 가능`, { latency_ms, attempts, flags: [`quota:${blocked.scope}`] });
  }
  if (!response) {
    const err = lastError as LlmClientError;
    return fail(CODE_OF_KIND[err.kind], `${err.kind}${err.status ? ` ${err.status}` : ''}: ${err.message}`, { latency_ms, attempts, requestId: err.requestId });
  }

  const done = { latency_ms, attempts, response, requestId: response.request_id ?? null };
  const stop = response.stop_reason;
  if (stop === 'refusal') {
    const category = response.stop_details?.category;
    return fail('REFUSED', `모델이 답을 거절함 (refusal${category ? ` — ${category}` : ''})`, done);
  }
  const text = response.content.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('');
  if (stop === 'max_tokens') {
    return fail('TRUNCATED', text.trim() ? `max_tokens ${opts.maxTokens}에 닿아 출력이 잘림` : `max_tokens ${opts.maxTokens}를 생각에 다 써서 답이 없음`, done);
  }
  if (stop === 'model_context_window_exceeded') return fail('TRUNCATED', '문맥 창을 넘어 출력이 잘림', done);
  if (stop !== 'end_turn') return fail('BAD_OUTPUT', `예상 못 한 stop_reason: ${String(stop)}`, done);

  if (!text.trim()) return fail('BAD_OUTPUT', '빈 답 — JSON 없음', done);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('BAD_OUTPUT', 'JSON 파싱 실패 (모델 출력이 JSON이 아님)', done);
  }
  // API 변형(대신 값 · 선택 칸)을 기준 모양으로 되돌린 뒤 기준 스키마 전체로 검증 — pattern · 범위 등 API가 못 거는 것도 여기서 잡힘
  const data = fromApiOutput(opts.schema, parsed);
  const checked = validate(opts.schema, data);
  if (!checked.valid) return fail('BAD_OUTPUT', `스키마: ${checked.errors.slice(0, 5).join(' / ')}${checked.errors.length > 5 ? ` 외 ${checked.errors.length - 5}건` : ''}`, done);

  return { ok: true, data: data as T, call: makeCall(opts, { ok: true, error_code: null, ...done, response }) };
}

function makeCall(
  opts: CallOpts,
  r: { ok: boolean; error_code: LlmFailCode | null; latency_ms: number; attempts: number; response: LlmResponse | null; requestId: string | null },
): AiCallRecord {
  const usage = r.response?.usage ?? null;
  const model = r.response?.model || opts.model;
  return {
    point: opts.point,
    prompt_id: opts.promptId,
    prompt_version: opts.promptVersion,
    model,
    ok: r.ok,
    error_code: r.error_code,
    latency_ms: r.latency_ms,
    attempts: r.attempts,
    input_tokens: numberOrNull(usage?.input_tokens),
    output_tokens: numberOrNull(usage?.output_tokens),
    cache_read_tokens: numberOrNull(usage?.cache_read_input_tokens),
    cache_write_tokens: numberOrNull(usage?.cache_creation_input_tokens),
    thinking_tokens: numberOrNull(usage?.output_tokens_details?.thinking_tokens),
    cost_usd: usage ? costUsd(model, usage) : null,
    stop_reason: r.response?.stop_reason ?? null,
    request_id: r.requestId,
    flags: [],
  };
}

// ---------------------------------------------------------------------------
// 연결
// ---------------------------------------------------------------------------

// 키가 없으면 null(호출 0번 → NOT_CONFIGURED), 있으면 make로 만든 클라이언트. 키가 없을 때 make(SDK 클라이언트 생성)를 부르지 않음.
// 단, anthropic.ts는 정적 import라 키가 없어도 SDK 모듈은 로드됨 — 줄이는 것은 호출이지 로드가 아님
export function llmClientFrom(key: string | null | undefined, make: (key: string) => LlmClient): LlmClient | null {
  const k = key?.trim();
  return k ? make(k) : null;
}

// 실패를 서버 오류 LLM_UNAVAILABLE(502)로. 앱 응답 details에는 세분 코드와 요청 번호만 — 공급자 오류 원문(reason)은 앱에 보내지 않고
// 서버 로그(console.error)에만 남김 (요청 번호 · 지점 · 코드와 같이. 프롬프트 · 키 · 사용자 글은 reason에 없음)
export function toHttpError(f: LlmFailure, log: (...args: unknown[]) => void = console.error): HttpError {
  log(`[ai] ${f.call.point} ${f.code} request_id=${f.call.request_id ?? '-'} attempts=${f.call.attempts}: ${f.reason}`);
  return new HttpError('LLM_UNAVAILABLE', f.message, { code: f.code, requestId: f.call.request_id });
}
