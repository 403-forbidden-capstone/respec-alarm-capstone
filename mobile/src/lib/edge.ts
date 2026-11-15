// 서버 함수(Edge Function) 호출 — 앱 JS는 이 함수로만 부름 (전체작업계획 7절 "서버 함수 호출"). 예외 둘: 폰 네이티브 BriefingRefreshWorker가 새벽에 Edge alarm-briefing-device를
// 직접 부르고(lib/alarmSync/briefingDevice.ts — 이 스위치 · 표를 안 거침), 개발 빌드는 EXPO_PUBLIC_LIVE_TOKEN_URL로 로컬 Live 토큰 서버를 직접 부름(features/voice/api.ts)
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
//
// 서버 전환 스위치 (M2, 완결점 1-9) — 함수마다 길이 둘: Edge(위 방식) / 우리 서버(FastAPI)
//   · 길은 DB 표 server_routes가 정함 (edgeRoutes.ts: get_server_routes() 5분 캐시, 못 읽으면 전부 edge). EXPO_PUBLIC_API_BASE_URL이 없거나 https가 아니면 표를 묻지도 않고 Edge
//   · server면 POST {EXPO_PUBLIC_API_BASE_URL}/fn/<이름> — 본문 · 응답 · 오류 모양은 Edge와 같음. 로그인 토큰은 호출마다 읽어 Authorization으로 싣고,
//     401이면 refreshSession 뒤 한 번만 다시. 시간 초과(AbortController, 폰에서는 취소 오류의 name이 달라 "우리가 취소했는지"로 판정) → TIMEOUT, 서버에 못 닿음 → NETWORK
//     JSON이 아닌 본문(우리 서버 앞단 nginx)은 상태로 판정 — 단 웹에서는 nginx가 만든 오류에 CORS 헤더가 없으면 브라우저가 응답을 못 읽어 NETWORK으로 보임(폰은 읽힘)
//   · 읽기 함수(READ_FUNCTIONS: place-search · place-reverse)는 서버를 못 쓰는 상태(serverUnusable: 네트워크 · 시간 초과 · 서버 오류 · 서버 설정 안 됨 NOT_CONFIGURED ·
//     공개 키 못 받음 AUTH_UNAVAILABLE · 경로 없음 404 · 405)로 답하면 Edge로 한 번만 더 = "서버 1번 → Edge 1번"으로 끝(retry 옵션과 합쳐서).
//     서버가 연속 3번 못 쓸 상태면 5분 동안은 서버를 건너뛰고 바로 Edge, 5분 뒤에는 한 건만 서버로 시험(차단기). 카카오 같은 바깥 서비스 문제(PLACE_UNAVAILABLE)는
//     서버가 아니라 바깥 문제라 Edge로 안 보냄(Edge도 같은 카카오를 부름)
//   · 못 막는 것: 200인데 내용이 틀린 응답 · 토큰 검사 차이는 계약 시험 · canary가 막음. 쓰기 함수는 서버가 실패해도 Edge로 대신 부르지 않음(이미 처리됐을 수 있어 두 번 쓰면 안 됨)
//   · 되돌리기: 표의 해당 줄을 edge로 (앱은 다음에 표를 읽을 때 — 최대 5분, 앱을 다시 켜면 바로)
import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';
import { ERROR_STATUS, type ErrorCode } from '@shared/errors.ts';

import { claimServerAttempt, recordServerFailure, recordServerSuccess, routeFor, serverBaseUrl } from './edgeRoutes';
import { UserError } from './errors';
import { supabase } from './supabase';

// 서버 코드(ErrorCode) + 앱에서 정한 것: NETWORK = 서버까지 못 감, TIMEOUT = 응답이 너무 늦음, UNKNOWN = 모르는 모양
// AUTH_UNAVAILABLE은 우리 서버만 돌려주는 코드(공개 키 목록을 못 받아 토큰을 확인할 수 없음, 503 — 로그인이 틀렸다는 뜻이 아니라 로그아웃시키면 안 됨)
export type EdgeFailure = ErrorCode | 'AUTH_UNAVAILABLE' | 'NETWORK' | 'TIMEOUT' | 'UNKNOWN';

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
  AUTH_UNAVAILABLE: '로그인 확인이 잠시 안 돼요. 잠시 뒤에 다시 해 주세요',
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

