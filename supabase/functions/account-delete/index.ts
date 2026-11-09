// account-delete — 설정 > [계정 삭제] (친구 12장). 두 번 확인한 뒤 앱이 부름
//   입력: 본문 없음 또는 {} (본인만. userId를 보내면 로그인한 사람 것과 같아야 하고 다르면 403)
//   처리: prepare_account_delete(개인 약속 삭제 · 모든 그룹 나가기 · 푸시 토큰 삭제) → 계정 삭제. 공동 약속은 지우지 않고 만든 사람 칸만 비어 남음
//   응답: { deleted: true, groups_left, groups_deleted, group_appointments_kept }
//   로그인이 없거나 삭제 직후의 같은 토큰은 401. 중간에 실패하면 다시 부르면 이어서 끝남
// 본문은 _shared/account.ts (가짜 DB로 시험). 여기는 로그인 확인과 연결만
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { readAccountDeleteBody, runAccountDelete, type AccountService } from '../_shared/account.ts';
import { requireUser } from '../_shared/auth.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { createServiceClient } from '../_shared/supabase.ts';

Deno.serve(
  serve(async (req) => {
    const user = await requireUser(req);
    await readAccountDeleteBody(req, user.userId);
    return jsonResponse(await runAccountDelete(createServiceClient() as unknown as AccountService, user.userId));
  }),
);
