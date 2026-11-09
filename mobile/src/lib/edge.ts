// 서버 함수(Edge Function) 호출 — 앱은 이 함수로만 부름 (전체작업계획 7절 "서버 함수 호출")
//   const result = await callEdge<응답 모양>('alarm-commit', { ...요청 })
//   · 로그인 토큰은 supabase-js가 자동으로 실음 (세션이 없으면 서버가 AUTH_REQUIRED)
//   · 실패는 늘 EdgeError(= UserError)로 던짐 → useAction이 토스트로 보여 줌. 서버 원문(message)은 쓰지 않고 code로 문구를 고름
//     (서버 message는 영어 · 칼럼 이름이 섞일 수 있어서 — CLAUDE.md "DB · 네트워크 원문은 화면에 안 보임"). 화면이 갈래를 나눌 땐 error.code · error.details
//   · 요청 · 응답 모양은 이 파일이 모름 — 부르는 쪽(features/*/real.ts)이 자기 타입을 정함. 모양은 supabase/README.md "서버 함수"
//
// 서버가 돌려주는 오류 (supabase/functions/_shared/errors.ts, 상세설계서 5장 5.2.1): HTTP 상태 + 본문 { error: { code, message, details? } }
//   supabase.functions.invoke는 2xx가 아니면 FunctionsHttpError를 돌려주고, 응답(Response)은 error.context에 있음 → context.json()으로 읽음
//   네트워크 실패는 FunctionsFetchError, Supabase 중계 쪽 실패는 FunctionsRelayError
//
// 중복 막는 키: 옵션 idempotencyKey를 주면 헤더 Idempotency-Key로 보냄 (CORS는 허용). 서버가 아직 안 읽음 — 읽게 되면 쓰기 호출(alarm-commit)이 같은 키로 재전송해도 한 번만 저장됨
import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';
import { ERROR_STATUS, type ErrorCode } from '@shared/errors.ts';

import { UserError } from './errors';
import { supabase } from './supabase';

// 서버 코드(ErrorCode) + 앱에서 정한 것: NETWORK = 서버까지 못 감, TIMEOUT = 응답이 너무 늦음, UNKNOWN = 모르는 모양
export type EdgeFailure = ErrorCode | 'NETWORK' | 'TIMEOUT' | 'UNKNOWN';

export const DEFAULT_MESSAGE = '하지 못했어요. 다시 해 주세요';

// code → 사용자 문구. 서버에 코드가 늘면 여기에 없어도 기본 문구로 보임 (시험이 빠진 코드를 알려 줌)
export const EDGE_MESSAGES: Partial<Record<EdgeFailure, string>> = {
  VALIDATION_FAILED: '입력한 내용을 다시 확인해 주세요',
  AUTH_REQUIRED: '로그인 정보가 만료됐어요. 다시 로그인해 주세요',
  FORBIDDEN: '이 작업을 할 권한이 없어요',
  NOT_FOUND: '찾을 수 없어요. 이미 지워졌을 수 있어요',
  CONFLICT: '다른 곳에서 먼저 바뀌었어요. 새로 불러온 뒤 다시 해 주세요',
  UNPROCESSABLE: '이 내용으로는 저장할 수 없어요',
  RATE_LIMITED: '요청이 몰려 있어요. 잠시 뒤에 다시 해 주세요',
  INTERNAL: '서버에 문제가 생겼어요. 잠시 뒤에 다시 해 주세요',
  ROUTE_UNAVAILABLE: '이동시간을 구하지 못했어요. 직접 입력해 주세요',
  PLACE_UNAVAILABLE: '장소 검색이 잠시 안 돼요. 잠시 뒤에 다시 해 주세요',
  LLM_UNAVAILABLE: 'AI가 지금 답하지 못해요. 잠시 뒤에 다시 해 주세요',
  VOICE_UNAVAILABLE: '음성 대화를 지금은 쓸 수 없어요. 글로 입력해 주세요',
  NOT_CONFIGURED: '서버 설정이 아직 끝나지 않았어요. 개발자에게 알려 주세요',
  NETWORK: '인터넷 연결을 확인해 주세요',
  TIMEOUT: '서버 응답이 늦어요. 잠시 뒤에 다시 해 주세요',
};

// UNPROCESSABLE은 details.reason으로 이유를 나눠 보여 줌 (서버: DEPARTURE_PASSED · ORDER · PAST_TIME)
export const UNPROCESSABLE_MESSAGES: Record<string, string> = {
  DEPARTURE_PASSED: '출발 시각이 이미 지나서 저장할 수 없어요',
  ORDER: '알람 순서가 맞지 않아요. 기상 → 준비 → 출발 순서로 맞춰 주세요',
  PAST_TIME: '이미 지난 시각이에요. 다른 시각을 골라 주세요',
  PAST_APPOINTMENT: '지난 약속이에요', // 지난 공동 약속은 고치기 · 새 참여 모두 막힘 (친구 9장 9-32)
};

