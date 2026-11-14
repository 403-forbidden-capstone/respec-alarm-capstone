// alarm-briefing-device — 폰 백그라운드 갱신(#515)이 앱 없이 기상 알람 브리핑을 다시 받는 길 (네이티브 BriefingRefreshWorker가 부름)
//   새벽 4:10(전날 대화 자동 정리 뒤) 정확 알람 → WorkManager → 여기. 결과를 폰 VoiceBriefing 저장소에 그대로 씀 (앱의 prepareBriefings와 같은 저장)
//   인증: 기기 키(Authorization: Bearer bdk_…, _shared/briefing-device.ts) — 로그인 토큰이 아니라서 게이트웨이 JWT 검사를 끄고 코드에서 확인 (voice-commit과 같은 방식)
//   할 수 있는 일: 키 주인의 기상(WAKE) 알람 브리핑만. 출발 · 남의 알람 · 꺼진 알람은 NOT_FOUND
//   읽기는 서버 키 + 모든 쿼리에 user_id 조건 (_shared/briefing-handler.ts). 대본 캐시(wake_scripts) · 음성 열쇠(have) · 'AW' · 'AV' 한도는 앱 길과 같음
//   요청 · 응답: alarm-briefing과 같음 ({ alarm_id, have } → BriefingOut + refresh_at)
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { briefAlarm } from '../_shared/briefing-handler.ts';
import { deviceUser } from '../_shared/briefing-device.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { createServiceClient } from '../_shared/supabase.ts';

Deno.serve(
  serve(async (req) => {
    const service = createServiceClient();
    const userId = await deviceUser(service, req, Date.now());
    const body = (await req.json().catch(() => ({}))) as { alarm_id?: unknown; have?: unknown };
    return jsonResponse(await briefAlarm({ userId, db: service, service, kinds: ['WAKE'] }, body));
  }),
);
