// 기상 AI 음성 브리핑 미리 받기 — 가짜 서버(Mock)로: 열쇠 보내기 · 저장 · 끄면 지움 · 없는 알람 지움 · 네트워크 실패에도 있던 음성 유지
import { describe, expect, it, jest } from '@jest/globals';
import type { ScheduledAlarm } from '@capstone/alarm-core';
import { levelAt, resolveVoice, urgencyRule, type UrgencyRule } from '@shared/briefing.ts';

import { BRIEFING_WINDOW_MS, prepareBriefings, type BriefingDeps, type BriefingOut } from '../briefing';
import { EdgeError } from '../../edge';

jest.mock('@capstone/alarm-core', () => ({}));
jest.mock('../../supabase', () => ({ supabase: { functions: { invoke: jest.fn() } } }));

const NOW = 1_800_000_000_000;
const alarm = (id: string, type: ScheduledAlarm['type'], inMs: number): ScheduledAlarm => ({ id, type, intensity: 'NORMAL', title: 't', atMillis: NOW + inMs, snoozeCount: 0, nextRingAt: NOW + inMs });
const OUT: BriefingOut = {
  enabled: true,
  rule: { urgentAtMs: NOW + 3_600_000, maxLevel: 4 },
  clips: [{ level: 1, hash: 'aaaaaaaaaaaaaaaa', text: '좋은 아침이야~', pitch: 1, rate: 1, voiceIndex: 0 }],
  audio: [{ level: 4, hash: 'aaaaaaaaaaaaaaaa', mime: 'audio/wav', data: 'UklGRg==' }],
  gemini: 'MADE',
};

function deps(over: Partial<BriefingDeps> = {}, alarms: ScheduledAlarm[] = [alarm('w1', 'WAKE', 3_600_000)]) {
  const calls: { id: string; have: string[] }[] = [];
  const saved: string[] = [];
  const cleared: string[] = [];
  const d: BriefingDeps = {
    list: async () => alarms,
    getHashes: async () => ['bbbbbbbbbbbbbbbb'],
    save: async (id) => void saved.push(id),
    clear: async (id) => void cleared.push(id),
    call: async (id, have) => {
      calls.push({ id, have });
      return OUT;
    },
    ...over,
  };
  return { d, calls, saved, cleared };
}

describe('prepareBriefings', () => {
  it('다가오는 기상 · 출발 알람만 — 폰에 있는 열쇠를 have로 보내고 결과를 저장', async () => {
    const t = deps({}, [alarm('w1', 'WAKE', 3_600_000), alarm('d1', 'DEPARTURE', 7_200_000), alarm('p1', 'PREPARE', 3_600_000), alarm('far', 'WAKE', BRIEFING_WINDOW_MS + 1), alarm('past', 'WAKE', -1)]);
    const s = await prepareBriefings(NOW, t.d);
    expect(t.calls).toEqual([{ id: 'w1', have: ['bbbbbbbbbbbbbbbb'] }, { id: 'd1', have: ['bbbbbbbbbbbbbbbb'] }]);
    expect(t.saved).toEqual(['w1', 'd1']);
    expect(s.saved).toEqual(['w1', 'd1']);
  });

  it('예전 규칙이 저장된 알람도 다시 맞추면 서버의 새 규칙(여유 5분 · 0분 시각)을 그대로 덮어 저장 → 실제 일정 기준 5분 3단계 · 0분 4단계', async () => {
    // 실제 일정 모양: 오전 10시 약속 · 준비 50분 · 이동 40분 → 서버가 계산한 규칙 (배포된 alarm-briefing과 같은 식)
    const appointmentAtMs = NOW + 3 * 3_600_000;
    const rule = urgencyRule({ kind: 'WAKE', appointmentAtMs, prepMinutes: 50, travelMinutes: 40 }, resolveVoice('NORMAL'));
    const saves: { id: string; rule: unknown }[] = [];
    const t = deps({
      getHashes: async () => ['cccccccccccccccc'], // 폰에는 예전 브리핑(예전 규칙 · 예전 긴급 음성)이 있음
      save: async (id, data) => void saves.push({ id, rule: data.rule }),
      call: async () => ({ ...OUT, rule }),
    });
    await prepareBriefings(NOW, t.d);
    expect(saves).toEqual([{ id: 'w1', rule }]); // 있던 것과 상관없이 서버를 다시 불러 새 규칙으로 덮어씀
    const saved = saves[0].rule as UrgencyRule;
    const slack5 = appointmentAtMs - (50 + 40 + 5) * 60_000;
    const slack0 = appointmentAtMs - (50 + 40) * 60_000;
    expect([levelAt(saved, 0, slack5 - 1), levelAt(saved, 0, slack5), levelAt(saved, 0, slack0 - 1), levelAt(saved, 0, slack0)]).toEqual([1, 3, 3, 4]);
    expect([levelAt(saved, 1, NOW), levelAt(saved, 2, NOW), levelAt(saved, 9, NOW)]).toEqual([2, 3, 3]); // 스누즈만으로는 4 안 됨
  });

  it('개발 화면 시험 알람(de70a1a0-)은 서버를 안 부르고 시험 브리핑도 안 건드림 — 오프라인 시험 · Gemini 재호출 없음', async () => {
    const t = deps({}, [alarm('de70a1a0-aaaa-4bbb-8ccc-dddddddddddd', 'WAKE', 60_000), alarm('w1', 'WAKE', 3_600_000)]);
    await prepareBriefings(NOW, t.d);
    expect(t.calls.map((c) => c.id)).toEqual(['w1']);
    expect(t.saved).toEqual(['w1']);
    expect(t.cleared).toEqual([]);
  });

  it('사용자가 끄면(enabled false) 그 알람 음성을 지움', async () => {
    const t = deps({ call: async () => ({ ...OUT, enabled: false, rule: null, clips: [], audio: [], gemini: 'NOT_NEEDED' as const }) });
    await prepareBriefings(NOW, t.d);
    expect(t.cleared).toEqual(['w1']);
    expect(t.saved).toEqual([]);
  });

  it('네트워크 끊김 · 서버 404(NOT_FOUND)여도 저장된 브리핑을 지우지 않음 (알람 · 오프라인 재생 그대로)', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined); // 개발 중 경고 한 줄 (의도한 것)
    for (const code of ['NETWORK', 'TIMEOUT', 'NOT_FOUND', 'INTERNAL'] as const) {
      const t = deps({ call: async () => Promise.reject(new EdgeError(code)) });
      const s = await prepareBriefings(NOW, t.d);
      expect(s.failed).toEqual(['w1']);
      expect(t.cleared).toEqual([]);
      expect(t.saved).toEqual([]);
    }
  });

  it('Gemini 한도 초과 · 실패여도 문장은 저장 (폰은 Android TTS로 전체 브리핑)', async () => {
    const t = deps({ call: async () => ({ ...OUT, audio: [], gemini: 'LIMITED' as const }) });
    const s = await prepareBriefings(NOW, t.d);
    expect(t.saved).toEqual(['w1']);
    expect(s.failed).toEqual(['w1']);
  });

  it('맞추기가 연달아 와도 한 번만 돎', async () => {
    const t = deps();
    await Promise.all([prepareBriefings(NOW, t.d), prepareBriefings(NOW, t.d)]);
    expect(t.calls).toHaveLength(1);
  });
});
