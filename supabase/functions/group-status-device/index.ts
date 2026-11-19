// group-status-device — 기상 알람이 울릴 때 폰 네이티브(AlarmPlaybackService · GroupStatusVoice)가 그룹원 상태 안내를 받는 길. 울림마다(첫 울림 · 미루기 뒤 다시 울림) 한 번
//   인증: 기기 키(Authorization: Bearer bdk_…, _shared/briefing-device.ts) — alarm-events-device와 같은 키라 게이트웨이 JWT 검사를 끄고 코드에서 확인
//   할 수 있는 일: 키 주인이 그룹 화면에서 보는 그룹원 상태 읽기뿐 (group_wake_for_device = get_group_wake와 같은 계산 · 공유 범위, 상태를 새로 판정하지 않음)
//   요청: { level: 지금 울리는 음성 단계 1~4, text?, token? } · 응답: { text: 안내 문장 | null, token, level, audio: { mime, data(base64 WAV) } | null }
//   울림 회차마다 조회 1번 · 단계마다 음성 1번 (text를 주면 조회 없이 음성만). 문장 규칙 · 서명은 _shared/group-status.ts
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { createTts } from '../_shared/ai/tts.ts';
import { dbTtsQuota } from '../_shared/ai/tts-quota.ts';
import { deviceUser } from '../_shared/briefing-device.ts';
import { getEnv, serviceKey } from '../_shared/env.ts';
import { groupStatus } from '../_shared/group-status.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { readJson } from '../_shared/read.ts';
import { createServiceClient } from '../_shared/supabase.ts';

// 알람이 울리는 중이라 오래 못 기다림 — 넘으면 글만 주고 폰이 그 단계 Android TTS로 (폰 읽기 한도 15초 안)
const GROUP_TTS_TIMEOUT_MS = 10_000;

Deno.serve(
  serve(async (req) => {
    const service = createServiceClient();
    const userId = await deviceUser(service, req, Date.now());
    const key = getEnv('GEMINI_API_KEY');
    const deps = { tts: key ? createTts(key, fetch, GROUP_TTS_TIMEOUT_MS) : null, quota: dbTtsQuota(service, userId), secret: serviceKey() };
    return jsonResponse(await groupStatus(service, userId, await readJson(req), deps));
  }),
);
