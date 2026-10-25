import { useCallback } from 'react';

import { confirm, toast } from '@/components/ui';
import { useAction } from '@/lib/useAction';

import { setAppointmentEnabled } from '../api';
import type { Appointment } from '../types';

type Run = ReturnType<typeof useAction>['run'];

// 일정 알람 켜기 · 끄기 (홈 · 알람 목록의 알람 카드) — 카드는 스위치만 그리고, 저장은 화면이 이 훅으로 함
//   · 공유(그룹) 일정은 끄기 전에 범위를 알려 줌 — 내 알람만 꺼지고 일정 · 다른 사람의 알람은 그대로
//   · 실패해도(네트워크 · 폰에 못 걺) 끝나면 onChanged로 다시 읽어 스위치가 실제 상태와 어긋나지 않게 함
//   · 쓰기는 화면에 하나 — 저장이 도는 동안 다른 카드 스위치를 눌러도 무시하고, 끝난 뒤 다시 읽은 값으로 돌아감
export function useAppointmentToggle(onChanged: () => void) {
  const { run } = useAction();
  return useCallback((a: Appointment, next: boolean) => toggleAppointment(a, next, run, onChanged), [run, onChanged]);
}

// 훅 본체 — 훅 없이 시험하려고 뺌 (__tests__/useAppointmentToggle.test.ts). run = lib/useAction의 run
export async function toggleAppointment(a: Appointment, next: boolean, run: Run, onChanged: () => void) {
  if (!next && a.groupName) {
    const ok = await confirm({
      title: `${a.title} 알람을 끌까요?`,
      message: `내 알람만 꺼지고 ${a.groupName} 일정은 그대로예요.`,
      okLabel: '끄기',
    });
    if (!ok) return;
  }
  await run(async () => {
    await setAppointmentEnabled(a.id, next);
    toast(next ? '이 일정의 알람을 켰어요' : '이 일정의 알람을 껐어요');
  }, '알람을 켜고 끄지 못했어요');
  onChanged();
}
