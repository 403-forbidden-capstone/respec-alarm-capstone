import { useCallback, useRef } from 'react';

import { confirm, toast } from '@/components/ui';
import { userMessage } from '@/lib/errors';

import { setAppointmentEnabled } from '../api';
import type { Appointment } from '../types';

// 일정 알람 켜기 · 끄기 (홈 · 알람 목록의 알람 카드) — 카드는 스위치만 그리고, 저장은 화면이 이 훅으로 함
//   · 공유(그룹) 일정은 끄기 전에 범위를 알려 줌 — 내 알람만 꺼지고 일정 · 다른 사람의 알람은 그대로
//   · 실패해도(네트워크 · 폰에 못 걺) 끝나면 onChanged로 다시 읽어 스위치가 실제 상태와 어긋나지 않게 함
//   · 연타는 카드(일정)마다 따로 막음 — lib/useAction과 같은 규칙(도는 동안 다시 누르면 무시, 실패하면 토스트)을 일정 id별로.
//     화면에 useAction 하나를 쓰면 한 카드를 저장하는 동안 다른 카드 스위치까지 표시 없이 무시됨
export function useAppointmentToggle(onChanged: () => void) {
  const saving = useRef(new Set<string>());
  return useCallback((a: Appointment, next: boolean) => toggleAppointment(a, next, saving.current, onChanged), [onChanged]);
}

// 훅 본체 — 훅 없이 시험하려고 뺌 (__tests__/useAppointmentToggle.test.ts). saving = 저장 중인 일정 id
export async function toggleAppointment(a: Appointment, next: boolean, saving: Set<string>, onChanged: () => void) {
  if (!next && a.groupName) {
    const ok = await confirm({
      title: `${a.title} 알람을 끌까요?`,
      message: `내 알람만 꺼지고 ${a.groupName} 일정은 그대로예요.`,
      okLabel: '끄기',
    });
    if (!ok) return;
  }
  if (!saving.has(a.id)) {
    saving.add(a.id);
    try {
      await setAppointmentEnabled(a.id, next);
      toast(next ? '이 일정의 알람을 켰어요' : '이 일정의 알람을 껐어요');
    } catch (e) {
      // 서버 · DB 오류 원문은 보여 주지 않음 — 이유는 api.ts가 UserError로 던짐 (lib/useAction과 같음)
      toast(userMessage(e, '알람을 켜고 끄지 못했어요'));
    } finally {
      saving.delete(a.id);
    }
  }
  onChanged();
}
