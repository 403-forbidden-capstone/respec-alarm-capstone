import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { toast } from '@/components/ui';
import { now } from '@/lib/clock';
import { startOfDay } from '@/lib/format';
import { useAction } from '@/lib/useAction';

import { listDetections, type LocationDetection, type RejectSnapshot } from '../api';
import { eraseDetection, undoErase, UNDO_SECONDS } from '../fix';
import { detectionKey, erasedMessage, restoredMessage, sortDetections } from '../rows';

type Options = {
  reloadOn?: unknown; // 이 값이 바뀌면 다시 읽음 (홈이 다시 읽힐 때)
  onChanged?: () => unknown; // 지우거나 되돌려 홈의 다른 줄(아침 카드 등)도 달라질 때
};

// 홈 감지 정정 줄의 동작 — 오늘 위치로 잡힌 출발 · 도착을 읽고, [아니에요] → 지움 → 토스트 [되돌리기](5초)
//   읽기는 덧붙임 줄이라 못 읽어도 던지지 않음(줄만 없음). 쓰기 실패는 useAction이 토스트로
//   읽는 때: 홈이 앞에 올 때(탭 전환 · 화면 복귀) · 앱이 다시 앞에 올 때 · reloadOn이 바뀔 때 · 정정 뒤
export function useHomeDetections({ reloadOn, onChanged }: Options = {}) {
  const [rows, setRows] = useState<LocationDetection[]>([]);
  const { busy, run } = useAction();
  const latest = useRef(0); // 겹친 읽기 중 가장 나중에 시작한 것만 반영

  const reload = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const list = await listDetections(startOfDay(now()));
      if (mine === latest.current) setRows(sortDetections(list));
    } catch (e) {
      if (__DEV__) console.warn('[location] 홈 감지 줄을 읽지 못함', e);
    }
  }, []);

  const notifyChanged = useCallback(() => {
    void Promise.resolve(onChanged?.()).catch(() => undefined); // 홈의 다른 줄이 못 읽혀도 정정 결과는 그대로
  }, [onChanged]);

  // 홈이 앞에 올 때
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  // reloadOn(홈 데이터)이 바뀔 때 — 처음 그릴 때는 위에서 읽으니 건너뜀
  const seen = useRef(reloadOn);
  useEffect(() => {
    if (seen.current === reloadOn) return;
    seen.current = reloadOn;
    void reload();
  }, [reloadOn, reload]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void reload();
    });
    return () => subscription.remove();
  }, [reload]);

  // 다시 읽기는 run 밖(finally의 void reload) — run이 끝나야 busy가 풀려 토스트의 [되돌리기]가 바로 먹음
  //   서버 쓰기만 성공하고 폰 기억 맞춤이 던져도(부분 실패) finally가 다시 읽어 줄이 서버 상태를 따름
  const undo = useCallback(
    (snapshot: RejectSnapshot) =>
      run(async () => {
        try {
          const ok = await undoErase(snapshot);
          if (!ok) {
            toast('그 사이 다른 기록이 들어와서 되돌리지 못했어요');
            return;
          }
          toast(restoredMessage(snapshot.kind, snapshot.at));
          notifyChanged();
        } finally {
          void reload();
        }
      }, '되돌리지 못했어요. 다시 해 주세요'),
    [run, reload, notifyChanged],
  );

  const reject = useCallback(
    (detection: LocationDetection) =>
      run(async () => {
        try {
          const done = await eraseDetection({ participantId: detection.participantId, kind: detection.kind, at: detection.at.getTime() }, 'H01');
          setRows((prev) => prev.filter((r) => detectionKey(r) !== detectionKey(detection))); // 바로 줄을 뺌 — 다시 읽기를 기다리지 않게
          if (!done) {
            toast('이미 바뀐 기록이에요');
          } else if (done.snapshot) {
            const { snapshot } = done;
            // 토스트 안의 [되돌리기] — 5초 동안 보임
            toast(erasedMessage(done.kind, new Date(done.at)), { actionLabel: '되돌리기', duration: UNDO_SECONDS * 1000, onAction: () => void undo(snapshot) });
          } else {
            toast(erasedMessage(done.kind, new Date(done.at))); // 서버에는 없던 판정 — 되돌릴 값이 없음
          }
          notifyChanged();
        } finally {
          void reload();
        }
      },'정정하지 못했어요. 연결을 확인하고 다시 시도해 주세요.'),
    [run, undo, reload, notifyChanged],
  );

  return { rows, busy, reject };
}
