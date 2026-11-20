// 그룹 기상 신호로 화면을 다시 읽기 — 화면이 열려 있는 동안만 그 그룹들의 신호(lib/realtime subscribeGroupWake)를 받음 (G01 · G02 · G03 · H01)
//   · 신호는 "새로 고침"일 뿐이고 내용은 안 담김. 받으면 같은 읽기 함수를 다시 부르되, 신호가 알려 준 날(date)을 get_group_wake의 p_date로 넘김 (D57 · D59)
//   · 신호를 놓칠 수 있으니(앱이 뒤에 있는 동안 · 연결이 끊긴 동안) 화면이 앞에 올 때(포커스 · 앱이 앞으로) · 실시간이 다시 연결될 때 날짜 없이(오늘) 다시 읽음 (7-30 · 7-버)
//   · 다시 읽기가 실패했거나 실시간이 끊겨 있으면 stale — 화면이 '연결이 끊겨 최신 상태가 아닐 수 있어요'를 띄움 (7-36)
//   · 한 사람의 기상 기록이 몇 건 연달아 들어오므로(울림 · 해제 · 확인) 잠깐 모아서 한 번만 다시 읽음
//   · 신호 뒤 3초 뒤에 한 번 더 읽음 — 약속 시각 변경 · 취소는 약속 행이 먼저 바뀌고 알람 재계산이 따로 와서, 신호 직후엔 새 약속 시각 + 옛 준비 알람 시각이 보일 수 있음.
//     신호가 연달아 오면 뒤 읽기는 하나로 묶고, 화면을 떠나면 타이머를 정리
//   · 자동 판정 기상은 20분 뒤부터 다른 사람에게 보이는데 그때 신호는 없음 — 화면을 다시 열 때 읽힘
//   · 신호를 받으면 폰 알람도 맞춤(afterEvent, 1분에 한 번까지) — 그룹이 바뀐 신호(약속 변경 · 취소 · 나가기 · 빠지기 · 내보내짐)를 앱이 앞에 있는 채로 받아도 나간 그룹 약속의 알람이 폰에 남지 않게 (G4)
//     신호에는 종류가 없어(날짜뿐) 기상 기록 신호를 포함한 모든 그룹 신호에서 돎 — 그래서 1분 제한을 둠. 제한에 걸려 건너뛴 신호의 맞추기는 다음에 앞에 올 때 함
//   · 가짜 모드에서는 구독하지 않음 (웹 미리보기가 없는 서버에 붙지 않게)
import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { afterEvent } from '@/lib/alarmSync';
import { useMode } from '@/lib/mode';
import { subscribeGroupWake, type SubscribeStatus } from '@/lib/realtime';
import { useLoad } from '@/lib/useLoad';

export const WAKE_RELOAD_DELAY_MS = 400;
export const WAKE_RELOAD_AGAIN_MS = 3000; // 신호로 읽은 뒤 한 번 더 읽는 시간
const SIGNAL_SYNC_THROTTLE_MS = 60_000; // 신호가 연달아 와도 폰 알람 맞추기는 이 시간에 한 번 (근거 없음 — 작성자 판단)

type WatchOptions = {
  delayMs?: number;
  againMs?: number;
  onLink?: (up: boolean) => void; // 실시간 연결 상태 — 모든 그룹이 연결돼 있으면 true, 하나라도 끊기면 false
  onSignal?: () => void; // 신호를 받을 때마다 (다시 연결해서 읽는 것은 아님) — 화면 읽기와 별개로 하는 일
};

