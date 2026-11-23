import { useCallback } from 'react';

import { toast } from '@/components/ui';
import { askNotifications } from '@/features/permissions';
import { now } from '@/lib/clock';
import { formatTime } from '@/lib/format';
import { useAction } from '@/lib/useAction';
import type { Weekday } from '@/lib/weekday';

import { createStandaloneAlarm } from '../api';
import { saveNotice } from '../saveNotice';
import { dayHeading } from '../schedule';
import { firstRingAt } from '../standalone';

// 기본 알람 저장 (H02 알람 탭 "+ 새 알람", #588) — 부품(NewAlarmSheet)은 고른 값만 넘기고, 저장 · 토스트 · 알림 권한은 화면이 이 훅으로 함
//   save는 저장했으면 true — 부품이 시트를 닫고 입력을 비울지 정함. 실패는 useAction 규칙대로 토스트
export function useStandaloneAlarmSave(onSaved: (id: string) => void) {
  const { busy, run } = useAction();
  const save = useCallback(
    async (minuteOfDay: number, repeat: readonly Weekday[]) => {
      let ok = false;
      await run(async () => {
        await saveStandaloneAlarm(minuteOfDay, repeat, onSaved);
        ok = true;
      }, '알람을 저장하지 못했어요');
      return ok;
    },
    [run, onSaved],
  );
  return { busy, save };
}

// 훅 본체 — 훅 없이 시험하려고 뺌 (__tests__/useStandaloneAlarmSave.test.ts)
//   첫 회차는 저장 순간의 지금으로 다시 계산 (화면의 지금은 30초 늦을 수 있음)
export async function saveStandaloneAlarm(minuteOfDay: number, repeat: readonly Weekday[], onSaved: (id: string) => void) {
  const at = firstRingAt(minuteOfDay, repeat, now());
  const saved = await createStandaloneAlarm({ at, repeat });
  toast(saveNotice(saved.followUp, '알람은 저장했지만') ?? `알람을 만들었어요 · ${dayHeading(at, now())} ${formatTime(at)}`);
  void askNotifications('alarm');
  onSaved(saved.id);
}
