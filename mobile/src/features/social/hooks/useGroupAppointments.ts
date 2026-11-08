import { useState } from 'react';

import { confirm, toast } from '@/components/ui';
import { getJoinDefaults, joinSharedAppointment, leaveSharedAppointment } from '@/features/alarm/api';
import type { JoinChoice, JoinDefaults } from '@/features/alarm/types';
import { userMessage } from '@/lib/errors';
import { useAction } from '@/lib/useAction';

import { getAppointmentJoiners } from '../api';
import { JOINED_TOAST, LEFT_APPOINTMENT_TOAST, leaveAppointmentText } from '../groupTexts';
import type { AppointmentJoiner, GroupAppointment } from '../types';

// G02 연결 일정 (친구 9장) — [내 알람 만들기] 시트 · 참여자 시트 · [나는 빠지기]. 시트는 값 · 콜백만 받음 (그리기는 루트 SheetHost)
//   시트 열 때의 읽기(기본값 · 참여자)는 쓰기 버튼의 한 번에 하나 가드(run)와 따로 — 가드에 막혀 버려지면 시트가 로딩에 머묾
//   확인 창은 가드 밖에서 — 확인 대기 중에는 busy가 켜지지 않음
//   onChanged = 쓴 뒤 G02를 다시 읽음 (인원수 · 내 참여)
export function useGroupAppointments(onChanged: () => void) {
  const [joinFor, setJoinFor] = useState<GroupAppointment | null>(null);
  const [defaults, setDefaults] = useState<JoinDefaults | null>(null);
  const [joinersFor, setJoinersFor] = useState<GroupAppointment | null>(null);
  const [joiners, setJoiners] = useState<AppointmentJoiner[] | null>(null);
  const { busy, run } = useAction();

  const openJoin = async (a: GroupAppointment) => {
    setJoinersFor(null);
    setJoinFor(a);
    setDefaults(null);
    try {
      setDefaults(await getJoinDefaults());
    } catch (e) {
      setJoinFor(null);
      toast(userMessage(e, '기본값을 불러오지 못했어요'));
    }
  };

  // 실패(오프라인 · 지난 약속)면 시트를 열어 둔 채 토스트 — 다시 누르면 같은 요청이라 서버엔 내 참여 한 줄 (9-35)
  const join = (choice: JoinChoice) =>
    run(async () => {
      if (!joinFor) return;
      const result = await joinSharedAppointment(joinFor.id, choice);
      setJoinFor(null);
      toast(result.phoneFailed ? `${JOINED_TOAST}. 폰에 못 건 알람은 앱을 다시 열면 걸어요` : JOINED_TOAST);
      onChanged();
    }, '내 알람을 만들지 못했어요. 다시 해 주세요');

  const openJoiners = async (a: GroupAppointment) => {
    setJoinersFor(a);
    setJoiners(null);
    try {
      setJoiners(await getAppointmentJoiners(a.id));
    } catch (e) {
      setJoinersFor(null);
      toast(userMessage(e, '참여자를 불러오지 못했어요'));
    }
  };

  // [나는 빠지기] — 내 알람만 지움, 알림 없음 (9-21)
  const leave = async (a: GroupAppointment) => {
    setJoinersFor(null);
    const t = leaveAppointmentText(a.title);
    if (!(await confirm({ title: t.title, message: t.body, okLabel: t.ok, destructive: true }))) return;
    await run(async () => {
      await leaveSharedAppointment(a.id);
      toast(LEFT_APPOINTMENT_TOAST);
      onChanged();
    }, '빠지지 못했어요. 다시 해 주세요');
  };

  return {
    busy,
    openJoin,
    openJoiners,
    leave,
    joinProps: { appointment: joinFor, defaults, busy, onJoin: join, onClose: () => setJoinFor(null) },
    joinersProps: {
      appointment: joinersFor,
      joiners,
      onClose: () => setJoinersFor(null),
      onJoin: openJoin,
      onLeave: leave,
    },
  };
}
