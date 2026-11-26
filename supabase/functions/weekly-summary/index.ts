// weekly-summary — R02 주간 AI 요약. 그 주 하루 일기 글로 Gemini 텍스트 한 번 → weekly_summaries에 주마다 한 줄 (같은 기록이면 저장된 글, 호출 없음)
//   요청: { week_start: 'YYYY-MM-DD' (월요일) }
//   응답: { week_start, week_end, dates: [반영된 날짜], summary: 글 | null(그 주 일기 없음), generated_at, stale(바뀐 기록을 아직 반영 못 하고 저장된 글을 줌) }
//   오류: AUTH_REQUIRED · VALIDATION_FAILED · RATE_LIMITED(하루 10번) · NOT_CONFIGURED(키 없음) · LLM_UNAVAILABLE — 저장된 요약이 있으면 오류 대신 stale
//   처리 규칙은 _shared/weekly-summary.ts. 비밀값: voice-commit과 같은 GEMINI_API_KEY · GEMINI_TEXT_MODEL · AI_LIMIT_*
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { geminiClient, geminiModel } from '../_shared/ai/gemini.ts';
import { QuotaGate, quotaFromEnv } from '../_shared/ai/quota.ts';
import { requireUser } from '../_shared/auth.ts';
import { getEnv } from '../_shared/env.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { readJson } from '../_shared/read.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { handleWeeklySummary } from '../_shared/weekly-summary.ts';

Deno.serve(
  serve(async (req) => {
    const user = await requireUser(req);
    const body = await readJson(req);
    const gate = new QuotaGate(quotaFromEnv(getEnv));
    return jsonResponse(await handleWeeklySummary({ userId: user.userId, userDb: user.db, service: createServiceClient(), llm: geminiClient(), model: geminiModel(), gate }, body));
  }),
);
