// voice-commit — AI 대화 끝 정리 (서버 PR 5). 앱 [완료] 뒤 한 번, 실패하면 같은 요청을 다시 보냄(결과는 한 번만 저장)
//   요청: { session_id, rejected_cards?: [카드 번호] } — rejected_cards는 앱이 [저장 안 함]을 눌렀는데 서버에 못 알렸을 수 있는 카드 (서버가 열린 카드만 REJECTED로)
//   응답: { session_id, status: DONE | PARTIAL | RUNNING | SKIPPED, saved: { todos, daily_record, journal, lates }, pending: [확인이 필요한 것], failed: [실패한 저장 단계] }
//   T2(대화 전체 추출) 한 번 → 할 일 · 준비물 · 생활 기록 · 지각 진술 · 일기 요약 저장. 일정 · 알람은 저장하지 않음(대화 중 카드로 확인)
//   오류: AUTH_REQUIRED · VALIDATION_FAILED · NOT_FOUND · CONFLICT · NOT_CONFIGURED(키 없음) · LLM_UNAVAILABLE · INTERNAL
//   처리 순서 · 다시 시도 규칙은 _shared/ai/voice-commit.ts. 앱 타임아웃은 45초(T2 19초 × 다시 시도 1번)
//   비밀값: voice-turn과 같음 (GEMINI_API_KEY · GEMINI_TEXT_MODEL · AI_LIMIT_* · AI_LOG_IO_USER_IDS)
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { geminiClient, geminiModel } from '../_shared/ai/gemini.ts';
import { QuotaGate, quotaFromEnv } from '../_shared/ai/quota.ts';
import { handleVoiceCommit } from '../_shared/ai/voice-commit.ts';
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
    const quota = new QuotaGate(quotaFromEnv(getEnv));
    return jsonResponse(
      await handleVoiceCommit({ userId: user.userId, userDb: user.db, service: createServiceClient(), llm: geminiClient(), model: geminiModel(), ioUserIds, quota }, body),
    );
  }),
);
