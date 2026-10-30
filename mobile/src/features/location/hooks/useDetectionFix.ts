import { useCallback, useEffect, useRef, useState } from 'react';

import { toast } from '@/components/ui';
import { syncNow } from '@/lib/alarmSync';
import { userMessage } from '@/lib/errors';
import { useAction } from '@/lib/useAction';

import { rejectDetection, undoReject, type DetectionKind, type RejectSnapshot } from '../api';
import { forgetGeoDetection, restoreGeoDetection } from '../correct';
import type { DetectionLink } from '../link';
import { syncLocation } from '../register';

// 감지 안내 알림을 눌러 연 정정 화면의 동작 — 열자마자 지우고(rejectDetection), 5초 안에는 되돌릴 수 있음 (L6 안건후보: 감지 안내 정정 · 채널 기본안)
//   erased   지웠음. undoable = 서버 값을 지웠고 5초가 안 지났음. 5초가 지나면 undoable만 꺼지고 "지웠어요"는 그대로
//   gone     지울 위치 값이 없음 — 이미 원탭 · 직접 입력으로 바뀌었거나 이미 지움
//   undone   되돌렸음
export const UNDO_SECONDS = 5;

export type FixPhase =
  | { name: 'working' }
  | { name: 'erased'; kind: DetectionKind; at: Date; undoable: boolean; secondsLeft: number }
  | { name: 'gone' }
  | { name: 'undone'; kind: DetectionKind; at: Date }
  | { name: 'failed'; message: string };

type Erased = { snapshot: RejectSnapshot | null; kind: DetectionKind; at: number };

// 지운 뒤 · 되돌린 뒤 — 폰 예약(원탭 알림)과 감시 계획을 다시 맞춤. 기다리지 않고, 실패해도 정정은 그대로 (둘 다 던지지 않음)
function resync() {
  void syncNow();
  void syncLocation({ ignoreThrottle: true });
}

// link = 알림 주소에서 읽은 값 (모양이 틀리면 null이고 아무것도 안 함)
export function useDetectionFix(link: DetectionLink | null) {
  const [phase, setPhase] = useState<FixPhase>({ name: 'working' });
  const { busy, run } = useAction();
  const erased = useRef<Erased | null>(null);
  const startedKey = useRef<string | null>(null);
  const key = link ? `${link.kind}:${link.participantId}:${link.at}` : null;

  const fix = useCallback(
    (target: DetectionLink) =>
      run(async () => {
        setPhase({ name: 'working' });
        try {
          const snapshot = await rejectDetection({ participantId: target.participantId, kind: target.kind, screen: 'NTF', at: target.at });
          // 서버에서 지운 값의 시각 기준으로 폰 기억도 맞춤 (서버 값이 없거나 알림의 시각과 달라 못 지웠으면 같은 시각(target.at)으로 — 5분 대기 중이던 출발 등 폰에만 있는 판정을 찾아 잊음)
          const at = snapshot ? snapshot.at.getTime() : target.at;
          const forgot = await forgetGeoDetection({ participantId: target.participantId, kind: target.kind, at }, { voidAlways: snapshot != null });
          if (!snapshot && !forgot) {
            setPhase({ name: 'gone' });
            return;
          }
          erased.current = { snapshot, kind: target.kind, at };
          setPhase({ name: 'erased', kind: target.kind, at: new Date(at), undoable: snapshot != null, secondsLeft: UNDO_SECONDS });
          resync();
        } catch (e) {
          setPhase({ name: 'failed', message: userMessage(e, '정정하지 못했어요. 연결을 확인하고 다시 시도해 주세요.') });
        }
      }),
    [run],
  );

  // 열자마자 한 번 — 같은 알림 주소로 다시 그려져도 두 번 지우지 않음
  useEffect(() => {
    if (!link || startedKey.current === key) return;
    startedKey.current = key;
    void fix(link);
  }, [fix, key, link]);

  // 5초 카운트다운 — 1초마다 줄이고 0이 되면 되돌리기만 사라짐
  const counting = phase.name === 'erased' && phase.undoable;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => {
      setPhase((p) => {
        if (p.name !== 'erased' || !p.undoable) return p;
        const secondsLeft = p.secondsLeft - 1;
        return secondsLeft > 0 ? { ...p, secondsLeft } : { ...p, undoable: false, secondsLeft: 0 };
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [counting]);

  const undo = useCallback(
    () =>
      run(async () => {
        const done = erased.current;
        if (!done?.snapshot) return;
        const ok = await undoReject(done.snapshot);
        if (!ok) {
          // 그 사이 다른 값(원탭 등)이 들어왔거나 이미 되돌림 — 덮어쓰지 않음
          toast('그 사이 다른 기록이 들어와서 되돌리지 못했어요');
          setPhase({ name: 'erased', kind: done.kind, at: new Date(done.at), undoable: false, secondsLeft: 0 });
          return;
        }
        await restoreGeoDetection({ participantId: done.snapshot.participantId, kind: done.kind, at: done.at });
        erased.current = null;
        setPhase({ name: 'undone', kind: done.kind, at: new Date(done.at) });
        resync(); // 돌아온 값을 계획이 다시 읽도록 — restoreGeoDetection 주석
      }, '되돌리지 못했어요. 다시 해 주세요'),
    [run],
  );

  const retry = useCallback(() => {
    if (link) void fix(link);
  }, [fix, link]);

  return { phase, busy, undo, retry };
}
