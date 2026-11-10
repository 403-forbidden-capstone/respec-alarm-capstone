// 기상 · 출발 알람 음성 브리핑 미리 받기 — 폰 예약을 서버와 맞춘 뒤(onAlarmsSynced, useAlarmSync가 붙임) 다가오는 기상 · 출발 알람마다
//   서버 alarm-briefing에 "폰에 있는 긴급 음성 열쇠(have)"를 보내고, 단계별 문장(Android TTS) + 필요할 때만 만든 긴급 Gemini 음성을 받아 네이티브에 저장
//   알람이 울릴 때는 네트워크도 Gemini도 안 씀
//   일정 · 준비물 · 출발 시각 · 설정이 바뀌면 서버 문장이 바뀌어 열쇠가 달라지므로 그 단계만 새로 받음. 같으면 서버가 TTS를 안 부름
//   실패해도 알람에는 영향 없음 — 있던 음성을 그대로 두고(못 받은 단계 · 낡은 단계는 네이티브가 지움) 다음 맞추기에서 다시
import * as AlarmCore from '@capstone/alarm-core';
import type { VoiceBriefingSave } from '@capstone/alarm-core';

import { callEdge, EdgeError } from '../edge';

// 이만큼 안에 울릴 기상 · 출발 알람만 미리 만듦 (멀리 있는 알람은 그사이 일정이 바뀔 수 있어 그때 가서) — 작성자 판단
export const BRIEFING_WINDOW_MS = 36 * 60 * 60 * 1000;
// 긴급 Gemini 음성 하나를 만드는 시간까지 — 기본 20초보다 길게
const BRIEFING_TIMEOUT_MS = 90_000;

export type BriefingOut = VoiceBriefingSave & { enabled: boolean; gemini: 'NOT_NEEDED' | 'CACHED' | 'MADE' | 'LIMITED' | 'FAILED' | 'NOT_CONFIGURED' };
const BRIEFED_TYPES: ReadonlySet<string> = new Set(['WAKE', 'DEPARTURE']);

export type BriefingDeps = {
  list: typeof AlarmCore.list;
  getHashes: typeof AlarmCore.getVoiceBriefingHashes;
  save: typeof AlarmCore.saveVoiceBriefing;
  clear: typeof AlarmCore.clearVoiceBriefing;
  call: (alarmId: string, have: string[]) => Promise<BriefingOut>;
};

const defaultDeps: BriefingDeps = {
  list: AlarmCore.list,
  getHashes: AlarmCore.getVoiceBriefingHashes,
  save: AlarmCore.saveVoiceBriefing,
  clear: AlarmCore.clearVoiceBriefing,
  call: (alarmId, have) => callEdge<BriefingOut>('alarm-briefing', { alarm_id: alarmId, have }, { timeoutMs: BRIEFING_TIMEOUT_MS }),
};

export type BriefingSummary = { saved: string[]; cleared: string[]; failed: string[] };

let inFlight: Promise<BriefingSummary> | null = null;

/** 다가오는 기상 알람의 음성 브리핑을 맞춤. 이미 도는 중이면 그 결과를 같이 기다림 (맞추기가 연달아 와도 한 줄) */
export function prepareBriefings(nowMs: number = Date.now(), deps: BriefingDeps = defaultDeps): Promise<BriefingSummary> {
  if (inFlight) return inFlight;
  const run = prepareOnce(nowMs, deps).finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}

async function prepareOnce(nowMs: number, deps: BriefingDeps): Promise<BriefingSummary> {
  const summary: BriefingSummary = { saved: [], cleared: [], failed: [] };
  const wakes = (await deps.list()).filter((a) => BRIEFED_TYPES.has(a.type) && a.nextRingAt > nowMs && a.nextRingAt <= nowMs + BRIEFING_WINDOW_MS);
  for (const alarm of wakes) {
    try {
      const out = await deps.call(alarm.id, await deps.getHashes(alarm.id));
      if (!out.enabled) {
        await deps.clear(alarm.id); // 사용자가 AI 음성 브리핑을 끔
        summary.cleared.push(alarm.id);
        continue;
      }
      await deps.save(alarm.id, { rule: out.rule, clips: out.clips, audio: out.audio });
      // 긴급 음성을 못 만들었어도(한도 · 실패) 문장은 저장됨 — 폰은 Android TTS로 전체 브리핑
      (out.gemini === 'FAILED' || out.gemini === 'LIMITED' ? summary.failed : summary.saved).push(alarm.id);
    } catch (e) {
      // 서버에 없는 알람(지웠거나 꺼짐) → 그 음성도 지움. 네트워크 · 서버 오류는 있던 음성을 그대로 두고 다음에
      if (e instanceof EdgeError && e.code === 'NOT_FOUND') {
        await deps.clear(alarm.id).catch(() => undefined);
        summary.cleared.push(alarm.id);
      } else {
        summary.failed.push(alarm.id);
        if (__DEV__) console.warn('[briefing] 음성 브리핑을 못 받음 — 있던 음성 · 기본 알람음으로', alarm.id, e);
      }
    }
  }
  return summary;
}
