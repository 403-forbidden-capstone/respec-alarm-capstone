// 요청 · 응답 틀 — CORS(OPTIONS) · 메서드 확인 · X-Request-Id · 오류를 5.2.1 모양으로 바꿈
// 순수 TS (Request · Response · crypto는 Deno · Node 둘 다 있음) — node --test로 시험
import { corsHeaders } from './cors.ts';
import { errorBody, HttpError } from './errors.ts';

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export function errorResponse(e: unknown, requestId: string): Response {
  const headers = { 'X-Request-Id': requestId };
  if (e instanceof HttpError) {
    return jsonResponse(errorBody(e.code, e.message, e.details), e.status, headers);
  }
  // 예상 못 한 오류 — 원문은 서버 로그에만 남기고 사용자에게는 일반 문구 (8장 8.1)
  console.error(`[${requestId}] unexpected error`, e);
  return jsonResponse(errorBody('INTERNAL', '잠시 후 다시 시도해 주세요'), 500, headers);
}

export type HandlerContext = { requestId: string };
export type Handler = (req: Request, ctx: HandlerContext) => Promise<Response>;

// Deno.serve(serve(handler))로 씀. OPTIONS는 바로 답하고, POST만 받음 (supabase.functions.invoke 기본)
export function serve(handler: Handler, methods: readonly string[] = ['POST']): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
    try {
      if (!methods.includes(req.method)) {
        throw new HttpError('METHOD_NOT_ALLOWED', `${methods.join(' · ')}만 받아요`);
      }
      const res = await handler(req, { requestId });
      res.headers.set('X-Request-Id', requestId);
      return res;
    } catch (e) {
      return errorResponse(e, requestId);
    }
  };
}
