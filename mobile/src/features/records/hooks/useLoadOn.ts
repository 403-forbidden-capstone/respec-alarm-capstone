import { useEffect, useRef } from 'react';

import { useLoad } from '@/lib/useLoad';

// useLoad에 "기간이 바뀌면 다시 읽기"를 더함 — 앞 내용을 그대로 두고 새로 읽어서, 달력 · 화살표가 사라졌다 나타나지 않음
// (key를 바꿔 새로 그리면 읽는 동안 화면이 비었다가 다시 그려짐)
export function useLoadOn<T>(load: () => Promise<T>, period: string) {
  const result = useLoad(load);
  const { reload } = result;
  const last = useRef(period);

  useEffect(() => {
    if (last.current === period) return;
    last.current = period;
    void reload();
  }, [period, reload]);

  return result;
}
