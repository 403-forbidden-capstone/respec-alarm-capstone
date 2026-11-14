// briefing-device — 백그라운드 브리핑 갱신(#515)용 기기 키 발급 · 폐기. 앱이 로그인 토큰으로 부름 (mobile lib/alarmSync/briefingDevice.ts)
//   요청: { action: 'issue' | 'revoke', device_id: uuid }
//   응답: issue → { token, expires_at } (원문은 이 응답에만 — 앱이 바로 네이티브 Keystore 저장소에 넘김), revoke → { revoked: true }
//   키로 할 수 있는 일은 본인 기상 알람 브리핑 받기(alarm-briefing-device)뿐. 줄은 서버 키로만 씀 (briefing_devices는 앱 권한 없음) — 늘 로그인한 user_id로
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { requireUser } from '../_shared/auth.ts';
import { issueDeviceKey, revokeDeviceKey } from '../_shared/briefing-device.ts';
import { HttpError } from '../_shared/errors.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { readJson } from '../_shared/read.ts';
import { createServiceClient } from '../_shared/supabase.ts';

Deno.serve(
  serve(async (req) => {
    const { userId } = await requireUser(req);
    const body = (await readJson(req)) as { action?: unknown; device_id?: unknown };
    const deviceId = typeof body?.device_id === 'string' ? body.device_id : '';
    if (body?.action === 'issue') return jsonResponse(await issueDeviceKey(createServiceClient(), userId, deviceId, Date.now()));
    if (body?.action === 'revoke') {
      await revokeDeviceKey(createServiceClient(), userId, deviceId);
      return jsonResponse({ revoked: true });
    }
    throw new HttpError('VALIDATION_FAILED', "action은 'issue' 또는 'revoke'예요");
  }),
);
