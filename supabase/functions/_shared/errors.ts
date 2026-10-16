// 서버 함수 공통 오류 — 상세설계서 5장 5.2.1 `{ error: { code, message, details } }`
// 코드 이름은 5.2.1 표 그대로 (AUTH_REQUIRED · VALIDATION_FAILED · ...). 표에 없는 것은 아래에 "추가"로 표시
// 메시지는 화면에 그대로 보여 줘도 되는 짧은 한국어 (8장 8.1 "사용자 언어로 표시"), 코드는 앱이 문구를 고르는 데 씀
// 순수 TS — Deno · Node API 없음 (node --test로 시험)

export type ErrorCode =
  | 'VALIDATION_FAILED' // 400 필수 필드 누락 · 형식 오류
  | 'AUTH_REQUIRED' // 401 토큰 없음 · 만료 · 서비스 키 틀림
  | 'FORBIDDEN' // 403 권한 없음
  | 'NOT_FOUND' // 404
  | 'METHOD_NOT_ALLOWED' // 405 (추가)
  | 'CONFLICT' // 409
  | 'UNPROCESSABLE' // 422 계산 결과가 과거 시각 · 알람 순서 어긋남 등
  | 'RATE_LIMITED' // 429
  | 'INTERNAL' // 500
  | 'ROUTE_UNAVAILABLE' // 502 경로 API 장애 · 이동시간을 구할 길이 없음
  | 'PLACE_UNAVAILABLE' // 502 (추가) 장소 검색 API 장애
  | 'NOT_CONFIGURED'; // 503 (추가) 비밀값(카카오 키 등)이 아직 없음

export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  ROUTE_UNAVAILABLE: 502,
  PLACE_UNAVAILABLE: 502,
  NOT_CONFIGURED: 503,
};

export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export type ErrorBody = { error: { code: ErrorCode; message: string; details?: unknown } };

export function errorBody(code: ErrorCode, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}
