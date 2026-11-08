// wake-check — 기상 미확인(MISSED) 기록 배치 (상세설계서 5장 5.7 · 7장 7.9.2). 서버 전용
//   pg_cron이 5분마다 pg_net으로 부름 (private.invoke_edge_function — 주소 · 키는 Vault, supabase/README.md "배치")
//   처리: find_missed_wake_alarms(DB 함수)가 "마지막으로 울리기 시작한 때(알람 시각 또는 마지막 미루기가 끝나 다시 울린 때) + 30분"이 지났는데 기상 확인이 없는 알람을 찾음
//        → alarm_events에 MISSED로 기록. client_event_id = event_key라서 겹쳐 돌거나 다시 돌아도 한 번만 들어감
//   푸시 (친구 8장): 새로 기록된 미확인의 주인에게 본인 알림, 10분 뒤 그날 그룹 약속의 그룹원 중 기상이 보이는 사람에게 '깨워 볼까요?', 본인이 늦게 확인하면 후속 1회
//        (받는 사람은 DB 함수 claim_wake_nudges가 정함, _shared/wake.ts). 푸시가 실패해도 MISSED 기록은 그대로
//   같은 배치에서 푸시 영수증도 확인함 (_shared/push-receipts.ts, 친구 11장): 15분 지난 접수 번호의 영수증을 받아 앱이 지워진 기기의 토큰을 지우고 push_tickets를 정리.
//   영수증 확인이 실패해도 MISSED 기록 결과는 그대로 돌려줌
//   verify_jwt = false (config.toml): 키 형식이 legacy JWT · sb_secret_ 둘 다일 수 있어 게이트웨이 대신 여기서 서비스 키를 직접 비교
// 본문은 _shared/wake.ts (가짜 DB로 시험). 여기는 키 확인과 연결만
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { requireServiceCall } from '../_shared/auth.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { getEnv } from '../_shared/env.ts';
import { runReceiptCheck } from '../_shared/push-receipts.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { runWakeCheck } from '../_shared/wake.ts';

Deno.serve(
  serve(async (req) => {
    requireServiceCall(req);
    const service = createServiceClient();
    const now = new Date();
    // MISSED 기록이 실패해도 영수증 확인은 돌리고(서로 안 막음), 실패는 그 뒤에 그대로 던짐
    let wake: Awaited<ReturnType<typeof runWakeCheck>> | undefined;
    let failure: unknown;
    try {
      wake = await runWakeCheck(service, now, { push: { accessToken: getEnv('EXPO_ACCESS_TOKEN') } });
    } catch (e) {
      failure = e;
    }
    const receipts = await runReceiptCheck(service, now, { accessToken: getEnv('EXPO_ACCESS_TOKEN') });
    if (failure) throw failure;
    return jsonResponse({ ...wake, receipts });
  }),
);
