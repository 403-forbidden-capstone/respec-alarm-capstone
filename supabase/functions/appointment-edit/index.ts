// appointment-edit — 일정 고치기 · 지우기 · 되돌리기 · 공동 약속에서 빠지기 (상세설계서 7장 7.1.3 · 7.1.5, 화면 H03 편집 시트 · L5 PR 6, 이슈 #276)
//   요청:  { action: 'UPDATE' | 'DELETE' | 'RESTORE' | 'LEAVE', appointment_id, scope?: 'this' | 'following', patch?, confirmed? } — 모양 · 설명은 _shared/edit-request.ts
//   응답:  모두 { appointment_id, ring_packages, canceled_alarm_ids, warnings } + 동작별 칸 — ring_packages · canceled_alarm_ids는 alarm-commit과 같은 모양이라 앱 applyCommit이 그대로 폰에 반영
//          UPDATE { saved, needs_confirm, changes[{kind, from, to}], alarms, deleted_appointment_ids } / DELETE { deleted, mode, deleted_appointment_ids }
//          RESTORE { restored } / LEAVE { left }
//   오류:  VALIDATION_FAILED · NOT_FOUND · FORBIDDEN(공동 약속은 만든 사람만) · UNPROCESSABLE(출발 시각까지 지남 · 알람 순서 어긋남 · 기록 있는 일정 · 지난 공동 약속 · 공동 약속 반복 고치기) · ROUTE_UNAVAILABLE(새 장소의 이동시간을 구할 길이 없음)
// 읽기 · 쓰기 모두 부른 사람의 RLS 클라이언트로 함 — 남의 약속은 안 보이고 못 고침. service 클라이언트는 재시도 기록 정리 · 공동 약속 기록 확인에만 (_shared/edit-run.ts)
// 공동 약속(9장): 만든 사람이 시각 · 장소를 고치면 참여자마다 알람을 다시 계산하고(앞당김 바로, 5분 이상 늦춤은 그 사람이 확인할 때까지 보류) 참여자에게 GROUP_APPT_CHANGED 푸시, 지우면 취소 푸시. 그때만 service 클라이언트로 다른 참여자의 행을 읽고 씀
// 반복 일정: 이번만 고치기 · 지우기는 그 회차 행만 건드리고 예외 표시(appointments.exception_kind)를 남겨 alarm-roll이 다시 안 만들게 함. 이후 모두는 뒤 회차를 지워 alarm-roll이 새 기준으로 다시 만들게 함
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { requireUser } from '../_shared/auth.ts';
import { runEdit } from '../_shared/edit-run.ts';
import { readEditRequest } from '../_shared/edit-request.ts';
import { getEnv } from '../_shared/env.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { kakaoTravelMinutes } from '../_shared/kakao.ts';
import { Reader, readJson } from '../_shared/read.ts';
import type { TravelLookup } from '../_shared/roll.ts';
import { createServiceClient } from '../_shared/supabase.ts';

Deno.serve(
  serve(async (req) => {
    const user = await requireUser(req);
    const root = Reader.root(await readJson(req));
    const request = readEditRequest(root);
    root.finish();

    const kakaoKey = getEnv('KAKAO_REST_API_KEY');
    const kakao: TravelLookup | undefined = kakaoKey ? (args) => kakaoTravelMinutes(kakaoKey, args) : undefined; // 장소를 바꿀 때만 부름
    return jsonResponse(await runEdit({ userId: user.userId, userDb: user.db, service: createServiceClient(), now: new Date(), kakao, push: { accessToken: getEnv('EXPO_ACCESS_TOKEN') } }, request));
  }),
);
