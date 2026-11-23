// Optional CatBoost v2 shadow evaluation. Read-only, preview-only, default OFF.
// NEVER use survey proxy predictions to schedule, save, edit, or roll alarms.
import { confirmedPurePrepHistory, type PrepCompletionRow } from './calc/pure-prep-basis.ts';
import { getEnv } from './env.ts';
import {
  approvedMlProfile, calendarFeatures, mayUseMl, validMlEndpoint,
  type VerifiedMlProfile,
} from './prepare-ml.ts';
import type { ProfileRow } from './plan-core.ts';
import type { Db } from './supabase.ts';

export const PURE_PREP_SHADOW_MIN_HISTORY = 10;
export const PURE_PREP_SHADOW_MAX_HISTORY = 30;
export const PURE_PREP_SHADOW_MODEL = 'prep_start_ratio_v2' as const;
export type ShadowTarget = 'actual_start_depart' | 'survey_start_cluster_proxy' | 'alarm_dismiss_location_proxy';

export type PurePrepShadowRequest = {
  model: typeof PURE_PREP_SHADOW_MODEL;
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
      model: typeof PURE_PREP_SHADOW_MODEL;
      training_target: ShadowTarget;
      predicted_pure_minutes: number;
      history_baseline_minutes: number;
      valid_records: number;
      required_records: 10;
      applied_to_alarm: false;
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
    allowSurveyProxy?: boolean;
    allowDismissProxy?: boolean;
    timeoutMs?: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ShadowPrediction | null> {
  const baseline = request.features.baseline_observed;
  if (request.model !== PURE_PREP_SHADOW_MODEL ||
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
        !(target === 'survey_start_cluster_proxy' && config.allowSurveyProxy === true) &&
        !(target === 'alarm_dismiss_location_proxy' && config.allowDismissProxy === true)) return null;
    if (v.model !== PURE_PREP_SHADOW_MODEL || v.prediction_type !== 'ratio' ||
        typeof v.minutes !== 'number' || !Number.isFinite(v.minutes) ||
        typeof v.ratio !== 'number' || !Number.isFinite(v.ratio)) return null;
    if (v.minutes < 5 || v.minutes > 240 || v.ratio < 0.5 || v.ratio > 2 ||
        Math.abs(v.minutes - baseline * v.ratio) > 2) return null;
    return {
      model: PURE_PREP_SHADOW_MODEL,
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

// Reads only the authorized user's *completed past* sessions. Never writes a
// training row, model output, alarm, or personal profile data.
export async function runPurePrepShadow(input: {
  userId: string;
  db: Db;
  profile: Pick<ProfileRow, 'ml_profile_consented_at'>;
  now: Date;
  appointmentAt: Date;
  timezone: string;
  personalAppointment: boolean;
  purePlan: boolean;
  manualOverride: boolean;
}): Promise<PurePrepShadowResult | null> {
  if (!eligibleForPurePrepShadow({
    enabled: getEnv('PURE_PREP_SHADOW_ENABLED') === '1',
    allowedUserIds: getEnv('PURE_PREP_SHADOW_ALLOWED_USER_IDS'),
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
    const { data, error } = await input.db.from('appointment_participants')
      .select('prepare_started_at, departed_at, prepare_started_source, departed_source')
      .eq('user_id', input.userId)
      .eq('prepare_started_source', 'PREPARE_ALARM')
      .eq('departed_source', 'LOCATION')
      .not('prepare_started_at', 'is', null)
      .not('departed_at', 'is', null)
      .lt('departed_at', cutoff.toISOString())
      .order('departed_at', { ascending: false })
      .limit(100);
    if (error || !data) return null;
    const history = confirmedPurePrepHistory(data as PrepCompletionRow[], cutoff);
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
    const request = buildPurePrepShadowRequest({
      appointmentAt: input.appointmentAt,
      timezone: input.timezone,
      verifiedAgeCode: verified.ml_age_code,
      verifiedHolidayCode: verified.ml_holiday_code,
      historyMinutes: history,
    });
    if (!request) return null;
    const response = await requestPurePrepShadow(request, {
      url: getEnv('PURE_PREP_SHADOW_URL'),
      token: getEnv('PURE_PREP_SHADOW_API_TOKEN'),
      allowSurveyProxy: getEnv('PURE_PREP_SHADOW_ALLOW_SURVEY_PROXY') === '1',
      allowDismissProxy: getEnv('PURE_PREP_SHADOW_ALLOW_DISMISS_PROXY') === '1',
    });
    if (!response) return { status: 'MODEL_UNAVAILABLE', valid_records: history.length, required_records: PURE_PREP_SHADOW_MIN_HISTORY };
    return {
      status: 'PREDICTED',
      model: response.model,
      training_target: response.training_target,
      predicted_pure_minutes: response.minutes,
      history_baseline_minutes: Math.round(request.features.baseline_observed * 10) / 10,
      valid_records: history.length,
      required_records: PURE_PREP_SHADOW_MIN_HISTORY,
      applied_to_alarm: false,
    };
  } catch {
    return null; // shadow path NEVER fails or changes a valid alarm preview
  }
}
