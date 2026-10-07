import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

type LoadState<T> = { data: T | undefined; error: Error | null };

// 화면에 들어올 때마다 데이터를 읽음 — 다른 화면에서 바꾼 값(알람 켜기 등)이 돌아왔을 때 보이게
// load는 features/*/api.ts 함수를 부르는 함수 (지금은 목업 데이터, 나중에 Supabase)
export function useLoad<T>(load: () => Promise<T>) {
  const [state, setState] = useState<LoadState<T>>({ data: undefined, error: null });
  const loadRef = useRef(load);

  useEffect(() => {
    loadRef.current = load;
  });

  const run = useCallback(() => {
    let cancelled = false;
    loadRef.current().then(
      (data) => {
        if (!cancelled) setState({ data, error: null });
      },
      (error: unknown) => {
        if (!cancelled) setState((prev) => ({ data: prev.data, error: error instanceof Error ? error : new Error(String(error)) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useFocusEffect(run);

  // 값을 바꾼 뒤 같은 화면에서 다시 읽을 때
  const reload = useCallback(() => {
    run();
  }, [run]);

  return { data: state.data, error: state.error, reload };
}
