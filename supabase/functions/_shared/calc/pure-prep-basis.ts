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
      history != null && i.prediction.model.trim() !== '') {
    return { source: 'MODEL', minutes: Math.round(i.prediction.minutes),
      model: i.prediction.model, sampleCount: observations.length };
  }
  if (history != null) return { source: 'HISTORY', minutes: history, sampleCount: observations.length };
  if (valid(i.profileMinutes)) return { source: 'PROFILE', minutes: i.profileMinutes };
  return null;
}
