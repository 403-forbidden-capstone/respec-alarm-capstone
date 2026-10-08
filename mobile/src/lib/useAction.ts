import { useCallback, useRef, useState } from 'react';

import { toast } from '@/components/ui';

// 버튼 동작(쓰기)을 한 번에 하나씩 — 도는 동안 다시 누르면 무시, 실패하면 이유를 토스트로
// 실데이터(Supabase)가 붙으면 네트워크 오류 · 연타가 생기므로 쓰기 버튼은 이걸로 감쌈
export function useAction() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const run = useCallback(async (task: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await task();
    } catch (e) {
      // 서버 오류 원문(영어)은 보여 주지 않음 — 이유를 알려야 하는 오류는 api.ts가 한국어로 바꿔 던짐
      const message = e instanceof Error ? e.message : '';
      toast(/[가-힣]/.test(message) ? message : '하지 못했어요. 다시 해 주세요');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);

  return { busy, run };
}
