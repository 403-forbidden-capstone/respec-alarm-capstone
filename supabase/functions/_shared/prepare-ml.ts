// C1/W4 CatBoost sidecar. Server-only; token must never reach Expo.
import { localDateKey } from './tz.ts';

export type MlModel = 'c1_mae' | 'w4_mae';
export type MlPrediction = { model: MlModel; minutes: number };
export type MlProfile = {
  ml_codes_verified?: boolean | null;
  ml_age_code?: string | null;
  ml_education_code?: string | null;
  ml_economic_code?: string | null;
};
export type MlRequest = { model: MlModel; features: Record<string, string | number> };
export type MlConfig = { enabled: boolean; url?: string; token?: string; timeoutMs?: number };
export type MlFetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>;

const MISSING = '__MISSING__';
const validCode = (value: string | null | undefined): value is string =>
  typeof value === 'string' && /^[0-9]{1,3}$/.test(value);

// The requested date in the user's time zone, not the Edge server's UTC date.
export function previousDateKey(appointmentAt: Date, timezone: string): string {
  const day = localDateKey(appointmentAt, timezone);
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}

export function calendarFeatures(appointmentAt: Date, timezone: string) {
  const dayKey = localDateKey(appointmentAt, timezone);
  const weekday = new Date(dayKey + 'T12:00:00Z').getUTCDay();
  return {
    weekday_code: String(weekday),
    '평토일구분코드': weekday === 0 ? '3' : weekday === 6 ? '2' : '1',
    // The survey holiday-category codebook is not verified.
    '휴일종류코드': MISSING,
  };
}

// No automatic inferences for demographic codes. No model call until these are
// explicitly verified against the survey codebook and persisted in profiles.
export function buildMlRequest(args: {
  appointmentAt: Date;
  timezone: string;
  profile: MlProfile;
  previousDayMinutes: number | null;
}): MlRequest | null {
  if (!args.profile.ml_codes_verified) return null;
  const { ml_age_code: age, ml_education_code: education, ml_economic_code: economic } = args.profile;
  if (!validCode(age) || !validCode(education) || !validCode(economic)) return null;
  const previous = args.previousDayMinutes;
  const isWarm = typeof previous === 'number' && Number.isFinite(previous) && previous >= 10 && previous <= 240;
  const features: Record<string, string | number> = {
    ...calendarFeatures(args.appointmentAt, args.timezone),
    '연령코드': age,
    '교육재학코드': education,
    '경제활동상태코드': economic,
  };
  if (isWarm) features.previous_day_target_minutes = previous as number;
  return { model: isWarm ? 'w4_mae' : 'c1_mae', features };
}

// Local HTTP only for developer-controlled loopback/host Docker.
// Hosted Edge functions cannot reach your Mac's 127.0.0.1.
export function validMlEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password || u.search || u.hash) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' &&
      ['localhost', '127.0.0.1', 'host.docker.internal'].includes(u.hostname));
  } catch {
    return false;
  }
}

export async function requestMlPrediction(
  request: MlRequest,
  config: MlConfig,
  fetchImpl: MlFetch = fetch,
): Promise<MlPrediction | null> {
  if (!config.enabled || !config.url || !config.token || !validMlEndpoint(config.url)) return null;
  const timeoutMs = Math.max(100, Math.min(5000, config.timeoutMs ?? 1500));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
    const value = body as Record<string, unknown>;
    if (value.model !== request.model || value.prediction_type !== 'point' ||
        !Number.isInteger(value.minutes) || (value.minutes as number) < 10 || (value.minutes as number) > 240) return null;
    return { model: request.model, minutes: value.minutes as number };
  } catch {
    return null; // Optional model: callers preserve the existing prepare-time calculation.
  } finally {
    clearTimeout(timeout);
  }
}
