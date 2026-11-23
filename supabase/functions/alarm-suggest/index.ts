// alarm-suggest — 알람 시각 · 강도 미리 보기 (상세설계서 5장 5.4.1, 화면 H05 · H03). DB에 쓰지 않음
//   입력: alarm-commit과 같은 H05 초안 모양 (appointment_id 또는 appointment{…} + participant{…} + kinds · enabled · manual_times · levels) — requests.ts
//        앱은 place-search로 고른 장소의 좌표(lat · lng)를 destination · origin에 담아 보냄 (좌표가 있어야 길찾기 · 근사 · 실측 중앙값이 됨)
//   처리: 이동시간(카카오 → 같은 경로 실측 중앙값 → 직선거리 근사 → 직접 입력) → 준비 P80 → 역산 → 강도 → 지난 알림 검사
//   응답: 알람 시각 · 이동 { minutes, source } · 준비 근거 · 강도 · 경고. 계산 규칙은 _shared/calc (앱 목업과 같은 숫자)
//        이동시간을 구할 길이 없으면(좌표 없음 · 직접 입력 없음) 오류 대신 200 + travel.manual_required true (check.reason TRAVEL_REQUIRED) — 직접 입력해 다시 부름
//   오류: UNPROCESSABLE(출발 시각까지 지남)
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { requireUser } from '../_shared/auth.ts';
import { getEnv } from '../_shared/env.ts';
import { HttpError } from '../_shared/errors.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { buildPlan, TravelRequiredError, type BuiltPlan } from '../_shared/plan.ts';
import { toSuggestion, toTravelRequiredSuggestion } from '../_shared/plan-core.ts';
import { runPurePrepShadow } from '../_shared/pure-prep-shadow.ts';
import { Reader, readJson } from '../_shared/read.ts';
import { readSuggestRequest } from '../_shared/requests.ts';

Deno.serve(
  serve(async (req) => {
    const user = await requireUser(req);
    const root = Reader.root(await readJson(req));
    const draft = readSuggestRequest(root);
    root.finish();

    let built: BuiltPlan;
    try {
      built = await buildPlan({ userId: user.userId, db: user.db, now: new Date(), kakaoKey: getEnv('KAKAO_REST_API_KEY') }, draft, { wantAutoTravel: true, mode: 'preview' });
    } catch (e) {
      // 좌표가 없어 이동시간을 못 구함 → 오류 대신 "직접 입력해 주세요"(travel.manual_required)를 알리는 200 (alarm-commit은 502 그대로)
      if (e instanceof TravelRequiredError) return jsonResponse(toTravelRequiredSuggestion(e.inputs, e.travel));
      throw e;
    }
    const { plan } = built;
    const suggestion = toSuggestion(plan, built.inputs);

    // 출발 시각까지 지났으면 저장도 안 되는 입력 — 화면이 이유를 보일 수 있게 계산 결과를 같이 줌 (순서 어긋남은 200 + check.ok false)
    if (!plan.check.ok && plan.check.reason === 'DEPARTURE_PASSED') {
      throw new HttpError('UNPROCESSABLE', plan.check.message, { reason: plan.check.reason, suggestion });
    }
    // Read-only research telemetry is returned ONLY in this authorized user's
    // preview response. Never changes the plan, commit payload, or alarm times.
    const shadow = await runPurePrepShadow({
      userId: user.userId,
      db: user.db,
      profile: built.inputs.profile,
      now: built.inputs.now,
      appointmentAt: plan.basics.at,
      timezone: built.timeZone,
      personalAppointment: draft.groupId == null && built.inputs.appointment?.group_id == null,
      purePlan: plan.prepareTarget === 'PREPARE_START_TO_DEPART',
      manualOverride: draft.prepareMinutes != null ||
        draft.manualTimes?.PREPARE != null || draft.manualTimes?.WAKE != null,
    });
    return jsonResponse(shadow ? { ...suggestion, pure_prep_shadow: shadow } : suggestion);
  }),
);
