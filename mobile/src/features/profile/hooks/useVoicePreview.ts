// 말소리 미리 듣기 재생 — 알람을 울리지 않고 음성만 한 번. 새로 누르면 앞 음성을 멈추고, 화면을 벗어나면 멈춤
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { useFocusEffect } from 'expo-router';
import * as Speech from 'expo-speech';
import { useCallback, useRef } from 'react';

import { now } from '@/lib/clock';

import { previewVoiceName, voicePreviewOf, type VoiceTone } from '../voicePreview';

// 실제 알람이 쓰는 3단계 예비 WAV 그대로 (네이티브 res/raw — 앱 번들에도 같은 파일을 넣음)
const GEMINI_STAGE3_WAV = require('../../../../modules/alarm-core/android/src/main/res/raw/gemini_stage4_fallback.wav');

export function useVoicePreview(): (tone: VoiceTone) => void {
  const player = useRef<AudioPlayer | null>(null);
  const turn = useRef(0); // 목소리 목록을 읽는 사이 다른 버튼을 누르거나 화면을 벗어나면 앞 재생은 버림

  const stop = useCallback(() => {
    turn.current += 1;
    void Speech.stop();
    player.current?.remove();
    player.current = null;
  }, []);

  useFocusEffect(useCallback(() => stop, [stop]));

  return useCallback(
    (tone: VoiceTone) => {
      stop();
      const mine = turn.current;
      const p = voicePreviewOf(tone, now().getTime());
      if (p.kind === 'GEMINI_WAV') {
        player.current = createAudioPlayer(GEMINI_STAGE3_WAV);
        player.current.play();
        return;
      }
      void Speech.getAvailableVoicesAsync()
        .catch(() => [])
        .then((voices) => {
          if (turn.current !== mine) return;
          Speech.speak(p.text, { language: 'ko', pitch: p.pitch, rate: p.rate, voice: previewVoiceName(voices, p.voiceIndex) });
        });
    },
    [stop],
  );
}