// 서버 본문 { error: { code, message, details } }이 아닐 때(Supabase 게이트웨이가 토큰을 거절하는 경우 등) HTTP 상태로 짐작 — Edge 길
export function failureFromStatus(status: number | null): EdgeFailure {
  if (status == null) return 'UNKNOWN';
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'INTERNAL';
  return 'UNKNOWN'; // 404는 함수가 배포되지 않았을 때도 나와서 "찾을 수 없어요"로 보이면 헷갈림
}

// 우리 서버 길: 앞단 nginx가 만든 JSON이 아닌 오류를 상태로 짐작 — 413은 요청이 너무 큼(입력 문제), 504는 기다리다 포기(느림). 나머지는 Edge 길과 같음.
// Edge 길(failureFromStatus)은 안 바꿈 — 음성 보류 기록 · 사진 문구가 이 코드를 보고 갈려서, 지금 배포돼도 기존 호출자 동작이 그대로여야 함
function serverFailureFromStatus(status: number | null): EdgeFailure {
  if (status === 413) return 'VALIDATION_FAILED';
  if (status === 504) return 'TIMEOUT';
  return failureFromStatus(status);
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

type ErrorBody = { code: string; message: string | null; details: unknown };

// 우리 서버만 돌려주는 코드 — Edge의 ERROR_STATUS(@shared/errors.ts)에는 없음
const SERVER_ONLY_CODE = 'AUTH_UNAVAILABLE';

// JSON을 { error: { code, message, details } }로 읽음. 아니면 null (다른 모양)
function parseErrorBody(json: unknown): ErrorBody | null {
  const error = isRecord(json) ? json.error : null;
  if (!isRecord(error) || typeof error.code !== 'string') return null;
  return { code: error.code, message: typeof error.message === 'string' ? error.message : null, details: error.details };
}

// Response 본문을 읽음. 본문이 JSON이 아니면 null
async function readErrorBody(response: unknown): Promise<ErrorBody | null> {
  try {
    return parseErrorBody(await (response as { json(): Promise<unknown> }).json());
  } catch {
    return null;
  }
}

// 상태 · requestId · 읽은 본문 → EdgeError (Edge 응답과 우리 서버 응답이 같이 씀. 상태로 짐작하는 방식만 길마다 다름)
function edgeErrorFrom(
  status: number | null,
  requestId: string | null,
  body: ErrorBody | null,
  fromStatus: (status: number | null) => EdgeFailure = failureFromStatus,
): EdgeError {
  if (body) {
    // 모르는 code(서버가 새로 더한 것)는 상태로 짐작한 갈래의 문구 — 그래도 모르면 기본 문구
    const known = Object.hasOwn(ERROR_STATUS, body.code) || body.code === SERVER_ONLY_CODE;
    const code = known ? (body.code as EdgeFailure) : fromStatus(status);
    return new EdgeError(code, { status, details: body.details, requestId, serverMessage: body.message });
  }
  return new EdgeError(fromStatus(status), { status, requestId });
}

// supabase.functions.invoke가 준 error를 EdgeError로 바꿈 (시험에서 가짜 error를 넣어 확인)
export async function toEdgeError(error: unknown): Promise<EdgeError> {
  if (error instanceof FunctionsHttpError) {
    const response = error.context as { status?: number; headers?: { get(name: string): string | null } } | undefined;
    const status = typeof response?.status === 'number' ? response.status : null;
    const requestId = response?.headers?.get?.('x-request-id') ?? null;
    return edgeErrorFrom(status, requestId, await readErrorBody(response));
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

// 우리 서버를 못 쓰는 상태 — 읽기 함수의 Edge 대체와 차단기 횟수의 기준:
//   네트워크 · 시간 초과 · 서버 오류(INTERNAL) · 공개 키를 못 받음(AUTH_UNAVAILABLE) · 서버 설정이 안 됨(NOT_CONFIGURED — 예: 카카오 키가 아직 안 들어감, Edge에는 있음)
//   읽기 함수는 여기에 경로가 없음(404 · 405 — 서버 이미지를 되돌렸거나 아직 안 올린 경우)도 포함. 장소 함수는 정상 응답으로 404를 주지 않음.
// 서버가 정상으로 거절한 것(4xx)과 카카오 같은 바깥 서비스 문제(PLACE_UNAVAILABLE · ROUTE_UNAVAILABLE …)는 해당 안 됨 — Edge로 보내도 같은 결과
const SERVER_UNUSABLE_CODES: readonly EdgeFailure[] = ['NETWORK', 'TIMEOUT', 'INTERNAL', 'AUTH_UNAVAILABLE', 'NOT_CONFIGURED'];
const serverUnusable = (error: EdgeError, read: boolean): boolean =>
  SERVER_UNUSABLE_CODES.includes(error.code) || (read && (error.status === 404 || error.status === 405));
// 부작용이 없어 Edge로 한 번 더 불러도 안전한 함수. 쓰기 함수(alarm-commit · appointment-edit · alarm-roll …)는 넣지 않음.
// alarm-suggest(미리보기)는 2-6 "미리보기 · 저장 · 장소 전환"에서 서버로 옮길 때 같이 정함
export const READ_FUNCTIONS: ReadonlySet<string> = new Set(['place-search', 'place-reverse']);
const SERVER_READ_TIMEOUT_MS = 4_000; // 읽기 함수가 서버를 기다리는 시간(설계 3~5초) — 넘기면 Edge로

const warn = (message: string) => {
  if (__DEV__) console.warn(message);
};

// 앱은 이 함수 하나로만 서버 함수를 부름 — 표(edgeRoutes.ts)가 server라고 한 함수는 우리 서버로, 아니면 Edge로
export async function callEdge<T>(name: string, body?: Record<string, unknown>, options: EdgeOptions = {}): Promise<T> {
  if ((await routeFor(name)) === 'server') return callServer<T>(name, body, options);
  return callEdgeFunction<T>(name, body, options);
}

// ---------- 우리 서버 길 ----------

async function callServer<T>(name: string, body: Record<string, unknown> | undefined, options: EdgeOptions): Promise<T> {
  const read = READ_FUNCTIONS.has(name);
  if (read && !claimServerAttempt()) return callEdgeFunction<T>(name, body, { ...options, retry: 0 }); // 차단기가 열림(또는 시험 한 건이 진행 중) — 서버는 건너뜀

  const timeoutMs = read ? Math.min(options.timeoutMs ?? SERVER_READ_TIMEOUT_MS, SERVER_READ_TIMEOUT_MS) : (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const attempts = read ? 1 : 1 + Math.max(0, options.retry ?? 0); // 읽기 함수: 서버 1번 → (실패하면) Edge 1번으로 끝
  let last: EdgeError | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const data = await postServer<T>(name, body, options.idempotencyKey, timeoutMs);
      recordServerSuccess();
      return data;
    } catch (e) {
      last = e instanceof EdgeError ? e : new EdgeError('UNKNOWN');
      if (serverUnusable(last, read)) {
        if (recordServerFailure()) warn('[edge] 서버를 연속 3번 못 씀 — 5분 동안 읽기 함수는 서버를 건너뛰고 Edge로 바로 보냄');
      } else if (last.status !== null) recordServerSuccess(); // 서버가 답함(정상 거절 4xx · 바깥 서비스 문제) = 살아 있음
      if (!RETRYABLE.includes(last.code)) break;
    }
  }
  if (read && last && serverUnusable(last, true)) {
    // 로그에는 함수 이름 · 코드 · requestId만 — 요청 내용(검색어 · 좌표)과 토큰은 안 남김
    warn(`[edge] 서버 실패 → Edge로 한 번 더 name=${name} code=${last.code} requestId=${last.requestId ?? '-'}`);
    return callEdgeFunction<T>(name, body, { ...options, retry: 0 });
  }
  throw last ?? new EdgeError('UNKNOWN');
}

type ServerReply = { ok: boolean; status: number; requestId: string | null; text: string };

async function accessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new EdgeError('AUTH_REQUIRED');
  return token;
}

async function refreshedToken(): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.refreshSession();
    return error ? null : (data.session?.access_token ?? null);
  } catch {
    return null;
  }
}

