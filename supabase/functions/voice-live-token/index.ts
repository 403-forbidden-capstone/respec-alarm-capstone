// voice-live-token — 실시간 음성 대화(Gemini Live) 1회용 토큰 발급 (decisions.md D7: Gemini Live 단말 직결)
//   앱은 이 토큰으로 Gemini Live WebSocket에 바로 붙음. GEMINI_API_KEY는 서버에만 있고 앱에는 1회용 토큰만 감
//   토큰은 모델 · 응답 형식 · 지침을 서버가 잠가서(liveConnectConstraints) 앱이 바꿀 수 없음 — 본문 · 지침은 _shared/ai/live-token.ts
//   1회용 · 1분 안에 연결 · 대화 최대 10분(토큰 만료). 로그인한 사용자만 (config.toml verify_jwt + requireUser)
//   요청: 본문 없음 | { session_id } — 있으면 그 대화방의 앞 대화(글 · 음성)를 지침에 붙여 Live가 이어서 답함 (내 세션만, 못 읽으면 앞 대화 없이)
//   응답: { token, model }
//   오류: AUTH_REQUIRED · NOT_CONFIGURED(키 없음) · VOICE_UNAVAILABLE(Google이 토큰을 안 줌)
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { createLiveToken, liveHistory } from '../_shared/ai/live-token.ts';
import { loadSession } from '../_shared/ai/session.ts';
import { requireUser } from '../_shared/auth.ts';
import { requireEnv } from '../_shared/env.ts';
import { jsonResponse, serve } from '../_shared/http.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(
  serve(async (req) => {
    const user = await requireUser(req);
    const key = requireEnv('GEMINI_API_KEY');
    let history = '';
    try {
      const raw = await req.text();
      const sid = raw.trim() ? (JSON.parse(raw) as { session_id?: unknown }).session_id : undefined;
      if (typeof sid === 'string' && UUID.test(sid)) {
        const row = await loadSession({ userId: user.userId, userDb: user.db, service: user.db }, sid);
        history = liveHistory(row.turns);
      }
    } catch (e) {
      console.error('[voice-live-token] 앞 대화를 못 읽음 — 없이 시작:', e);
    }
    return jsonResponse(await createLiveToken(key, { history }));
  }),
);
