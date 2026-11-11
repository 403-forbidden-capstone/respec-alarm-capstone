// 음성 브리핑 저장 — 메모리 대체가 네이티브(VoiceBriefing.kt)와 같은 남기기 규칙인지, 네이티브 다리가 JSON 하나로 넘기는지 · 예전 APK에서 조용히 넘어가는지
import { describe, expect, it, jest } from '@jest/globals';

import { createMemoryBackend } from '../memoryBackend';
import { createNativeBackend, type NativeAlarmCore } from '../nativeBackend';
import { buildRingPlan } from '../plan';
import type { RingPackage, VoiceBriefingSave } from '../types';

const NOW = 1_700_000_000_000;
const ID = '3f2b1c0e-5a4d-4e8f-9b7a-1c2d3e4f5a6b';
const pkg: RingPackage = { alarmId: ID, type: 'WAKE', atMillis: NOW + 60_000, title: '회의', intensity: 'NORMAL', snoozeLimit: 3 };
const rule = { urgentAtMs: NOW + 3_600_000, maxLevel: 4 };
const clip = (level: number, hash: string) => ({ level, hash, text: `${level}단계 문장`, pitch: 1, rate: 1, voiceIndex: 0 });
const audio = (level: number, hash: string) => ({ level, hash, mime: 'audio/wav', data: 'UklGRg==' });

describe('메모리 대체 — 음성 캐시', () => {
  it('새 음성은 저장, 열쇠가 같은 예전 음성은 남김, 내용이 바뀌었는데 못 만든 단계는 버림', async () => {
    const b = createMemoryBackend(() => NOW);
    await b.schedule(pkg, buildRingPlan(pkg));
    await b.saveVoiceBriefing(ID, { rule, clips: [clip(1, 'a1'), clip(2, 'a2')], audio: [audio(1, 'a1'), audio(2, 'a2')] });
    expect((await b.getVoiceBriefingHashes(ID)).sort()).toEqual(['a1', 'a2']);
    // 1단계는 그대로(서버가 have를 보고 안 만듦), 2단계는 일정이 바뀌어 새 열쇠인데 생성 실패 → 낡은 음성을 남기지 않음
    await b.saveVoiceBriefing(ID, { rule, clips: [clip(1, 'a1'), clip(2, 'b2')], audio: [] });
    expect(await b.getVoiceBriefingHashes(ID)).toEqual(['a1']);
  });

  it('알람을 지우거나 로그아웃(cancelAll)하면 음성도 지움', async () => {
    const b = createMemoryBackend(() => NOW);
    const save: VoiceBriefingSave = { rule, clips: [clip(1, 'a1')], audio: [audio(1, 'a1')] };
    await b.saveVoiceBriefing(ID, save);
    await b.cancel(ID);
    expect(await b.getVoiceBriefingHashes(ID)).toEqual([]);
    await b.saveVoiceBriefing(ID, save);
    await b.cancelAll();
    expect(await b.getVoiceBriefingHashes(ID)).toEqual([]);
  });

  it('울리는 알람 화면에 브리핑 문장이 같이 옴 (음성을 못 틀어도 일정이 보임)', async () => {
    const b = createMemoryBackend(() => NOW);
    await b.saveVoiceBriefing(ID, { rule, clips: [clip(1, 'a1')], audio: [] });
    await b.ringNow(pkg, buildRingPlan(pkg));
    expect((await b.getRinging())?.briefingText).toBe('1단계 문장');
  });
});

describe('네이티브 다리', () => {
  const base = {} as NativeAlarmCore;

  it('저장 값을 JSON 글자 하나로 넘김', async () => {
    const saveVoiceBriefing = jest.fn(async (_id: string, _json: string) => undefined);
    const b = createNativeBackend({ ...base, saveVoiceBriefing, getVoiceBriefingHashes: async () => ['a1'] });
    const value: VoiceBriefingSave = { rule, clips: [clip(1, 'a1')], audio: [audio(1, 'a1')] };
    await b.saveVoiceBriefing(ID, value);
    expect(saveVoiceBriefing).toHaveBeenCalledWith(ID, JSON.stringify(value));
    expect(await b.getVoiceBriefingHashes(ID)).toEqual(['a1']);
  });

  it('함수가 없는 예전 APK면 던지지 않고 건너뜀 (알람은 기본 알람음)', async () => {
    const b = createNativeBackend(base);
    await expect(b.saveVoiceBriefing(ID, { rule: null, clips: [], audio: [] })).resolves.toBeUndefined();
    await expect(b.getVoiceBriefingHashes(ID)).resolves.toEqual([]);
    await expect(b.clearVoiceBriefing(ID)).resolves.toBeUndefined();
  });
});
