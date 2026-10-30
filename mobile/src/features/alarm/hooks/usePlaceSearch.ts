import { useCallback, useEffect, useRef, useState } from 'react';

import { SEARCH_DELAY_MS } from '../placeSheet';
import type { Place } from '../types';

export type PlaceSearchResult =
  | { kind: 'idle' } // 검색어가 비어 있음 — 찾지 않음
  | { kind: 'loading' }
  | { kind: 'done'; query: string; places: Place[] }
  | { kind: 'error'; query: string; error: unknown };

// 검색어(앞뒤 공백 뺀 것)가 0.3초 멈추면 search를 부름 — 지도 고르기 시트의 검색 칸용 (PlaceSearchSheet의 본문과 같은 규칙: 늦게 온 옛 응답은 버림)
//   search는 부모가 새 함수를 줘도 다음 검색부터 쓰고, 검색어가 비면 아무것도 찾지 않음 (최근 장소는 이 시트에서 안 보임)
export function usePlaceSearch(search: (query: string) => Promise<Place[]>, query: string) {
  const [result, setResult] = useState<PlaceSearchResult>({ kind: 'idle' });
  const searchRef = useRef(search);
  const seq = useRef(0); // 마지막 요청 번호

  useEffect(() => {
    searchRef.current = search;
  });

  const run = useCallback((text: string) => {
    const id = ++seq.current;
    if (!text) {
      setResult({ kind: 'idle' });
      return;
    }
    setResult({ kind: 'loading' });
    Promise.resolve()
      .then(() => searchRef.current(text))
      .then(
        (places) => {
          if (id === seq.current) setResult({ kind: 'done', query: text, places });
        },
        (error: unknown) => {
          if (id === seq.current) setResult({ kind: 'error', query: text, error });
        },
      );
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => run(query), query ? SEARCH_DELAY_MS : 0);
    return () => clearTimeout(timer);
  }, [query, run]);

  // 닫히면 아직 오는 중인 응답은 버림
  useEffect(() => {
    const requests = seq;
    return () => {
      requests.current += 1;
    };
  }, []);

  const retry = useCallback(() => run(query), [run, query]);
  return { result, retry };
}
