// New-semantics alarm calculation. Use only with explicitly confirmed pure
// preparation duration, never with the legacy wake->departure profile/record.
// This adapter preserves the existing alarm-chain manual-time and advance rules.
import { alarmChain } from './chain.ts';
import type { ChainAlarm, ChainInput } from './types.ts';
import { DEFAULT_BEFORE_PREPARE_MINUTES } from './prepare.ts';

export type PurePrepInput = Omit<ChainInput, 'prepareMinutes' | 'beforePrepareMinutes'> & {
  purePrepMinutes: number; // actual preparation START -> physical departure
  prePrepTaskMinutes?: number; // before preparation; excludes fixed 20-minute lead
  wakeLeadMinutes?: number; // defaults to existing fixed 20-minute lead
};

export function purePrepChainInput(i: PurePrepInput): ChainInput {
  const prep = i.purePrepMinutes;
  const tasks = i.prePrepTaskMinutes ?? 0;
  const lead = i.wakeLeadMinutes ?? DEFAULT_BEFORE_PREPARE_MINUTES;
  for (const [name, n, max] of [
    ['purePrepMinutes', prep, 240],
    ['prePrepTaskMinutes', tasks, 240],
    ['wakeLeadMinutes', lead, 240],
  ] as const) {
    if (!Number.isFinite(n) || n < (name === 'purePrepMinutes' ? 5 : 0) || n > max)
      throw new RangeError('Invalid ' + name);
  }
  const before = i.withWake ? tasks + lead : 0;
  if (before > 480) throw new RangeError('Invalid combined pre-preparation duration');
  return {
    at: i.at,
    travelMinutes: i.travelMinutes,
    bufferMinutes: i.bufferMinutes,
    kinds: i.kinds,
    withWake: i.withWake,
    manualTimes: i.manualTimes,
    prepareAdvanceMinutes: i.prepareAdvanceMinutes,
    beforePrepareMinutes: before,
    // Existing chain expects WAKE->DEPARTURE when withWake=true,
    // but pure PREPARE->DEPARTURE when withWake=false.
    prepareMinutes: prep + before,
  };
}
export function purePrepAlarmChain(input: PurePrepInput): ChainAlarm[] {
  return alarmChain(purePrepChainInput(input));
}
