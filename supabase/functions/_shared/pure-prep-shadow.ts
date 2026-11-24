// CatBoost v2 inference shared by the research-only shadow view and live
// personal AUTO scheduling. Valid, consented 10+ sessions are required.
// Unavailable or incompatible models always fall back to the existing plan.
import { choosePurePrepBasis, confirmedPurePrepHistory, type PrepCompletionRow } from './calc/pure-prep-basis.ts';
import { getEnv } from './env.ts';
import {
  approvedMlProfile, calendarFeatures, mayUseMl, validMlEndpoint,
  type VerifiedMlProfile,
} from './prepare-ml.ts';
import type { ProfileRow } from './plan-core.ts';
import type { Db } from './supabase.ts';
import { localDateKey } from './tz.ts';
import { previousDateKey } from './prepare-ml.ts';
import { buildSurveyV2PilotRequest, requestSurveyV2Pilot } from './survey-v2-pilot.ts';

export const PURE_PREP_SHADOW_MIN_HISTORY = 10;
export const PURE_PREP_SHADOW_MAX_HISTORY = 30;
export const PURE_PREP_SHADOW_MODEL = 'prep_start_ratio_v2' as const;
// Must match the trainer manifest and model API. Older 2024 survey weights
// use a PREVIOUS-DAY baseline and cannot be applied to this recent-history mean.
export const PURE_PREP_SHADOW_BASELINE_DEFINITION = 'mean_last_30_valid_prep_alarm_location_v1' as const;
export type ShadowTarget = 'actual_start_depart' | 'alarm_dismiss_location_proxy';

export type PurePrepShadowRequest = {
  model: typeof PURE_PREP_SHADOW_MODEL;
  baseline_definition: typeof PURE_PREP_SHADOW_BASELINE_DEFINITION;
  features: {
    weekday_code: string;
    '평토일구분코드': string;
    '휴일종류코드': string;
    '연령코드': string;
    baseline_observed: number;
  };
  history_count: number;
};
export type ShadowPrediction = {
  model: typeof PURE_PREP_SHADOW_MODEL;
  baseline_definition: typeof PURE_PREP_SHADOW_BASELINE_DEFINITION;
  minutes: number;
  ratio: number;
  training_target: ShadowTarget;
};
export type PurePrepShadowResult =
  | { status: 'INSUFFICIENT_HISTORY'; valid_records: number; required_records: 10 }
  | { status: 'UNVERIFIED_PROFILE'; valid_records: number; required_records: 10 }
  | { status: 'MODEL_UNAVAILABLE'; valid_records: number; required_records: 10 }
  | {
      status: 'PREDICTED';
      model: typeof PURE_PREP_SHADOW_MODEL | 'prep_start_ratio_v2_survey_pilot';
      training_target: ShadowTarget | 'survey_start_cluster_proxy';
      predicted_pure_minutes: number;
      history_baseline_minutes: number;
      personalized_baseline_minutes: number;
      raw_model_prediction_minutes: number;
      onboarding_pure_minutes: number | null;
      valid_records: number;
      required_records: 10;
      applied_to_alarm: boolean;
    };

export function eligibleForPurePrepShadow(input: {
  enabled: boolean;
  allowedUserIds?: string | null;
  userId: string;
  profileConsentedAt?: string | null;
  personalAppointment: boolean;
  purePlan: boolean;
  manualOverride: boolean;
}): boolean {
  return input.personalAppointment && input.purePlan && !input.manualOverride &&
    Boolean(input.profileConsentedAt && Number.isFinite(Date.parse(input.profileConsentedAt))) &&
    mayUseMl({
      enabled: input.enabled, allowForPlan: true,
      userId: input.userId, allowedUserIds: input.allowedUserIds,
    });
}