// 그룹들의 신호를 받기 시작 — 돌려주는 함수로 끊음. 신호가 몰리면 마지막 날짜로 한 번만 부름 (시험하기 쉽게 훅 밖에 둠)
//   끊겼던 채널이 다시 연결되면 그 사이 놓친 신호 대신 한 번 다시 읽음(날짜 없이). 처음 연결은 이미 읽은 뒤라 안 읽음
export function watchGroupWake(groupIds: readonly string[], onRefresh: (date: string | null) => void, options: WatchOptions = {}): () => void {
  const { delayMs = WAKE_RELOAD_DELAY_MS, againMs = WAKE_RELOAD_AGAIN_MS, onLink, onSignal } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let againTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingDate: string | null = null;
  const down = new Set<string>();
  // again = 신호로 읽은 뒤 한 번 더 읽을지 (재연결 읽기는 안 함)
  const schedule = (date: string | null, again = false) => {
    pendingDate = date ?? pendingDate; // 날짜 없는 신호가 뒤에 와도 앞의 날짜를 지우지 않음
    if (timer) clearTimeout(timer);
    if (again && againTimer) {
      clearTimeout(againTimer); // 새 신호가 오면 기다리던 뒤 읽기는 접고, 이번 읽기 뒤에 하나로 다시 잡음
      againTimer = null;
    }
    timer = setTimeout(() => {
      timer = null;
      const d = pendingDate;
      pendingDate = null;
      onRefresh(d);
      if (again) {
        if (againTimer) clearTimeout(againTimer);
        againTimer = setTimeout(() => {
          againTimer = null;
          onRefresh(d);
        }, againMs);
      }
    }, delayMs);
  };
  const onStatus = (groupId: string) => (status: SubscribeStatus) => {
    if (status === 'SUBSCRIBED') {
      if (!down.delete(groupId)) return; // 처음 연결
      schedule(null);
    } else {
      down.add(groupId);
    }
    onLink?.(down.size === 0);
  };
  const stops = groupIds.map((groupId) => subscribeGroupWake(
      groupId,
      ({ date }) => {
        schedule(date, true);
        onSignal?.();
      },
      onStatus(groupId),
    ));
  return () => {
    if (timer) clearTimeout(timer);
    if (againTimer) clearTimeout(againTimer);
    timer = null;
    againTimer = null;
    stops.forEach((stop) => stop());
  };
}

// 앱이 뒤에 있다(background · inactive) 앞으로 오면 부름 — 포커스 읽기(useLoad)는 화면 이동만 잡아서 따로 둠
//   화면이 열려 있을 때 붙이므로 처음은 앞에 있는 것으로 봄
export function watchForeground(onActive: () => void): () => void {
  let last: AppStateStatus = 'active';
  const sub = AppState.addEventListener('change', (next) => {
    if (next === 'active' && last !== 'active') onActive();
    last = next;
  });
  return () => sub.remove();
}

// 옛 값을 최신처럼 보이면 안 되는 때 — 값은 있는데 다시 읽기가 실패했거나 실시간이 끊김 (값이 없으면 오류 화면이 따로)
export const isWakeStale = ({ hasData, error, linkUp }: { hasData: boolean; error: Error | null; linkUp: boolean }) => hasData && (error != null || !linkUp);

// useLoad + 기상 신호 — 화면 파일에는 useLoad 자리에 이 한 줄만
//   const { data, error, reload, stale } = useWakeLoad((date) => getGroup(id, date), (g) => [g.id]);
//   load = 읽기 함수 (date = 신호가 알려 준 날, 포커스 읽기는 null). groupIdsOf = 읽은 데이터에서 신호를 받을 그룹들 (읽기 전·null이면 구독 안 함)
export function useWakeLoad<T>(load: (date: string | null) => Promise<T>, groupIdsOf: (data: NonNullable<T>) => readonly string[]) {
  const pendingDate = useRef<string | null>(null);
  const [linkUp, setLinkUp] = useState(true);
  // 신호로 부른 읽기 한 번에만 날짜를 쓰고 바로 비움 — 다음 포커스 읽기는 오늘로
  const result = useLoad(() => {
    const date = pendingDate.current;
    pendingDate.current = null;
    return load(date);
  });
  const { data, error, reload } = result;
  const { mode } = useMode();
  const ids = data == null || mode === 'mock' ? [] : [...groupIdsOf(data as NonNullable<T>)];
  const key = ids.join(',');

  useEffect(() => {
    if (!key) return;
    const stop = watchGroupWake(
      key.split(','),
      (date) => {
        pendingDate.current = date;
        void reload();
      },
      { onLink: setLinkUp, onSignal: () => void afterEvent({ throttleMs: SIGNAL_SYNC_THROTTLE_MS }) },
    );
    return () => {
      stop();
      setLinkUp(true);
    };
  }, [key, reload]);

  // 앱이 앞에 오면 오늘 것을 다시 (가짜 모드도 — 시나리오 시각이 흘렀을 수 있음)
  useEffect(() => watchForeground(() => void reload()), [reload]);

  return { ...result, stale: isWakeStale({ hasData: data != null, error, linkUp }) };
}
