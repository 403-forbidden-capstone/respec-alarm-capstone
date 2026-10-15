// alarm-suggest — 알람 시각 · 강도 미리 보기 (상세설계서 5장 5.4.1, 화면 H05 · H03). DB에 쓰지 않음
//   입력: 약속 시각 · 출발지/목적지(좌표는 선택) · 이동 수단 · 여유 · 준비 · 중요도 · 고른 알람 종류 · 직접 고른 값(이동 · 준비 · 알람 시각 · 강도)
//   처리: 이동시간(카카오 → 같은 경로 실측 중앙값 → 직선거리 근사 → 직접 입력) → 준비 P80 → 역산 → 강도 → 지난 알림 검사
//   응답: 알람 시각 · 이동 { minutes, source } · 준비 근거 · 강도 · 경고. 계산 규칙은 _shared/calc (앱 목업과 같은 숫자)
//   오류: ROUTE_UNAVAILABLE(이동시간을 구할 길이 없음 → 직접 입력), UNPROCESSABLE(출발 시각까지 지남)
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { requireUser } from '../_shared/auth.ts';
import { getEnv } from '../_shared/env.ts';
import { HttpError } from '../_shared/errors.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { buildPlan } from '../_shared/plan.ts';
import { toSuggestion } from '../_shared/plan-core.ts';
import { Reader, readJson } from '../_shared/read.ts';
import { readSuggestRequest } from '../_shared/requests.ts';

Deno.serve(
  serve(async (req) => {
    const user = await requireUser(req);
    const root = Reader.root(await readJson(req));
    const draft = readSuggestRequest(root);
    root.finish();

    const { plan } = await buildPlan(
      { userId: user.userId, db: user.db, now: new Date(), kakaoKey: getEnv('KAKAO_REST_API_KEY') },
      draft,
      { wantAutoTravel: true },
    );
    const suggestion = toSuggestion(plan);

    // 출발 시각까지 지났으면 저장도 안 되는 입력 — 화면이 이유를 보일 수 있게 계산 결과를 같이 줌 (순서 어긋남은 200 + check.ok false)
    if (!plan.check.ok && plan.check.reason === 'DEPARTURE_PASSED') {
      throw new HttpError('UNPROCESSABLE', plan.check.message, { reason: plan.check.reason, suggestion });
    }
    return jsonResponse(suggestion);
  }),
);
