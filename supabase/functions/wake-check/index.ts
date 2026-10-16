// wake-check — 기상 미확인(MISSED) 기록 배치 (상세설계서 5장 5.7 · 7장 7.9.2). 서버 전용
//   pg_cron이 5분마다 pg_net으로 부름 (private.invoke_edge_function — 주소 · 키는 Vault, supabase/README.md "배치")
//   처리: find_missed_wake_alarms(DB 함수)가 "알람 시각 + 다시 울림 총 소요 + 미루기 누적 + 30분"이 지났는데 기상 확인이 없는 알람을 찾음
//        → alarm_events에 MISSED로 기록. client_event_id = event_key라서 겹쳐 돌거나 다시 돌아도 한 번만 들어감
//   푸시: 그룹에 알리는 미확인 푸시는 D19(기상 공유 동의 조건)가 정해질 때까지 안 보냄 — 기록만 남김 (자리는 _shared/wake.ts pushMissedToGroup)
//   verify_jwt = false (config.toml): 키 형식이 legacy JWT · sb_secret_ 둘 다일 수 있어 게이트웨이 대신 여기서 서비스 키를 직접 비교
// 본문은 _shared/wake.ts (가짜 DB로 시험). 여기는 키 확인과 연결만
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { requireServiceCall } from '../_shared/auth.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { runWakeCheck } from '../_shared/wake.ts';

Deno.serve(
  serve(async (req) => {
    requireServiceCall(req);
    return jsonResponse(await runWakeCheck(createServiceClient(), new Date()));
  }),
);
