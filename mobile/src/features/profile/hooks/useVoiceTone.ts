// 설정 > AI 음성 브리핑 말소리 약 · 중 · 강 — 누르면 선택 표시를 바로 바꾸고 미리 듣기 + 저장. 저장에 실패하면 이전 선택으로 되돌림
//   실데이터: profiles.preferred_voice_tone, 가짜 데이터 모드(userId 없음): 목업 db (profile/api saveVoiceTone)
import { useState } from 'react';

import { useAction } from '@/lib/useAction';

import { mockVoiceTone, saveVoiceTone } from '../api';
import type { VoiceTone } from '../voicePreview';
import { useVoicePreview } from './useVoicePreview';

export function useVoiceTone(userId: string | undefined, saved: VoiceTone | null | undefined, refresh: () => Promise<void>) {
  const { run } = useAction();
  const preview = useVoicePreview();
  const [picked, setPicked] = useState<{ tone: VoiceTone | null } | null>(null); // 누른 값 — 저장 · 새로 읽기가 끝나면 비움
  const [mock, setMock] = useState(mockVoiceTone);
  const tone = picked ? picked.tone : userId ? (saved ?? null) : mock;

  const pick = (next: VoiceTone) => {
    preview(next);
    if (next === tone) return;
    setPicked({ tone: next });
    void run(async () => {
      try {
        await saveVoiceTone(userId, next);
      } catch (e) {
        setPicked(null); // 이전 선택으로
        throw e;
      }
      if (!userId) setMock(next);
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
