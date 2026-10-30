// timetable-extract — 시간표 사진(base64) → Claude(Haiku 5.5, 사진 읽기) → 수업 줄 JSON (D66-1 A 캡처)
//   요청: { media_type: 'image/jpeg' | 'image/png' | 'image/webp', image_base64 }  (원본 4MB 이하, data: 머리말 없이)
//   응답: { rows: [{ title, weekdays[], start, end, place }], confidence: HIGH | MEDIUM | LOW, left_today }
//   사진은 저장하지 않음 — ai_calls에는 호출 한 줄(지점 'TT', 토큰 · 비용 · 지연)만, io는 null. 하루 10번(성공 · 실패 모두 셈) + 전체 AI 호출 상한
//   오류: AUTH_REQUIRED · VALIDATION_FAILED · RATE_LIMITED(오늘 횟수 다 씀) · NOT_CONFIGURED(키 없음) · LLM_UNAVAILABLE(details: { code, requestId })
//   서버 마감 28초 — 앱 타임아웃은 35초(lib/edge 기본 20초로는 모자람)
//   비밀값: ANTHROPIC_API_KEY · ANTHROPIC_MODEL(선택) — voice-turn과 같은 서버 키, 앱에는 키 없음
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { anthropicClient, model } from '../_shared/ai/anthropic.ts';
import { requireUser } from '../_shared/auth.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { readJson } from '../_shared/read.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { handleTimetableExtract, MAX_REQUEST_CHARS } from '../_shared/timetable/extract.ts';

Deno.serve(
  serve(async (req) => {
    const user = await requireUser(req);
    const body = await readJson(req, MAX_REQUEST_CHARS);
    return jsonResponse(
      await handleTimetableExtract({ userId: user.userId, userDb: user.db, service: createServiceClient(), llm: anthropicClient(), model: model() }, body),
    );
  }),
);
