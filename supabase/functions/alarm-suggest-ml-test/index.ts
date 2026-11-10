// Test-only end-to-end CatBoost alarm preview. No writes, and never used by the app.
// Require a real logged-in user AND a server-secret allowlist before any DB read.
// The demographic/previous-day model inputs below are SYNTHETIC, not user attributes.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { requireUser } from '../_shared/auth.ts';
import { HttpError } from '../_shared/errors.ts';
import { getEnv } from '../_shared/env.ts';
import { jsonResponse, serve } from '../_shared/http.ts';
import { buildPlan, TravelRequiredError, type BuiltPlan } from '../_shared/plan.ts';
import { computePlan, toSuggestion, toTravelRequiredSuggestion } from '../_shared/plan-core.ts';
import { buildMlRequest, requestMlPrediction, type MlModel } from '../_shared/prepare-ml.ts';
import { Reader, readJson } from '../_shared/read.ts';
import { readSuggestRequest } from '../_shared/requests.ts';

const SYNTHETIC_PROFILE = {
  ml_codes_verified: true,
  ml_age_code: '2',
  ml_education_code: '1',
  ml_economic_code: '1',
} as const;

// Exact-match UUIDs only. All controls live in Edge secrets, not request data.
function permitted(userId: string): boolean {
  if (getEnv('PREPARE_ML_TEST_ENABLED') !== '1') return false;
  const ids = (getEnv('PREPARE_ML_TEST_USER_IDS') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(s));
  return ids.includes(userId.toLowerCase());
}

Deno.serve(
  serve(async (req) => {
    const user = await requireUser(req);
    if (!permitted(user.userId)) throw new HttpError('FORBIDDEN', '허용된 테스트 계정만 사용할 수 있어요');

    const model = new URL(req.url).searchParams.get('model') ?? 'c1_mae';
    if (model !== 'c1_mae' && model !== 'w4_mae') {
      throw new HttpError('VALIDATION_FAILED', '테스트 모델은 c1_mae 또는 w4_mae만 지원해요');
    }
    const selectedModel: MlModel = model;
    const root = Reader.root(await readJson(req));
    const draft = readSuggestRequest(root);
    root.finish();

    if (draft.prepareMinutes != null || draft.withWake !== true) {
      throw new HttpError('VALIDATION_FAILED', '실험은 with_wake=true인 자동 준비시간만 지원해요');
    }

    let built: BuiltPlan;
    try {
      // This reads the test user's own data under RLS and NEVER writes alarms.
      // PREPARE_ML_ENABLED remains zero, so this is the existing P80 baseline.
      built = await buildPlan(
        { userId: user.userId, db: user.db, now: new Date(), kakaoKey: undefined },
        draft,
        { wantAutoTravel: false, mode: 'preview' },
      );
    } catch (e) {
      if (e instanceof TravelRequiredError) {
        return jsonResponse({ ...toTravelRequiredSuggestion(e.inputs, e.travel), ml_test: { synthetic: true, saved: false, applied: false } });
      }
      throw e;
    }

    if (!built.plan.withWake || built.plan.prepare.source === 'MANUAL') {
      throw new HttpError('UNPROCESSABLE', '기상 포함 자동 준비시간에서만 모델을 비교할 수 있어요');
    }

    const url = getEnv('PREPARE_ML_URL');
    const token = getEnv('PREPARE_ML_API_TOKEN');
    if (!url || !token) throw new HttpError('NOT_CONFIGURED', '테스트용 모델 서버 연결이 설정되지 않았어요');

    // Fixed synthetic survey codes; W4 uses a synthetic prior-day 60 minutes.
    // Neither demographics nor historical preparation times from the test user
    // are sent to the model. No database profile or record is modified.
    const mlRequest = buildMlRequest({
      appointmentAt: built.plan.basics.at,
      timezone: built.timeZone,
      profile: SYNTHETIC_PROFILE,
      previousDayMinutes: selectedModel === 'w4_mae' ? 60 : null,
    });
    if (!mlRequest || mlRequest.model !== selectedModel) {
      throw new HttpError('INTERNAL', '테스트 모델 입력을 만들지 못했어요');
    }
    const mlPrediction = await requestMlPrediction(mlRequest, { enabled: true, url, token, timeoutMs: 5000 });
    if (!mlPrediction) throw new HttpError('INTERNAL', 'CatBoost 테스트 예측 응답을 받지 못했어요');

    const modelPlan = computePlan({ ...built.inputs, mlPrediction }, built.plan.travel, 'preview');
    if (modelPlan.prepare.source !== 'MODEL') {
      throw new HttpError('UNPROCESSABLE', '선택한 일정에 모델이 적용되지 않았어요');
    }

    return jsonResponse({
      ...toSuggestion(modelPlan, built.inputs),
      ml_test: {
        synthetic: true,
        saved: false,
        model: selectedModel,
        synthetic_previous_day_minutes: selectedModel === 'w4_mae' ? 60 : null,
        baseline_prepare_minutes: built.plan.prepare.minutes,
      },
    });
  }),
);
