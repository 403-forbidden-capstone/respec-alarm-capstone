// voice-turn — 자기 전 대화 한 턴 (새 함수 — 5장에 없음, 설계 메모 2.2 · 14절)
//   요청: { session_id, rev, client_turn_id, text } | { …, results } | { …, card_action } 중 하나
//   응답: { rev, turn_seq, next: USER | APP_TASKS, reply, cards(전체 목록), fixes, limits }
//   T2F(빠른 추출) ∥ T1(대화 답) → 턴 처리(turn-core) → 가드(guards). 모델 호출마다 ai_calls 한 줄(서버 키)
//   오류: AUTH_REQUIRED · VALIDATION_FAILED · NOT_FOUND · CONFLICT(rev 어긋남) · NOT_CONFIGURED(키 없음) · LLM_UNAVAILABLE(details: { cards, fixes }) · INTERNAL
//   서버 전체 마감 18초 — 앱 타임아웃은 25초(lib/edge 기본 20초로는 모자람)
//   비밀값: ANTHROPIC_API_KEY · ANTHROPIC_MODEL(선택) · AI_LOG_IO_USER_IDS(선택, 쉼표로 나눈 사용자 id — 이 사용자들의 호출 입력 · 출력 글만 ai_calls.io에 남김)
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { anthropicClient, model } from '../_shared/ai/anthropic.ts';
import { handleVoiceTurn } from '../_shared/ai/turn.ts';
import { requireUser } from '../_shared/auth.ts';
import { getEnv } from '../_shared/env.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { readJson } from '../_shared/read.ts';
import { createServiceClient } from '../_shared/supabase.ts';

Deno.serve(
  serve(async (req) => {
    const user = await requireUser(req);
    const body = await readJson(req);
    const ioUserIds = (getEnv('AI_LOG_IO_USER_IDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return jsonResponse(
      await handleVoiceTurn({ userId: user.userId, userDb: user.db, service: createServiceClient(), llm: anthropicClient(), model: model(), ioUserIds }, body),
    );
  }),
);
