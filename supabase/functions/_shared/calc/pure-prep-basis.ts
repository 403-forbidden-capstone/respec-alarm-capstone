// Pure-preparation baseline selection; never consume legacy wake-to-departure records.
export type PurePrepSource = 'MANUAL' | 'MODEL' | 'HISTORY' | 'PROFILE';
export type PurePrepCandidate = { source: PurePrepSource; minutes: number; model?: string; sampleCount?: number };
export type PurePrepModelOutput = {
  minutes: number; model: string;
  trainingTarget: 'actual_start_depart' | 'survey_start_cluster_proxy';
};
export type PurePrepBasisInput = {
  profileMinutes?: number | null;
  manualMinutes?: number | null;
  // Observations must be completed and causal at prediction time, newest first.
  historicalMinutes?: readonly number[];
  prediction?: PurePrepModelOutput | null;
  allowActualModel?: boolean;
  minHistory?: number;
};
const valid = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x) && x >= 5 && x <= 240;
// 5-9 minutes are valid explicit user input, but too noisy for automatic
// historical estimates (legacy D107 uses a 10-minute observation floor).
const validObserved = (x: unknown): x is number => valid(x) && x >= 10;
export const PURE_PREP_PROFILE_PRIOR = 10;
// Preserve the user's explicitly updated expectation as a prior, instead of
// silently replacing it with pre-edit historical observations.
export function choosePurePrepBasis(i: PurePrepBasisInput): PurePrepCandidate | null {
  if (valid(i.manualMinutes)) return { source: 'MANUAL', minutes: i.manualMinutes };
  const observations = (i.historicalMinutes ?? []).filter(validObserved).slice(0, 30);
  const minHistory = Math.max(3, Math.floor(i.minHistory ?? 3));
  const profile = valid(i.profileMinutes) ? i.profileMinutes : null;
  const sum = observations.reduce((n, v) => n + v, 0);
  const history = observations.length >= minHistory
    ? Math.round(profile == null ? sum / observations.length :
      (PURE_PREP_PROFILE_PRIOR * profile + sum) / (PURE_PREP_PROFILE_PRIOR + observations.length))
    : null;
  // A research survey proxy must never silently control real alarm times.
  if (i.allowActualModel === true &&
      i.prediction?.trainingTarget === 'actual_start_depart' &&
      valid(i.prediction.minutes) &&
      history != null && i.prediction.model === 'prep_start_ratio_v2') {
    return { source: 'MODEL', minutes: Math.round(i.prediction.minutes),
      model: i.prediction.model, sampleCount: observations.length };
  }
  if (history != null) return { source: 'HISTORY', minutes: history, sampleCount: observations.length };
  if (valid(i.profileMinutes)) return { source: 'PROFILE', minutes: i.profileMinutes };
  return null;
}

export type PrepCompletionRow = {
  prepare_started_at: string | null;
  departed_at: string | null;
  prepare_started_source?: string | null;
  departed_source?: string | null;
};

// Histories must be *past* completed real-world events, never time slots,
// predicted alarm times, scheduled departures, or the target day's outcome.
export function confirmedPurePrepHistory(
  records: readonly PrepCompletionRow[], cutoff: Date, maxRecords = 30,
  // Any preference edit begins a new observation epoch. Old sessions may not
  // erase a newly saved pure-preparation estimate.
  since?: Date,
): number[] {
  const before = cutoff.getTime();
  const after = since?.getTime();
  if (!Number.isFinite(before) || (since != null && !Number.isFinite(after))) return [];
  const unique = new Set<string>();
  return records.flatMap((r) => {
    // ROUTINE_STEP can be breakfast or another pre-prep task; it is not yet
    // verified as the physical beginning of pure outing preparation.
    if (r.prepare_started_source !== 'PREPARE_ALARM' ||
        r.departed_source !== 'LOCATION' ||
        !r.prepare_started_at || !r.departed_at) return [];
    const start = Date.parse(r.prepare_started_at);
    const depart = Date.parse(r.departed_at);
    const minutes = (depart - start) / 60000;
    if (!Number.isFinite(start) || !Number.isFinite(depart) ||
        depart >= before || depart <= start || (after != null && start < after) ||
        !validObserved(minutes)) return [];
    const key = start + ':' + depart;
    if (unique.has(key)) return [];
    unique.add(key);
    return [{ depart, minutes }];
  }).sort((a,b) => b.depart - a.depart)
    .slice(0, Math.max(0, Math.min(30, maxRecords)))
    .map(x => x.minutes);
}
