// voice-commit — AI 대화 끝 정리 (서버 PR 5). 두 길이 한 함수 (alarm-roll과 같은 방식, verify_jwt = false — 키 확인은 코드에서)
//   본인 길: 앱 [완료] 뒤 로그인 토큰으로 한 번, 실패하면 같은 요청을 다시 보냄(결과는 한 번만 저장). requireUser(auth.getUser)가 로그인 확인
//   자동 정리 길: pg_cron이 10분마다 서비스 키로 부름(isServiceCall) — [완료] 없이 지난 기준일 대화를 정리 (_shared/ai/auto-commit.ts). 본문은 안 읽음
//     pg_net이 10초만 기다려서 바로 202 { accepted, run_id }로 답하고 정리는 EdgeRuntime.waitUntil로 뒤에서 — 결과는 함수 로그([auto-commit] 시작 · 완료 · 실패)
//   요청: { session_id, rejected_cards?: [카드 번호] } — rejected_cards는 앱이 [저장 안 함]을 눌렀는데 서버에 못 알렸을 수 있는 카드 (서버가 열린 카드만 REJECTED로)
//   응답: { session_id, status: DONE | PARTIAL | RUNNING | SKIPPED, saved: { todos, daily_records, daily_journals }, pending: [확인이 필요한 것], failed: [실패한 저장 단계] }
//   T2(대화 전체 추출) 한 번 → 공개 JSON structured.v1(conversation_sessions.extracted_data) + 할 일 · 준비물(todos) · 생활 기록 진술 칸의 빈 칸(daily_records)만 저장.
//   그 JSON이 저장되면 T5(Flash-Lite) 한 번으로 그날 일기 1~2문장(daily_journals.ai_summary, 사용자가 고친 일기는 그대로)
//   지각 · 출발 · 도착(appointment_participants) · 알람 반응(alarm_events)은 쓰지 않음(JSON에만). 일정 · 알람은 저장하지 않음(대화 중 카드로 확인)
//   오류: AUTH_REQUIRED · VALIDATION_FAILED · NOT_FOUND · CONFLICT · NOT_CONFIGURED(키 없음) · LLM_UNAVAILABLE · INTERNAL
//   처리 순서 · 다시 시도 규칙은 _shared/ai/voice-commit.ts. 앱 타임아웃은 45초(T2 19초 × 다시 시도 1번 · T5 9초는 T2가 보통 빠를 때 안에 듦)
//   비밀값: voice-turn과 같음 (GEMINI_API_KEY · GEMINI_TEXT_MODEL · AI_LIMIT_* · AI_LOG_IO_USER_IDS)
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { startAutoCommit } from '../_shared/ai/auto-commit.ts';
import { geminiClient, geminiModel } from '../_shared/ai/gemini.ts';
import { QuotaGate, quotaFromEnv } from '../_shared/ai/quota.ts';
import { handleVoiceCommit } from '../_shared/ai/voice-commit.ts';
import { isServiceCall, requireUser } from '../_shared/auth.ts';
import { getEnv } from '../_shared/env.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { readJson } from '../_shared/read.ts';
import { createServiceClient } from '../_shared/supabase.ts';

Deno.serve(
  serve(async (req) => {
    const ioUserIds = (getEnv('AI_LOG_IO_USER_IDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const quota = new QuotaGate(quotaFromEnv(getEnv));
    if (isServiceCall(req)) {
      const started = startAutoCommit({ service: createServiceClient(), llm: geminiClient(), model: geminiModel(), ioUserIds, quota }, (p) => EdgeRuntime.waitUntil(p));
      return jsonResponse(started, 202);
    }
    const user = await requireUser(req);
    const body = await readJson(req);
    return jsonResponse(
      await handleVoiceCommit({ userId: user.userId, userDb: user.db, service: createServiceClient(), llm: geminiClient(), model: geminiModel(), ioUserIds, quota }, body),
    );
  }),
);
