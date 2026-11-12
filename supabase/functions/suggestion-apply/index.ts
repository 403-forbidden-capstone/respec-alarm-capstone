// suggestion-apply — 알람 조정 제안 적용 · 고쳐 적용 · 무시 · 되돌리기 (ALG-07 · 안건 D111 · D23 A). 지금은 준비 알람 당김(PREPARE_ADVANCE)만
//   본인 길만: 앱(S01 · 그룹 탭 카드) · 저녁 대화 카드가 로그인 토큰으로 부름. 읽기는 부른 사람의 RLS, 쓰기는 service_role(사용자로 좁힘 — alarm-commit과 같음)
//   요청: { suggestion_id, action: APPLY | EDIT | IGNORE | REVERT, minutes? (EDIT — 더 당길 분) }
//   응답: { suggestion_id, status, advance, ring_packages, moved_alarm_ids } — 앱이 ring_packages를 알람 코어에 그대로 넘김
// 본문은 _shared/suggest-apply.ts (가짜 DB로 시험). 여기는 연결만
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { requireUser } from '../_shared/auth.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { Reader, readJson } from '../_shared/read.ts';
import { readApplyRequest, runSuggestApply } from '../_shared/suggest-apply.ts';
import { createServiceClient } from '../_shared/supabase.ts';

Deno.serve(
  serve(async (req) => {
    const user = await requireUser(req);
    const root = Reader.root(await readJson(req));
    const request = readApplyRequest(root);
    root.finish();
    return jsonResponse(await runSuggestApply({ db: user.db, write: createServiceClient(), userId: user.userId, now: new Date() }, request));
  }),
);
