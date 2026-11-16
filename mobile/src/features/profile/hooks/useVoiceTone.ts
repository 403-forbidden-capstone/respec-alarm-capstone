// 설정 > AI 음성 브리핑 말소리 약 · 중 · 강 — 누르면 선택 표시를 바로 바꾸고 미리 듣기 + 저장. 저장에 실패하면 이전 선택으로 되돌림
//   실데이터: profiles.preferred_voice_tone, 가짜 데이터 모드(userId 없음): 목업 db (profile/api saveVoiceTone)
//   저장 중에 또 누르면 저장이 끝난 뒤 마지막으로 누른 값을 이어서 저장 (중간 값은 건너뜀)
import { useRef, useState } from 'react';

import { forgetAllDetails } from '@/features/alarm/detailCache';
import { useAction } from '@/lib/useAction';

import { mockVoiceTone, saveVoiceTone } from '../api';
import { saveLatest } from '../saveLatest';
import type { VoiceTone } from '../voicePreview';
import { useVoicePreview } from './useVoicePreview';

export function useVoiceTone(userId: string | undefined, saved: VoiceTone | null | undefined, refresh: () => Promise<void>) {
  const { run } = useAction();
  const preview = useVoicePreview();
  const [picked, setPicked] = useState<{ tone: VoiceTone | null } | null>(null); // 누른 값 — 저장 · 새로 읽기가 끝나면 비움
  const [mock, setMock] = useState(mockVoiceTone);
  const want = useRef<VoiceTone | null>(null); // 마지막으로 누른 값
  const tone = picked ? picked.tone : userId ? (saved ?? null) : mock;

  const pick = (next: VoiceTone) => {
    preview(next);
    if (next === tone) return;
    want.current = next;
    setPicked({ tone: next });
    // 이미 저장 중이면 run이 바로 끝나고, 돌고 있는 저장이 want를 보고 이어서 저장함
    void run(async () => {
      let stored: VoiceTone | null | undefined; // 이번에 저장을 마친 값
      try {
        await saveLatest(() => want.current, (t) => saveVoiceTone(userId, t), (t) => (stored = t));
      } catch (e) {
        setPicked(stored === undefined ? null : { tone: stored }); // 저장 못 한 값은 버리고 마지막으로 저장된 값(없으면 이전 선택)
        throw e;
      } finally {
        if (stored !== undefined) forgetAllDetails(); // 알람 설정(H03)의 말소리 자동 값이 바뀜
      }
      if (!userId) setMock(stored ?? null);
      else
        try {
          await refresh();
        } catch {
          return; // 저장은 됨 — 누른 값을 그대로 보임
        }
      setPicked(null);
    }, '말소리를 저장하지 못했어요');
  };

  return { tone, pick };
}
