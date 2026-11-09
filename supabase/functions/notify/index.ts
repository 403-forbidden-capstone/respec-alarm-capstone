// notify — 다른 사람 폰에 푸시 (screen-data-map: G03 깨우기 · G04 알람 바뀜 · F01 친구 요청 · G02 그룹 알림, 친구 논리설계 11장)
//   입력: { kind, targetUserId?, groupId?, appointmentId?, alarmId? } — 앱이 보낸 title · body · data는 읽지 않음 (옛 앱의 previousAt · newAt도 읽지 않음 — 알람 바뀜 문구의 시각은 제안 기록에서)
//   처리: ① 부른 사람 확인 ② can_send_push(한 사람) / plan_group_push(그룹, 받는 사람을 서버가 고름) — 서버 권한 판정(DB 함수, service_role 전용)
//        ③ push_tokens 조회 ④ 종류별 고정 문구 · 채널로 Expo Push (EXPO_ACCESS_TOKEN은 선택, 실패하면 한 번 더) ⑤ 접수 번호를 push_tickets에 기록 ⑥ 만료된 토큰 지움
//   응답: { sent, failed, reason? } — 토큰이 없거나 푸시 설정(FCM 키 · Expo 액세스 토큰)이 아직 없으면 오류가 아니라 { sent: 0, reason }
//   종류 · 문구 · 채널 · 권한: _shared/push-copy.ts · supabase/README.md
//   영수증 확인(15분 뒤)은 wake-check 배치가 함께 돌림
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
