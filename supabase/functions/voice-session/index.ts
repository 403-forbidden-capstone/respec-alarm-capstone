// voice-session — 자기 전 대화 시작 · 이어 받기 (상세설계서 5장 5.4.7, 텍스트라 token · endpoint 없음)
//   요청: { session_type: 'BEFORE_SLEEP', input_mode: 'TEXT', resume }  응답: 세션 번호 · 대화 기준일 · 첫 마디(서버 템플릿) · 카드 · 상한 (설계 메모 2.1)
//   LLM을 안 부르므로 ANTHROPIC_API_KEY가 없어도 동작. 읽기는 부른 사람의 RLS, 세션 줄 쓰기는 서버 키
//   오류: AUTH_REQUIRED · VALIDATION_FAILED · INTERNAL. 하루 대화 상한은 오류가 아니라 session_id: null + limits.reached: 'DAY'
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { handleVoiceSession } from '../_shared/ai/voice-session.ts';
import { requireUser } from '../_shared/auth.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { readJson } from '../_shared/read.ts';
import { createServiceClient } from '../_shared/supabase.ts';

Deno.serve(
  serve(async (req) => {
    const user = await requireUser(req);
    const body = await readJson(req);
    return jsonResponse(await handleVoiceSession({ userId: user.userId, userDb: user.db, service: createServiceClient() }, body));
  }),
);
