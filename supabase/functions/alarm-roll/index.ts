// alarm-roll — 반복 약속 · 일정 없는 반복 알람의 다음 회차를 앞으로 14일치 미리 만들고, 루틴 알람의 시각을 다음 발생으로 옮김 (상세설계서 5장 5.3 #17 · 7장 7.1.5, D4 A)
//   배치 길:  pg_cron이 5분마다 pg_net으로 부름 (private.invoke_edge_function — 서비스 키, supabase/README.md "배치"). 일이 있는 묶음 50개 · 길찾기 20번 · 40초 안
//            service_role이라 RLS를 안 타므로 읽기 · 쓰기마다 사용자(creator_id · user_id)로 직접 좁힘
//   본인 길:  앱 syncNow · 반복 일정 저장 직후가 로그인 토큰으로 부름. 읽기는 부른 사람의 RLS, 쓰기는 service_role(alarm-commit과 같음). 길찾기 최대 4회차
//            요청 { series_id? } — 있으면 그 묶음의 회차를 먼저. 본문은 {} 라도 보냄
//   응답:    { created, moved_alarm_ids, pending, ring_packages, canceled_alarm_ids, kakao_calls } (본인 길만 ring_packages를 채움 — 앱이 알람 코어에 그대로 넘김)
//   verify_jwt = false (config.toml): 키 형식이 legacy JWT · sb_secret_ 둘 다일 수 있고 두 길이 한 함수라서, 게이트웨이 대신 코드(isServiceCall · requireUser)가 가름
// 본문은 _shared/roll.ts (가짜 DB로 시험). 여기는 길 가르기와 연결만
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { isServiceCall, requireUser } from '../_shared/auth.ts';
import { getEnv } from '../_shared/env.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { kakaoTravelMinutes } from '../_shared/kakao.ts';
import { Reader, readJson } from '../_shared/read.ts';
import { readRollRequest, runRoll, type TravelLookup } from '../_shared/roll.ts';
import { createServiceClient } from '../_shared/supabase.ts';

Deno.serve(
  serve(async (req) => {
    const now = new Date();
    const kakaoKey = getEnv('KAKAO_REST_API_KEY');
    const lookup: TravelLookup | undefined = kakaoKey ? (args) => kakaoTravelMinutes(kakaoKey, args) : undefined;

    if (isServiceCall(req)) {
      const service = createServiceClient();
      return jsonResponse(await runRoll({ path: 'batch', now, read: service, write: service, lookup }));
    }

    const user = await requireUser(req);
    const root = Reader.root(await readJson(req));
    const { seriesId } = readRollRequest(root);
    root.finish();
    return jsonResponse(await runRoll({ path: 'own', now, read: user.db, write: createServiceClient(), lookup }, { userId: user.userId, seriesId }));
  }),
);
