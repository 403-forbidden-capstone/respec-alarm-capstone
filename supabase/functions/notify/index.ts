// notify — 다른 사람 폰에 푸시 (screen-data-map: G03 깨우기 · G04 알람 바뀜 · 미확인 알림)
//   입력: { kind, targetUserId, alarmId?, title, body, data? }
//   처리: ① 부른 사람 확인 ② can_send_push(부른 사람, 받는 사람, kind) — 서버 권한 판정(DB 함수, service_role 전용)
//        ③ push_tokens 조회 ④ Expo Push로 보냄 (EXPO_ACCESS_TOKEN은 선택) ⑤ 만료된 토큰 지움
//   응답: { sent, failed, reason? } — 토큰이 없거나 푸시 설정(FCM 키 · Expo 액세스 토큰)이 아직 없으면 오류가 아니라 { sent: 0, reason }
//   종류별 권한 (can_send_push, supabase/README.md):
//     ALARM_CHANGED — G04. 부른 사람이 받는 사람의 알람에 설정 권한(EDIT_ALARM)이 있을 때만 (D9: 변경 기록은 저장하지 않고 푸시만)
//     WAKE_PING     — G03 깨우기. D19(기상 공유 동의 조건) · D51(간격 제한)이 정해질 때까지 DB 함수가 늘 거절 → 403
// 본문은 _shared/notify.ts (가짜 DB로 시험). 여기는 로그인 확인과 연결만
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { requireUser } from '../_shared/auth.ts';
import { getEnv } from '../_shared/env.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { readNotifyRequest, runNotify } from '../_shared/notify.ts';
import { Reader, readJson } from '../_shared/read.ts';
import { createServiceClient } from '../_shared/supabase.ts';

Deno.serve(
  serve(async (req) => {
    const user = await requireUser(req);
    const request = readNotifyRequest(Reader.root(await readJson(req)));
    return jsonResponse(await runNotify(createServiceClient(), user.userId, request, { accessToken: getEnv('EXPO_ACCESS_TOKEN') }));
  }),
);
