// suggestion-generate — 알람 조정 제안 만들기 (ALG-07, #49 · 안건 D111)
//   배치 길만: pg_cron이 매일 18:00 KST(09:00 UTC)에 pg_net으로 부름 (private.invoke_edge_function — 서비스 키, supabase/README.md "배치")
//   service_role이라 RLS를 안 타고, 재료 함수(prepare_suggestion_inputs)가 사람마다 좁혀서 줌
//   응답: { candidates, created, skipped }
//   verify_jwt = false (config.toml): 다른 배치와 같이 게이트웨이 대신 코드(isServiceCall)가 가름 — 서비스 키가 아니면 403
// 본문은 _shared/suggest-run.ts (가짜 DB로 시험). 여기는 길 가르기와 연결만
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { isServiceCall } from '../_shared/auth.ts';
import { HttpError } from '../_shared/errors.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { runSuggest } from '../_shared/suggest-run.ts';
import { createServiceClient } from '../_shared/supabase.ts';

Deno.serve(
  serve(async (req) => {
    if (!isServiceCall(req)) throw new HttpError('FORBIDDEN', '이 작업을 할 권한이 없어요');
    return jsonResponse(await runSuggest(createServiceClient(), new Date()));
  }),
);
