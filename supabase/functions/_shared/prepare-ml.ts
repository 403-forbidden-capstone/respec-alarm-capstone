// C1/W4 CatBoost sidecar. Server-only; token must never reach Expo.
import { localDateKey } from './tz.ts';

export type MlModel = 'c1_mae' | 'w4_mae';
export type MlPrediction = { model: MlModel; minutes: number };
export type MlProfile = {
  ml_codes_verified?: boolean | null;
  ml_age_code?: string | null;
};
export type MlRequest = { model: MlModel; features: Record<string, string | number> };
export type MlConfig = { enabled: boolean; url?: string; token?: string; timeoutMs?: number };
export type MlFetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>;

// Production inference is restricted to explicitly approved test user UUIDs.
// Empty or malformed allowlists fail closed, even when PREPARE_ML_ENABLED=1.
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function mayUseMl(args: {
  enabled: boolean;
  allowForPlan: boolean;
  userId: string;
  allowedUserIds?: string | null;
}): boolean {
  if (!args.enabled || !args.allowForPlan || !UUID_PATTERN.test(args.userId)) return false;
  return (args.allowedUserIds ?? '').split(',')
    .map((s) => s.trim())
    .filter((s) => UUID_PATTERN.test(s))
    .some((s) => s.toLowerCase() === args.userId.toLowerCase());
}

// A trusted Edge-service read is still not enough without a versioned codebook
// and recorded consent. Client-writable public.profiles fields are never accepted.
export type VerifiedMlProfile = MlProfile & {
  codebook_version?: string | null;
  consent_at?: string | null;
  verified_at?: string | null;
};
export function approvedMlProfile(
  profile: VerifiedMlProfile | null,
  expectedVersion: string | null | undefined,
): MlProfile | null {
  if (!profile || !expectedVersion?.trim() ||
      profile.codebook_version !== expectedVersion ||
      !profile.consent_at || !profile.verified_at) return null;
  const consent = Date.parse(profile.consent_at);
  const verified = Date.parse(profile.verified_at);
  if (!Number.isFinite(consent) || !Number.isFinite(verified) || consent > Date.now() ||
      verified > Date.now()) return null;
  if (!validAgeCode(profile.ml_age_code)) return null;
  return {
    ml_codes_verified: true,
    ml_age_code: profile.ml_age_code,
  };
}

const MISSING = '__MISSING__';
// Observed in the uploaded 2024 Time Use Survey microdata:
 // age 10-19 => 1, 20-29 => 2, ... 70-79 => 7, 80+ => 8.
 // The official age-code dictionary must still be cross-checked before rollout.
const validAgeCode = (value: string | null | undefined): value is string =>
  typeof value === 'string' && /^[1-8]$/.test(value);

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

// Do not infer codes from a client-sent request. Only server-verified, consented
// age codes are eligible, and model use remains disabled by default.
export function buildMlRequest(args: {
  appointmentAt: Date;
  timezone: string;
  profile: MlProfile;
  previousDayMinutes: number | null;
}): MlRequest | null {
  if (!args.profile.ml_codes_verified) return null;
  const { ml_age_code: age } = args.profile;
  if (!validAgeCode(age)) return null;
  const previous = args.previousDayMinutes;
  const isWarm = typeof previous === 'number' && Number.isFinite(previous) && previous >= 10 && previous <= 240;
  const features: Record<string, string | number> = {
    ...calendarFeatures(args.appointmentAt, args.timezone),
    '연령코드': age,
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
