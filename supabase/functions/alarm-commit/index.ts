// alarm-commit — 약속 · 참여 조건 · 알람을 한 번에 저장 (상세설계서 5장 5.4.2, 화면 H05 · H03 · S01)
//   약속 알람:   새 약속(appointment) 또는 기존 약속(appointment_id)에 내 참여 조건과 알람을 만들거나 고침.
//               기존 약속의 제목 · 시각 · 장소 · 중요도는 이 함수가 고치지 않음 (D41). 공동 약속은 멤버가 각자 appointment_id로 불러 자기 몫을 계산 (#46)
//   일정 없는 알람(type STANDALONE): 시각 + 반복(RRULE)만으로 기상 알람 하나 (D46 · Q10 B). 약속 · 루틴과 연결하지 않음
//   응답: 저장된 알람 + ring_packages(폰에 걸 예약 꾸러미, 알람 코어 RingPackage) + canceled_alarm_ids(폰에서 지울 예약, 반드시 같이 줌)
//   오류: VALIDATION_FAILED · NOT_FOUND · FORBIDDEN · UNPROCESSABLE(출발 시각까지 지남 · 알람 순서 어긋남) · ROUTE_UNAVAILABLE(이동시간을 정할 수 없음)
// 쓰기는 service_role로 하되, 읽기(약속 · 내 기록)는 부른 사람의 RLS로 해서 남의 일정에는 닿지 못함. 쓰는 순서 · 되돌리기는 _shared/commit.ts
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { requireUser } from '../_shared/auth.ts';
import { assertPersistable, commitStandalone, persistAppointment, type CommitCtx } from '../_shared/commit.ts';
import { must } from '../_shared/db.ts';
import { getEnv } from '../_shared/env.ts';
import { HttpError } from '../_shared/errors.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { buildPlan, loadProfile } from '../_shared/plan.ts';
import { Reader, readJson } from '../_shared/read.ts';
import { readCommitRequest } from '../_shared/requests.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { safeTimeZone } from '../_shared/tz.ts';

Deno.serve(
  serve(async (req) => {
    const user = await requireUser(req);
    const root = Reader.root(await readJson(req));
    const request = readCommitRequest(root);
    root.finish();

    const ctx: CommitCtx = { userId: user.userId, userDb: user.db, service: createServiceClient(), now: new Date() };

    if (request.type === 'STANDALONE') {
      const timeZone = safeTimeZone((await loadProfile(user.db, user.userId)).timezone);
      return jsonResponse(await commitStandalone(ctx, { alarm: request.alarm, edits: request.edits, timeZone }));
    }

    const { draft, appointment: created } = request;

    // 새 공동 약속이면 내가 그 그룹에 참여 중이어야 함 (appointments RLS의 insert 조건과 같음)
    if (created?.groupId) {
      const member = must<{ group_id: string } | null>(
        'group_members',
        await user.db.from('group_members').select('group_id').eq('group_id', created.groupId).eq('user_id', user.userId).eq('invite_status', 'JOINED').maybeSingle(),
      );
      if (!member) throw new HttpError('FORBIDDEN', '이 그룹에 참여 중이 아니라서 공동 약속을 만들 수 없어요');
    }

    // 계산 + 검증 (alarm-suggest와 같은 계산). 기존 약속이 내게 안 보이면 NOT_FOUND
    const { plan, inputs, timeZone } = await buildPlan(
      { userId: user.userId, db: user.db, now: ctx.now, kakaoKey: getEnv('KAKAO_REST_API_KEY') },
      draft,
    );
    assertPersistable(plan);

    return jsonResponse(
      await persistAppointment(ctx, { plan, inputs, created, draft, replaceExisting: request.replaceExisting, edits: request.edits, timeZone }),
    );
  }),
);
