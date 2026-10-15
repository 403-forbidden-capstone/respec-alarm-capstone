// CORS — 웹 미리보기(Cloudflare)와 앱이 supabase.functions.invoke로 부름
// 인증은 Authorization 헤더(사용자 토큰)라 쿠키를 안 쓰므로 Origin은 모두 허용
export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, idempotency-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Expose-Headers': 'x-request-id',
  'Access-Control-Max-Age': '86400',
};
