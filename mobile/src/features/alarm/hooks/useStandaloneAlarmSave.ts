import { useCallback, useState } from 'react';

import { confirm, toast } from '@/components/ui';
import { askNotifications } from '@/features/permissions';
import { now } from '@/lib/clock';
import { formatTime } from '@/lib/format';
import { useAction } from '@/lib/useAction';
import type { Weekday } from '@/lib/weekday';

import { createStandaloneAlarm, deleteStandaloneAlarm, editStandaloneAlarm } from '../api';
import { saveNotice } from '../saveNotice';
import { dayHeading } from '../schedule';
import { firstRingAt } from '../standalone';
import { rruleToRepeat } from '../repeat';
import type { Appointment, Level } from '../types';

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

// 기본 알람 고치기 · 지우기 (H02 알람 카드 · 홈 다음 알람 카드를 누름) — 시트는 고른 값만 넘기고, 저장 · 확인 팝업 · 토스트는 이 훅이 함
//   open(카드의 일정 모양)으로 열고, sheet는 고치기 시트(NewAlarmSheet)에 그대로 넘길 값 (닫혀 있으면 null). 끝나면 onDone으로 다시 읽음
//   켜짐은 고르지 않음 — 꺼 둔 알람을 고쳐도 꺼진 채
export function useStandaloneAlarmEdit(onDone: () => void) {
  const { busy, run } = useAction();
  const [editing, setEditing] = useState<Appointment | null>(null);
  const save = useCallback(
    async (a: Appointment, minuteOfDay: number, repeat: readonly Weekday[], level: Level) => {
      let ok = false;
      await run(async () => {
        const at = firstRingAt(minuteOfDay, repeat, now());
        // 강도는 바꿨을 때만 보냄 — 안 바꿨으면 원래 강도(자동이면 자동)를 그대로 (보내면 직접 고름으로 저장됨)
        const saved = await editStandaloneAlarm(a.id, { at, repeat, level: level === a.level ? undefined : level, enabled: a.enabled });
        toast(saveNotice(saved.followUp, '알람은 고쳤지만') ?? `알람을 고쳤어요 · ${dayHeading(at, now())} ${formatTime(at)}`);
        ok = true;
        onDone();
      }, '알람을 고치지 못했어요');
      return ok;
    },
    [run, onDone],
  );
  const remove = useCallback(
    async (a: Appointment) => {
      const sure = await confirm({
        title: '알람을 삭제할까요?',
        message: a.recurrenceRule ? '반복되는 모든 회차가 함께 지워지고 다시 울리지 않아요.' : '지운 알람은 다시 울리지 않아요.',
        okLabel: '삭제',
        destructive: true,
      });
      if (!sure) return false;
      let ok = false;
      await run(async () => {
        const phoneFailed = await deleteStandaloneAlarm(a.id);
        toast(phoneFailed ? '알람은 지웠지만 폰 예약을 다 지우지 못했어요. 앱을 다시 열면 정리돼요' : '알람을 삭제했어요');
        ok = true;
        onDone();
      }, '알람을 삭제하지 못했어요');
      return ok;
    },
    [run, onDone],
  );
  const sheet = editing && {
    visible: true,
    busy,
    onClose: () => setEditing(null),
    editing: { at: editing.alarms[0]?.at ?? editing.at, repeat: rruleToRepeat(editing.recurrenceRule), level: editing.level },
    onSave: (minute: number, repeat: readonly Weekday[], level: Level) => save(editing, minute, repeat, level),
    onDelete: () => remove(editing),
  };
  return { open: setEditing, sheet, id: editing?.id }; // id = 시트의 key — 알람이 바뀌면 입력을 새로 채움 (key는 펼쳐 넘기면 React가 경고)
}