const isAbort = (error: unknown) => (error as { name?: unknown } | null)?.name === 'AbortError';

// 시간 제한은 응답 본문을 다 읽을 때까지 (헤더만 오고 본문이 멈추는 경우도 TIMEOUT).
// 시간 초과인지는 오류 이름이 아니라 "우리 타이머가 취소했는지(signal.aborted)"로 판정 — 폰(Expo SDK 57)의 fetch는 취소하면 이름이 'Error'인 오류를 던지고,
// 본문을 읽다 취소되면 받은 만큼의 잘린 본문으로 끝나기도 함
async function fetchServer(url: string, body: Record<string, unknown> | undefined, token: string, idempotencyKey: string | undefined, timeoutMs: number): Promise<ServerReply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body ?? {}), signal: controller.signal });
    const text = await response.text();
    if (controller.signal.aborted) throw new EdgeError('TIMEOUT'); // 본문을 읽는 중 취소돼 잘린 본문으로 끝난 경우
    return { ok: response.ok, status: response.status, requestId: response.headers.get('x-request-id'), text };
  } catch (error) {
    if (error instanceof EdgeError) throw error;
    throw new EdgeError(controller.signal.aborted || isAbort(error) ? 'TIMEOUT' : 'NETWORK');
  } finally {
    clearTimeout(timer);
  }
}

