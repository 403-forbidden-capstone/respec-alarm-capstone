// alarm-briefing — 기상 알람 하나의 음성 브리핑을 미리 만들어 폰에 줌 (앱 lib/alarmSync/briefing.ts가 폰 예약을 맞춘 뒤 부름)
//   기상만 — 준비 시작 · 출발은 폰이 고정 문장을 Android TTS로 읽어서 받을 게 없음 (출발은 NOT_FOUND)
//   단계별 문장 · Android TTS 값은 늘 주고, Gemini 음성은 3 · 4단계가 실제로 올 수 있는 알람만 · 한도 안에서(4단계 먼저) · 폰에 없을 때만 만듦
//   알람이 울리는 순간에는 이 함수를 부르지 않음 — 폰은 저장해 둔 것만 씀
//   요청: { alarm_id, have?: string[] }  have = 폰에 이미 있는 Gemini 음성 열쇠
//   응답: BriefingOut (_shared/briefing-run.ts) + refresh_at (_shared/briefing-handler.ts)
//   로그인한 본인 알람만 (사용자 DB = RLS + user_id). 한도 셈 · 호출 기록만 서비스 키(프로젝트 전체를 세야 함). 음성은 서버에 저장하지 않음
//   기상 알람은 Gemini 텍스트로 1~4단계 개인화 대본을 한 번에 만들어 씀 (_shared/wake-script.ts, 같은 입력이면 wake_scripts에 저장된 것)
//   몸통은 _shared/briefing-handler.ts — 폰 백그라운드 갱신(alarm-briefing-device, 기기 키)과 같이 씀 (#515)
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { requireUser } from '../_shared/auth.ts';
import { briefAlarm } from '../_shared/briefing-handler.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { createServiceClient } from '../_shared/supabase.ts';

Deno.serve(
  serve(async (req) => {
    const { userId, db } = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { alarm_id?: unknown; have?: unknown };
    return jsonResponse(await briefAlarm({ userId, db, service: createServiceClient(), kinds: ['WAKE'] }, body));
  }),
);
