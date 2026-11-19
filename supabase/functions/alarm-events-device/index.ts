// alarm-events-device — 폰 네이티브(WorkManager)가 앱을 열지 않고 알림 버튼 기록 · 자동 기상 판정을 올리는 길
//   알림 버튼([준비 시작] · [출발했어요] · [도착했어요])을 누르거나 기상 알람을 끄면 바로, 기상 알람을 끈 10분 뒤 폰이 스스로 판정해 확정이면 한 번 부름
//   인증: 기기 키(Authorization: Bearer bdk_…, _shared/briefing-device.ts) — alarm-briefing-device와 같은 키 · 같은 방식이라 게이트웨이 JWT 검사를 끄고 코드에서 확인
//   할 수 있는 일: 키 주인의 알람에 대한 기록 올리기뿐 (남의 알람은 건너뜀). 쓰는 규칙은 _shared/device-events.ts
//   요청: { events?: [{ alarm_id, client_event_id, event_type, event_at, sequence_no?, snooze_minutes?, input_source }], wake?: { alarm_id, record_date, wake_confirmed_at, wake_reported_at? } }
//   응답: { stored, skipped, wake_recorded }
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { deviceUser } from '../_shared/briefing-device.ts';
import { recordDeviceEvents } from '../_shared/device-events.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { readJson } from '../_shared/read.ts';
import { createServiceClient } from '../_shared/supabase.ts';

Deno.serve(
  serve(async (req) => {
    const service = createServiceClient();
    const userId = await deviceUser(service, req, Date.now());
    return jsonResponse(await recordDeviceEvents(service, userId, await readJson(req)));
  }),
);