export function buildPurePrepShadowRequest(input: {
  appointmentAt: Date;
  timezone: string;
  verifiedAgeCode: string | null | undefined;
  verifiedHolidayCode: string | null | undefined;
  historyMinutes: readonly number[];
}): PurePrepShadowRequest | null {
  const history = input.historyMinutes
    .filter((v) => Number.isFinite(v) && v >= 10 && v <= 240)
    .slice(0, PURE_PREP_SHADOW_MAX_HISTORY);
  if (history.length < PURE_PREP_SHADOW_MIN_HISTORY ||
      !/^[1-8]$/.test(input.verifiedAgeCode ?? '')) return null;
  const baseline = history.reduce((acc, minutes) => acc + minutes, 0) / history.length;
  return {
    model: PURE_PREP_SHADOW_MODEL,
    baseline_definition: PURE_PREP_SHADOW_BASELINE_DEFINITION,
    features: {
      ...calendarFeatures(input.appointmentAt, input.timezone),
      '연령코드': input.verifiedAgeCode as string,
      '휴일종류코드': /^[1-6]$/.test(input.verifiedHolidayCode ?? '')
        ? input.verifiedHolidayCode as string : '__MISSING__',
      baseline_observed: baseline,
    },
    history_count: history.length,
  };
}

export async function requestPurePrepShadow(
  request: PurePrepShadowRequest,
  config: {
    url?: string;
    token?: string;
    allowDismissProxy?: boolean;
    timeoutMs?: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ShadowPrediction | null> {
  const baseline = request.features.baseline_observed;
  if (request.model !== PURE_PREP_SHADOW_MODEL ||
      request.baseline_definition !== PURE_PREP_SHADOW_BASELINE_DEFINITION ||
      request.history_count < PURE_PREP_SHADOW_MIN_HISTORY ||
      request.history_count > PURE_PREP_SHADOW_MAX_HISTORY ||
      !Number.isFinite(baseline) || baseline < 10 || baseline > 240 ||
      !config.url || !config.token || !validMlEndpoint(config.url)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(100, Math.min(5000, config.timeoutMs ?? 1500)));
  try {
    const response = await fetchImpl(config.url.replace(/\/$/, '') + '/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': config.token },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object') return null;
    const v = body as Record<string, unknown>;
    const target = v.training_target;
    if (target !== 'actual_start_depart' &&
        !(target === 'alarm_dismiss_location_proxy' && config.allowDismissProxy === true)) return null;
    if (v.model !== PURE_PREP_SHADOW_MODEL ||
        v.baseline_definition !== PURE_PREP_SHADOW_BASELINE_DEFINITION ||
        v.prediction_type !== 'ratio' ||
        typeof v.minutes !== 'number' || !Number.isFinite(v.minutes) ||
        typeof v.ratio !== 'number' || !Number.isFinite(v.ratio)) return null;
    if (v.minutes < 5 || v.minutes > 240 || v.ratio < 0.5 || v.ratio > 2 ||
        Math.abs(v.minutes - baseline * v.ratio) > 2) return null;
    return {
      model: PURE_PREP_SHADOW_MODEL,
      baseline_definition: PURE_PREP_SHADOW_BASELINE_DEFINITION,
      minutes: Math.round(v.minutes),
      ratio: v.ratio,
      training_target: target as ShadowTarget,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// The trained v2 manifest uses observed prior-session mean, not onboarding.
// Transfer the model's estimated residual onto the preference-anchored basis
// after inference. This is shadow-only, not an independently trained model.
export function personalizePurePrepShadow(
  rawModelMinutes: number, historicalMean: number,
  profileMinutes: number | null | undefined, historyMinutes: readonly number[],
): { predictedMinutes: number; personalizedBaseline: number } {
  const chosen = choosePurePrepBasis({ profileMinutes, historicalMinutes: historyMinutes });
  const baseline = chosen?.minutes ?? Math.round(historicalMean);
  return {
    predictedMinutes: Math.round(Math.min(240, Math.max(5, baseline + rawModelMinutes - historicalMean))),
    personalizedBaseline: baseline,
  };
}

// Reads only the authorized user's *completed past* sessions. Never writes a
// training row, model output, alarm, or personal profile data.
export async function runPurePrepShadow(input: {
  userId: string;
  db: Db;
  profile: Pick<ProfileRow, 'ml_profile_consented_at' | 'default_outing_prep_minutes' | 'default_outing_prep_updated_at'>;
  now: Date;
  appointmentAt: Date;
  timezone: string;
  personalAppointment: boolean;
  purePlan: boolean;
  manualOverride: boolean;
  // "live" is called only by buildPlan for a user's own automatic alarms.
  // "shadow" retains the existing OFF-by-default read-only preview behavior.
  mode?: 'live' | 'shadow';
}): Promise<PurePrepShadowResult | null> {
  const live = input.mode === 'live';
  // Explicit opt-in protects production alarms. Ten records never implicitly
  // turn a research endpoint into a production dependency without rollout.
  // Survey-v2 was learned from diary clusters, not the app's real preparation
  // intervals. It is a separately authorized, user-isolated transfer pilot.
  // Never silently repurpose the existing production CatBoost live URL/token.
  const surveyPilot = live &&
    getEnv('PURE_PREP_MODEL_LIVE_ENABLED') !== '1' &&
    getEnv('PURE_PREP_SURVEY_V2_PILOT_ENABLED') === '1' &&
    getEnv('PURE_PREP_SURVEY_V2_PILOT_ALLOW_ALARM') === '1';
  const enabled = surveyPilot || (live
    ? getEnv('PURE_PREP_MODEL_LIVE_ENABLED') === '1'
    : getEnv('PURE_PREP_SHADOW_ENABLED') === '1');
  const allowedUserIds = surveyPilot
    ? getEnv('PURE_PREP_SURVEY_V2_PILOT_ALLOWED_USER_IDS')
    : live ? getEnv('PURE_PREP_MODEL_LIVE_ALLOWED_USER_IDS')
    : getEnv('PURE_PREP_SHADOW_ALLOWED_USER_IDS');
  if (!eligibleForPurePrepShadow({
    enabled, allowedUserIds,
    userId: input.userId,
    profileConsentedAt: input.profile.ml_profile_consented_at,
    personalAppointment: input.personalAppointment,
    purePlan: input.purePlan,
    manualOverride: input.manualOverride,
  })) return null;

  const cutoffMs = Math.min(input.now.getTime(), input.appointmentAt.getTime());
  if (!Number.isFinite(cutoffMs)) return null;
  const cutoff = new Date(cutoffMs);
  try {
    const editedAt = input.profile.default_outing_prep_updated_at
      ? new Date(input.profile.default_outing_prep_updated_at) : undefined;
    if (editedAt && !Number.isFinite(editedAt.getTime())) return null;
    let query = input.db.from('appointment_participants')
      .select('prepare_started_at, departed_at, prepare_started_source, departed_source')
      .eq('user_id', input.userId)
      .eq('prepare_started_source', 'PREPARE_ALARM')
      .eq('departed_source', 'LOCATION')
      .not('prepare_started_at', 'is', null)
      .not('departed_at', 'is', null)
      .lt('departed_at', cutoff.toISOString());
    if (editedAt) query = query.gte('prepare_started_at', editedAt.toISOString());
    const { data, error } = await query.order('departed_at', { ascending: false }).limit(100);
    if (error || !data) return null;
    const history = confirmedPurePrepHistory(data as PrepCompletionRow[], cutoff, 30, editedAt);
    if (history.length < PURE_PREP_SHADOW_MIN_HISTORY) {
      return { status: 'INSUFFICIENT_HISTORY', valid_records: history.length, required_records: PURE_PREP_SHADOW_MIN_HISTORY };
    }

    // Only trusted, consented server-side demographics may enter the model.
    // Supabase's privileged client is lazily imported after the precise user
    // allowlist and minimum-history gates.
    const { createServiceClient } = await import('./supabase.ts');
    const { data: verifiedRow, error: verifiedError } = await createServiceClient()
      .from('prepare_ml_verified_profiles')
      .select('ml_age_code, ml_holiday_code, codebook_version, consent_at, verified_at')
      .eq('user_id', input.userId)
      .maybeSingle();
    const verified = verifiedError ? null : approvedMlProfile(
      verifiedRow as VerifiedMlProfile | null, getEnv('PREPARE_ML_CODEBOOK_VERSION'),
    );
    if (!verified) return { status: 'UNVERIFIED_PROFILE', valid_records: history.length, required_records: PURE_PREP_SHADOW_MIN_HISTORY };
    if (surveyPilot) {
      // The *single preceding LOCAL calendar day's* completed session is the
      // nearest available app-side proxy to the survey model's training input.
      // Never substitute onboarding minutes or the mean of the latest ten.
      const previousKey = previousDateKey(input.appointmentAt, input.timezone);
      const previousDay = confirmedPurePrepHistory(
        (data as PrepCompletionRow[]).filter(row =>
          row.departed_at != null &&
          localDateKey(new Date(row.departed_at), input.timezone) === previousKey),
        cutoff, 1, editedAt,
      )[0];
      const surveyRequest = buildSurveyV2PilotRequest({
        appointmentAt: input.appointmentAt, timezone: input.timezone,
        verifiedAgeCode: verified.ml_age_code,
        verifiedHolidayCode: verified.ml_holiday_code,
        validHistoryCount: history.length, previousLocalDayMinutes: previousDay,
      });
      if (!surveyRequest) return { status: 'MODEL_UNAVAILABLE', valid_records: history.length, required_records: PURE_PREP_SHADOW_MIN_HISTORY };
      const surveyResponse = await requestSurveyV2Pilot(surveyRequest, {
        url: getEnv('PURE_PREP_SURVEY_V2_PILOT_URL'),
        token: getEnv('PURE_PREP_SURVEY_V2_PILOT_API_TOKEN'),
      });
      if (!surveyResponse) return { status: 'MODEL_UNAVAILABLE', valid_records: history.length, required_records: PURE_PREP_SHADOW_MIN_HISTORY };
      return {
        status: 'PREDICTED',
        // Distinct DB provenance: do not label a survey model as a validated
        // app-start predictor under the same deployment model identifier.
        model: 'prep_start_ratio_v2_survey_pilot',
        training_target: 'survey_start_cluster_proxy',
        predicted_pure_minutes: surveyResponse.minutes,
        history_baseline_minutes: previousDay,
        personalized_baseline_minutes: previousDay,
        raw_model_prediction_minutes: surveyResponse.minutes,
        onboarding_pure_minutes: input.profile.default_outing_prep_minutes ?? null,
        valid_records: history.length, required_records: PURE_PREP_SHADOW_MIN_HISTORY,
        applied_to_alarm: true,
      };
    }
    const request = buildPurePrepShadowRequest({
      appointmentAt: input.appointmentAt,
      timezone: input.timezone,
      verifiedAgeCode: verified.ml_age_code,
      verifiedHolidayCode: verified.ml_holiday_code,
      historyMinutes: history,
    });
    if (!request) return null;
    const response = await requestPurePrepShadow(request, {
      url: live ? getEnv('PURE_PREP_MODEL_LIVE_URL') : getEnv('PURE_PREP_SHADOW_URL'),
      token: live ? getEnv('PURE_PREP_MODEL_LIVE_API_TOKEN') : getEnv('PURE_PREP_SHADOW_API_TOKEN'),
      allowDismissProxy: live ? getEnv('PURE_PREP_MODEL_LIVE_ALLOW_PROXY') === '1'
        : getEnv('PURE_PREP_SHADOW_ALLOW_DISMISS_PROXY') === '1',
    });
    if (!response) return { status: 'MODEL_UNAVAILABLE', valid_records: history.length, required_records: PURE_PREP_SHADOW_MIN_HISTORY };
    const calibrated = personalizePurePrepShadow(response.minutes, request.features.baseline_observed,
      input.profile.default_outing_prep_minutes, history);
    return {
      status: 'PREDICTED',
      model: response.model,
      training_target: response.training_target,
      predicted_pure_minutes: calibrated.predictedMinutes,
      history_baseline_minutes: Math.round(request.features.baseline_observed * 10) / 10,
      personalized_baseline_minutes: calibrated.personalizedBaseline,
      raw_model_prediction_minutes: response.minutes,
      onboarding_pure_minutes: input.profile.default_outing_prep_minutes ?? null,
      valid_records: history.length,
      required_records: PURE_PREP_SHADOW_MIN_HISTORY,
      applied_to_alarm: live,
    };
  } catch {
    return null; // Both paths preserve an existing calculation on any failure.
  }
}
