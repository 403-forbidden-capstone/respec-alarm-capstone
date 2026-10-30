import { useCallback, useEffect, useRef, useState } from 'react';

import { toast } from '@/components/ui';
import { userMessage } from '@/lib/errors';
import { useAction } from '@/lib/useAction';

import type { DetectionKind, RejectSnapshot } from '../api';
import { eraseDetection, undoErase, UNDO_SECONDS } from '../fix';
import type { DetectionLink } from '../link';

// 감지 안내 알림을 눌러 연 정정 화면의 동작 — 열자마자 지우고(rejectDetection), 5초 안에는 되돌릴 수 있음 (L6 안건후보: 감지 안내 정정 · 채널 기본안)
//   erased   지웠음. undoable = 서버 값을 지웠고 5초가 안 지났음. 5초가 지나면 undoable만 꺼지고 "지웠어요"는 그대로
//   gone     지울 위치 값이 없음 — 이미 원탭 · 직접 입력으로 바뀌었거나 이미 지움
//   undone   되돌렸음
export { UNDO_SECONDS };

export type FixPhase =
  | { name: 'working' }
  | { name: 'erased'; kind: DetectionKind; at: Date; undoable: boolean; secondsLeft: number }
  | { name: 'gone' }
  | { name: 'undone'; kind: DetectionKind; at: Date }
  | { name: 'failed'; message: string };

type Erased = { snapshot: RejectSnapshot | null; kind: DetectionKind; at: number };

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
          // 순서(서버 값 지우기 → 폰 기억 맞춤 → 폰 예약 다시 맞춤)는 홈 감지 정정 줄과 같이 fix.ts에
          const done = await eraseDetection(target, 'NTF');
          if (!done) {
            setPhase({ name: 'gone' });
            return;
          }
          erased.current = { snapshot: done.snapshot, kind: done.kind, at: done.at };
          setPhase({ name: 'erased', kind: done.kind, at: new Date(done.at), undoable: done.snapshot != null, secondsLeft: UNDO_SECONDS });
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
        const ok = await undoErase(done.snapshot);
        if (!ok) {
          // 그 사이 다른 값(원탭 등)이 들어왔거나 이미 되돌림 — 덮어쓰지 않음
          toast('그 사이 다른 기록이 들어와서 되돌리지 못했어요');
          setPhase({ name: 'erased', kind: done.kind, at: new Date(done.at), undoable: false, secondsLeft: 0 });
          return;
        }
        erased.current = null;
        setPhase({ name: 'undone', kind: done.kind, at: new Date(done.at) });
      }, '되돌리지 못했어요. 다시 해 주세요'),
    [run],
  );

  const retry = useCallback(() => {
    if (link) void fix(link);
  }, [fix, link]);

  return { phase, busy, undo, retry };
}
