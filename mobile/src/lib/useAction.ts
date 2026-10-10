import { useCallback, useRef, useState } from 'react';

import { toast } from '@/components/ui';

import { userMessage } from './errors';

// 버튼 동작(쓰기)을 한 번에 하나씩 — 도는 동안 다시 누르면 무시, 실패하면 토스트로 (이유는 UserError일 때만)
// 실데이터(Supabase)가 붙으면 네트워크 오류 · 연타가 생기므로 쓰기 버튼은 이걸로 감쌈
export function useAction() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  // fallback = UserError가 아닐 때 보일 문구 (예: '루틴을 저장하지 못했어요')
  const run = useCallback(async (task: () => Promise<void>, fallback?: string) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await task();
    } catch (e) {
      // 서버 · DB 오류 원문(영어나 내부 칼럼 이름이 든 한글 raise 문구)은 보여 주지 않음 — 이유는 api.ts가 UserError로 던짐
      toast(userMessage(e, fallback));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);

  return { busy, run };
}
