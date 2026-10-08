import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

type LoadState<T> = { data: T | undefined; error: Error | null };

// 화면에 들어올 때마다 데이터를 읽음 — 다른 화면에서 바꾼 값(알람 켜기 등)이 돌아왔을 때 보이게
// load는 features/*/api.ts 함수를 부르는 함수 (지금은 목업 데이터, 나중에 Supabase)
// data === undefined면 읽는 중, null이면 api가 "없음"을 돌려준 것
export function useLoad<T>(load: () => Promise<T>) {
  const [state, setState] = useState<LoadState<T>>({ data: undefined, error: null });
  const loadRef = useRef(load);
  const latest = useRef(0); // 마지막 요청 번호 — 늦게 끝난 앞 요청이 새 값을 덮지 않게

  useEffect(() => {
    loadRef.current = load;
  });

  // onDone: 읽기가 끝나면 성공 여부와 함께 부름 — reload를 기다릴 때
  const run = useCallback((onDone?: (ok: boolean) => void) => {
    const id = ++latest.current;
    const current = () => id === latest.current;
    loadRef.current().then(
      (data) => {
        if (current()) setState({ data, error: null });
        onDone?.(true);
      },
      (error: unknown) => {
        if (current()) setState((prev) => ({ data: prev.data, error: error instanceof Error ? error : new Error(String(error)) }));
        onDone?.(false);
      },
    );
    // 화면을 떠나면 늦게 오는 응답은 버림
    return () => {
      if (current()) latest.current++;
    };
  }, []);

  useFocusEffect(useCallback(() => run(), [run]));

  // 값을 바꾼 뒤 같은 화면에서 다시 읽을 때 — 기다리면 다 읽은 뒤에 이어감(저장 뒤 초안 버리기 등), 다시 읽기에 성공했는지 돌려줌
  // 주의: "읽기가 끝났는지"이지 "이 응답이 화면에 반영됐는지"가 아님 — 더 새 읽기에 밀려 버려진 응답도 true
  const reload = useCallback(() => new Promise<boolean>((resolve) => void run(resolve)), [run]);

  return { data: state.data, error: state.error, reload };
}