const NOT_JSON = Symbol('not-json');

// JSON이 아니면 NOT_JSON (JSON null 본문과 구분)
function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

const errorJson = (text: string): unknown => {
  const json = tryJson(text);
  return json === NOT_JSON ? null : json;
};

// 서버 한 번 호출 — 401이면 토큰을 갱신해 한 번만 다시. 실패는 EdgeError로 던짐
async function postServer<T>(name: string, body: Record<string, unknown> | undefined, idempotencyKey: string | undefined, timeoutMs: number): Promise<T> {
  const base = serverBaseUrl(process.env.EXPO_PUBLIC_API_BASE_URL);
  if (!base) throw new EdgeError('UNKNOWN'); // routeFor가 이미 걸러서 오지 않음
  let token = await accessToken();
  for (let pass = 0; ; pass++) {
    const reply = await fetchServer(`${base}/fn/${encodeURIComponent(name)}`, body, token, idempotencyKey, timeoutMs);
    if (reply.ok) {
      if (!reply.text) return undefined as T;
      const json = tryJson(reply.text);
      if (json === NOT_JSON) throw new EdgeError('INTERNAL', { status: reply.status, requestId: reply.requestId }); // 2xx인데 JSON이 아님 — 앞단이 이상함
      return json as T;
    }
    const error = edgeErrorFrom(reply.status, reply.requestId, parseErrorBody(errorJson(reply.text)), serverFailureFromStatus);
    if (reply.status === 401 && pass === 0) {
      const fresh = await refreshedToken();
      if (fresh) {
        token = fresh;
        continue;
      }
    }
    throw error;
  }
}

// ---------- Edge 길 (supabase.functions.invoke) ----------

async function callEdgeFunction<T>(name: string, body: Record<string, unknown> | undefined, options: EdgeOptions): Promise<T> {
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
