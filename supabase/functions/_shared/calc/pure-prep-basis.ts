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
export function choosePurePrepBasis(i: PurePrepBasisInput): PurePrepCandidate | null {
  if (valid(i.manualMinutes)) return { source: 'MANUAL', minutes: i.manualMinutes };
  const observations = (i.historicalMinutes ?? []).filter(valid).slice(0, 30);
  const minHistory = Math.max(3, Math.floor(i.minHistory ?? 3));
  const history = observations.length >= minHistory
    ? Math.round(observations.reduce((n, v) => n + v, 0) / observations.length)
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
): number[] {
  const before = cutoff.getTime();
  if (!Number.isFinite(before)) return [];
  const unique = new Set<string>();
  return records.flatMap((r) => {
    if (r.prepare_started_source !== 'PREPARE_ALARM' ||
        r.departed_source !== 'LOCATION' ||
        !r.prepare_started_at || !r.departed_at) return [];
    const start = Date.parse(r.prepare_started_at);
    const depart = Date.parse(r.departed_at);
    const minutes = (depart - start) / 60000;
    if (!Number.isFinite(start) || !Number.isFinite(depart) ||
        depart >= before || depart <= start || !valid(minutes)) return [];
    const key = start + ':' + depart;
    if (unique.has(key)) return [];
    unique.add(key);
    return [{ depart, minutes }];
  }).sort((a,b) => b.depart - a.depart)
    .slice(0, Math.max(0, Math.min(30, maxRecords)))
    .map(x => x.minutes);
}
