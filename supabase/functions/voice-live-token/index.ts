// voice-live-token — 실시간 음성 대화(Gemini Live) 1회용 토큰 발급 (decisions.md D7: Gemini Live 단말 직결)
//   앱은 이 토큰으로 Gemini Live WebSocket에 바로 붙음. GEMINI_API_KEY는 서버에만 있고 앱에는 1회용 토큰만 감
//   토큰은 모델 · 응답 형식 · 지침을 서버가 잠가서(liveConnectConstraints) 앱이 바꿀 수 없음 — 본문 · 지침은 _shared/ai/live-token.ts
//   하루 10번(글 대화 한도와 따로) + 전체 AI 호출 상한, 발급마다 ai_calls 한 줄(지점 'LV') — _shared/ai/live-quota.ts
//   요청: 본문 없음  응답: { token, model, left_today }
//   오류: AUTH_REQUIRED · RATE_LIMITED(오늘 횟수 다 씀) · NOT_CONFIGURED(키 없음) · VOICE_UNAVAILABLE(Google이 토큰을 안 줌 → 앱은 글 대화로)
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { handleLiveToken } from '../_shared/ai/live-quota.ts';
import { requireUser } from '../_shared/auth.ts';
import { requireEnv } from '../_shared/env.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { createServiceClient } from '../_shared/supabase.ts';

Deno.serve(
  serve(async (req) => {
    const user = await requireUser(req);
    const apiKey = requireEnv('GEMINI_API_KEY');
    return jsonResponse(await handleLiveToken({ userId: user.userId, userDb: user.db, service: createServiceClient(), apiKey }));
  }),
);
