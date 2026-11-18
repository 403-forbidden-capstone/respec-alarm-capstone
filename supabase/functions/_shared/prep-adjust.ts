// Experimental preparation-only personalization (NOT wake-to-departure).
// Disabled by default. Historical durations must come from actual prepare start
// and actual departure; never from daily_records.actual_prepare_minutes.
// The current 2024 survey CatBoost model is only a proxy, NOT production-validated.
import { calendarFeatures, validMlEndpoint } from './prepare-ml.ts';

export const PREP_ADJUST_MIN_RECORDS = 3;
export const PREP_ADJUST_MAX_RECORDS = 30;
export const PREP_ADJUST_MODEL = 'prep_ratio_v1' as const;

export type PrepHistoryRow = {
  prepare_started_at: string | null;
  departed_at: string | null;
  prepare_started_source?: string | null;
};
export type PrepHistory = { minutes: number[]; count: number; baselineMinutes: number };
export type PrepAdjustRequest = {
  model: typeof PREP_ADJUST_MODEL;
  features: {
    weekday_code: string;
    '평토일구분코드': string;
    '휴일종류코드': string;
    '연령코드': string;
    baseline_observed: number;
  };
  history_count: number; // informational only: not a trained CatBoost feature
};
export type PrepAdjustment = { model: typeof PREP_ADJUST_MODEL; minutes: number; ratio: number };
export type PrepAdjustConfig = { enabled: boolean; url?: string; token?: string; timeoutMs?: number };
export type PrepAdjustFetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>;

const inRange = (n: number) => Number.isFinite(n) && n >= 5 && n <= 240;

// PREPARE_ALARM is written on USER DISMISS / one-tap "start preparing" (PR #490),
// not at the scheduled alarm time. It is imperfect self-reported evidence; never
// use the scheduled PREPARE alarm itself. ROUTINE_STEP is retained for compatibility.
export function preparationHistory(rows: readonly PrepHistoryRow[], asOf: Date): PrepHistory | null {
  if (!Number.isFinite(asOf.getTime())) return null;
  const valid = rows.flatMap((r) => {
    if (!['PREPARE_ALARM', 'ROUTINE_STEP'].includes(r.prepare_started_source ?? '') || !r.prepare_started_at || !r.departed_at) return [];
    const start = Date.parse(r.prepare_started_at);
    const depart = Date.parse(r.departed_at);
    if (!Number.isFinite(start) || !Number.isFinite(depart) || start >= depart || depart >= asOf.getTime()) return [];
    const minutes = (depart - start) / 60_000;
    if (!inRange(minutes)) return [];
    return [{ depart, minutes }];
  }).sort((a, b) => b.depart - a.depart);
  // Protect against duplicated same event rows; take newest 30 independent completions.
  const used = new Set<number>();
  const minutes = valid.filter(({ depart }) => {
    if (used.has(depart)) return false;
    used.add(depart);
    return true;
  }).slice(0, PREP_ADJUST_MAX_RECORDS).map((x) => x.minutes);
  if (minutes.length < PREP_ADJUST_MIN_RECORDS) return null;
  return {
    minutes,
    count: minutes.length,
    baselineMinutes: Math.round(minutes.reduce((sum, n) => sum + n, 0) / minutes.length * 10) / 10,
  };
}

// No planned-activity flags: diary-day "observed 141/142" flags would leak the target.
// Never use legacy profiles.default_prepare_minutes here; it means wake-to-departure.
export function buildPrepAdjustRequest(
  at: Date, timezone: string, approvedAgeCode: string | null | undefined,
  approvedRestPattern: string | null | undefined, history: PrepHistory | null,
): PrepAdjustRequest | null {
  if (!history || !/^[1-8]$/.test(approvedAgeCode ?? '') || !inRange(history.baselineMinutes)) return null;
  const calendar = calendarFeatures(at, timezone);
  return {
    model: PREP_ADJUST_MODEL,
    features: {
      ...calendar,
      '연령코드': approvedAgeCode as string,
      '휴일종류코드': /^[1-6]$/.test(approvedRestPattern ?? '') ? approvedRestPattern as string : '__MISSING__',
      baseline_observed: history.baselineMinutes,
    },
    history_count: history.count,
  };
}

export async function requestPrepAdjustment(
  request: PrepAdjustRequest,
  config: PrepAdjustConfig,
  fetchImpl: PrepAdjustFetch = fetch,
): Promise<PrepAdjustment | null> {
  if (!config.enabled || !config.url || !config.token || !validMlEndpoint(config.url)) return null;
  if (request.history_count < PREP_ADJUST_MIN_RECORDS || !inRange(request.features.baseline_observed)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(100, Math.min(5000, config.timeoutMs ?? 1500)));
  try {
    const res = await fetchImpl(config.url.replace(/\/$/, '') + '/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': config.token },
      body: JSON.stringify(request), signal: controller.signal,
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!body || typeof body !== 'object') return null;
    const v = body as Record<string, unknown>;
    if (v.model !== PREP_ADJUST_MODEL || v.prediction_type !== 'ratio' ||
        typeof v.ratio !== 'number' || !Number.isFinite(v.ratio) || typeof v.minutes !== 'number' || !Number.isFinite(v.minutes)) return null;
    const ratio = v.ratio as number;
    const minutes = v.minutes as number;
    if (ratio < 0.5 || ratio > 2.0 || !inRange(minutes) ||
        Math.abs(minutes - request.features.baseline_observed * ratio) > 2) return null;
    return { model: PREP_ADJUST_MODEL, minutes: Math.round(minutes), ratio };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
