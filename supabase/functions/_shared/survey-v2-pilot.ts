// Explicit, limited cross-domain research pilot for the ORIGINAL 2024
// time-use-survey CatBoost v2. This is NOT an app-session-trained model.
// The training input was the previous survey diary's near-departure cluster.
// App PREPARE_ALARM->LOCATION is a different PROXY, so two explicit gates
// and a single-user UUID allowlist must be configured before live use.
import { calendarFeatures, validMlEndpoint } from './prepare-ml.ts';

export const SURVEY_V2_PILOT_MODEL = 'prep_start_ratio_v2' as const;
export const SURVEY_V2_PILOT_BASELINE = 'survey_previous_day_app_proxy_transfer_v1' as const;
export const SURVEY_V2_PILOT_TARGET = 'survey_start_cluster_proxy' as const;

export type SurveyV2PilotRequest = {
  model: typeof SURVEY_V2_PILOT_MODEL;
  baseline_definition: typeof SURVEY_V2_PILOT_BASELINE;
  history_count: number;
  features: {
    weekday_code: string;
    '평토일구분코드': string;
    '휴일종류코드': string;
    '연령코드': string;
    baseline_observed: number;
  };
};
export type SurveyV2PilotPrediction = {
  model: typeof SURVEY_V2_PILOT_MODEL;
  training_target: typeof SURVEY_V2_PILOT_TARGET;
  baseline_definition: typeof SURVEY_V2_PILOT_BASELINE;
  minutes: number;
  ratio: number;
};
const validObserved = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 10 && v <= 240;

export function buildSurveyV2PilotRequest(input: {
  appointmentAt: Date;
  timezone: string;
  verifiedAgeCode: string | null | undefined;
  verifiedHolidayCode: string | null | undefined;
  validHistoryCount: number;
  previousLocalDayMinutes: number | null | undefined;
}): SurveyV2PilotRequest | null {
  if (!Number.isInteger(input.validHistoryCount) ||
      input.validHistoryCount < 10 || input.validHistoryCount > 30 ||
      !validObserved(input.previousLocalDayMinutes) ||
      !/^[1-8]$/.test(input.verifiedAgeCode ?? '')) return null;

  return {
    model: SURVEY_V2_PILOT_MODEL,
    baseline_definition: SURVEY_V2_PILOT_BASELINE,
    history_count: input.validHistoryCount,
    features: {
      ...calendarFeatures(input.appointmentAt, input.timezone),
      '휴일종류코드': /^[1-6]$/.test(input.verifiedHolidayCode ?? '')
        ? input.verifiedHolidayCode as string : '__MISSING__',
      '연령코드': input.verifiedAgeCode as string,
      baseline_observed: input.previousLocalDayMinutes,
    },
  };
}

export async function requestSurveyV2Pilot(
  request: SurveyV2PilotRequest,
  config: { url?: string; token?: string; timeoutMs?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<SurveyV2PilotPrediction | null> {
  const baseline = request.features.baseline_observed;
  if (request.model !== SURVEY_V2_PILOT_MODEL ||
      request.baseline_definition !== SURVEY_V2_PILOT_BASELINE ||
      !Number.isInteger(request.history_count) ||
      request.history_count < 10 || request.history_count > 30 ||
      !validObserved(baseline) ||
      !config.url || !config.token || !validMlEndpoint(config.url)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(),
    Math.max(100, Math.min(5000, config.timeoutMs ?? 1500)));
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
    if (v.model !== SURVEY_V2_PILOT_MODEL ||
        v.training_target !== SURVEY_V2_PILOT_TARGET ||
        v.baseline_definition !== SURVEY_V2_PILOT_BASELINE ||
        v.prediction_type !== 'ratio' ||
        typeof v.minutes !== 'number' || !Number.isFinite(v.minutes) ||
        typeof v.ratio !== 'number' || !Number.isFinite(v.ratio) ||
        v.minutes < 5 || v.minutes > 240 || v.ratio < .5 || v.ratio > 2 ||
        Math.abs(v.minutes - baseline * v.ratio) > 2) return null;
    return {
      model: SURVEY_V2_PILOT_MODEL,
      training_target: SURVEY_V2_PILOT_TARGET,
      baseline_definition: SURVEY_V2_PILOT_BASELINE,
      minutes: Math.round(v.minutes),
      ratio: v.ratio,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