// 서버 본문 { error: { code, message, details } }이 아닐 때(Supabase 게이트웨이가 토큰을 거절하는 경우 등) HTTP 상태로 짐작
export function failureFromStatus(status: number | null): EdgeFailure {
  if (status == null) return 'UNKNOWN';
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'INTERNAL';
  return 'UNKNOWN'; // 404는 함수가 배포되지 않았을 때도 나와서 "찾을 수 없어요"로 보이면 헷갈림
}

export function messageFor(code: EdgeFailure, details?: unknown): string {
  if (code === 'UNPROCESSABLE') {
    const reason = (details as { reason?: unknown } | null | undefined)?.reason;
    if (typeof reason === 'string' && UNPROCESSABLE_MESSAGES[reason]) return UNPROCESSABLE_MESSAGES[reason];
  }
  return EDGE_MESSAGES[code] ?? DEFAULT_MESSAGE;
}

// 서버 함수가 준 오류 — 문구는 code로 정한 한국어, 서버 message는 serverMessage에만 보관 (로그 · 개발자 확인용, 화면에 안 보임)
export class EdgeError extends UserError {
  readonly code: EdgeFailure;
  readonly status: number | null;
  readonly details: unknown;
  readonly requestId: string | null;
  readonly serverMessage: string | null;

  constructor(code: EdgeFailure, init: { status?: number | null; details?: unknown; requestId?: string | null; serverMessage?: string | null } = {}) {
    super(messageFor(code, init.details));
    this.name = 'EdgeError';
    this.code = code;
    this.status = init.status ?? null;
    this.details = init.details;
    this.requestId = init.requestId ?? null;
    this.serverMessage = init.serverMessage ?? null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// Response 본문을 { error: { code, message, details } }로 읽음. 아니면 null (본문이 JSON이 아니거나 다른 모양)
async function readErrorBody(response: unknown): Promise<{ code: string; message: string | null; details: unknown } | null> {
  try {
    const json: unknown = await (response as { json(): Promise<unknown> }).json();
    const error = isRecord(json) ? json.error : null;
    if (!isRecord(error) || typeof error.code !== 'string') return null;
    return { code: error.code, message: typeof error.message === 'string' ? error.message : null, details: error.details };
  } catch {
    return null;
  }
}

// supabase.functions.invoke가 준 error를 EdgeError로 바꿈 (시험에서 가짜 error를 넣어 확인)
export async function toEdgeError(error: unknown): Promise<EdgeError> {
  if (error instanceof FunctionsHttpError) {
    const response = error.context as { status?: number; headers?: { get(name: string): string | null } } | undefined;
    const status = typeof response?.status === 'number' ? response.status : null;
    const requestId = response?.headers?.get?.('x-request-id') ?? null;
    const body = await readErrorBody(response);
    if (body) {
      // 모르는 code(서버가 새로 더한 것)는 상태로 짐작한 갈래의 문구 — 그래도 모르면 기본 문구
      const code = Object.hasOwn(ERROR_STATUS, body.code) ? (body.code as ErrorCode) : failureFromStatus(status);
      return new EdgeError(code, { status, details: body.details, requestId, serverMessage: body.message });
    }
    return new EdgeError(failureFromStatus(status), { status, requestId });
  }
  if (error instanceof FunctionsRelayError) return new EdgeError('INTERNAL');
  if (error instanceof FunctionsFetchError) {
    const aborted = (error.context as { name?: unknown } | undefined)?.name === 'AbortError';
    return new EdgeError(aborted ? 'TIMEOUT' : 'NETWORK');
  }
  return new EdgeError('UNKNOWN');
}

export type EdgeOptions = {
  idempotencyKey?: string; // 같은 키로 다시 보내도 한 번만 처리되게 (서버가 읽게 되면). 쓰기 호출은 한 번 만들어 재시도에도 같은 키를 씀
  timeoutMs?: number; // 기본 20초
  retry?: number; // 네트워크 · 시간 초과 · 서버 오류(INTERNAL)일 때 다시 해 볼 횟수. 기본 0 — 읽기(alarm-suggest · place-search)에만 쓰고, 쓰기는 서버가 중복 키를 읽기 전엔 쓰지 않음
};

const DEFAULT_TIMEOUT_MS = 20_000;
const RETRYABLE: readonly EdgeFailure[] = ['NETWORK', 'TIMEOUT', 'INTERNAL'];

export async function callEdge<T>(name: string, body?: Record<string, unknown>, options: EdgeOptions = {}): Promise<T> {
  const headers = options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : undefined;
  const attempts = 1 + Math.max(0, options.retry ?? 0);
  let last: EdgeError | null = null;
  for (let i = 0; i < attempts; i++) {
    const { data, error } = await supabase.functions.invoke<T>(name, { body, headers, timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    if (!error) return data as T;
    last = await toEdgeError(error);
    if (!RETRYABLE.includes(last.code)) break;
  }
  throw last ?? new EdgeError('UNKNOWN');
}
