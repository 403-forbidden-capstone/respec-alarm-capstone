// 그룹 기상 신호로 화면을 다시 읽기 — 화면이 열려 있는 동안만 그 그룹들의 신호(lib/realtime subscribeGroupWake)를 받음 (G01 · G02 · G03 · H01)
//   · 신호는 "새로 고침"일 뿐이고 내용은 안 담김. 받으면 같은 읽기 함수를 다시 부르되, 신호가 알려 준 날(date)을 get_group_wake_status의 p_date로 넘김 (D57 · D59)
//   · 신호를 놓칠 수 있으니(앱이 뒤에 있는 동안 · 연결이 끊긴 동안) 화면이 앞에 올 때 한 번 읽는 것(useLoad의 포커스 읽기)은 그대로 둠 — 그때는 날짜 없이(오늘) 읽음
//   · 한 사람의 기상 기록이 몇 건 연달아 들어오므로(울림 · 해제 · 확인) 잠깐 모아서 한 번만 다시 읽음
//   · 가짜 모드에서는 구독하지 않음 (웹 미리보기가 없는 서버에 붙지 않게)
import { useEffect, useRef } from 'react';

import { useMode } from '@/lib/mode';
import { subscribeGroupWake } from '@/lib/realtime';
import { useLoad } from '@/lib/useLoad';

export const WAKE_RELOAD_DELAY_MS = 400;

// 그룹들의 신호를 받기 시작 — 돌려주는 함수로 끊음. 신호가 몰리면 마지막 날짜로 한 번만 부름 (시험하기 쉽게 훅 밖에 둠)
export function watchGroupWake(groupIds: readonly string[], onRefresh: (date: string | null) => void, delayMs = WAKE_RELOAD_DELAY_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingDate: string | null = null;
  const stops = groupIds.map((groupId) =>
    subscribeGroupWake(groupId, ({ date }) => {
      pendingDate = date ?? pendingDate; // 날짜 없는 신호가 뒤에 와도 앞의 날짜를 지우지 않음
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const d = pendingDate;
        pendingDate = null;
        onRefresh(d);
      }, delayMs);
    }),
  );
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    stops.forEach((stop) => stop());
  };
}

// useLoad + 기상 신호 — 화면 파일에는 useLoad 자리에 이 한 줄만
//   const { data, error, reload } = useWakeLoad((date) => getGroup(id, date), (g) => [g.id]);
//   load = 읽기 함수 (date = 신호가 알려 준 날, 포커스 읽기는 null). groupIdsOf = 읽은 데이터에서 신호를 받을 그룹들 (읽기 전·null이면 구독 안 함)
export function useWakeLoad<T>(load: (date: string | null) => Promise<T>, groupIdsOf: (data: NonNullable<T>) => readonly string[]) {
  const pendingDate = useRef<string | null>(null);
  // 신호로 부른 읽기 한 번에만 날짜를 쓰고 바로 비움 — 다음 포커스 읽기는 오늘로
  const result = useLoad(() => {
    const date = pendingDate.current;
    pendingDate.current = null;
    return load(date);
  });
  const { data, reload } = result;
  const { mode } = useMode();
  const ids = data == null || mode === 'mock' ? [] : [...groupIdsOf(data as NonNullable<T>)];
  const key = ids.join(',');

  useEffect(() => {
    if (!key) return;
    return watchGroupWake(key.split(','), (date) => {
      pendingDate.current = date;
      void reload();
    });
  }, [key, reload]);

  return result;
}
