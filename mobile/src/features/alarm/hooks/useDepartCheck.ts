import { useCallback, useState } from 'react';

import { useAction } from '@/lib/useAction';

import { checkDepartNow } from '../api';
import type { DepartCheck } from '../types';

// 홈 아침 카드의 [다시 확인] — "지금 나가면"을 새 이동시간으로 다시 셈 (저장하지 않음, 화면 상태로만 들고 있음)
// 쓰기는 아니지만 실데이터는 길찾기를 불러서 느릴 수 있어 두 번 누름 막기 · 실패 토스트는 useAction 관례를 따름
// 다른 일정(appointmentId가 바뀜)의 결과는 보이지 않게 일정 id와 같이 들고 있음
export function useDepartCheck(appointmentId: string | undefined) {
  const { busy, run } = useAction();
  const [last, setLast] = useState<{ id: string; check: DepartCheck } | null>(null);

  const recheck = useCallback(async () => {
    if (!appointmentId) return;
    await run(async () => {
      setLast({ id: appointmentId, check: await checkDepartNow(appointmentId) });
    }, '지금 나가면 어떤지 확인하지 못했어요');
  }, [appointmentId, run]);

  return { check: last && last.id === appointmentId ? last.check : null, busy, recheck };
}
