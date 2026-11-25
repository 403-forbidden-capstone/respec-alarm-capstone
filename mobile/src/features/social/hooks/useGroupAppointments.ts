import { router } from 'expo-router';
import { useRef, useState } from 'react';

import { confirm, toast } from '@/components/ui';
import { getJoinDefaults, joinSharedAppointment, leaveSharedAppointment } from '@/features/alarm/api';
import { travelConfirmMessage, TravelConfirmNeeded, TRAVEL_CONFIRM_OK } from '@/features/alarm/travelConfirm';
import type { JoinChoice, JoinDefaults } from '@/features/alarm/types';
import { userMessage } from '@/lib/errors';
import { useAction } from '@/lib/useAction';

import { getAppointmentJoiners } from '../api';
import { HOME_MISSING_JOIN_ACTION, HOME_MISSING_JOIN_TOAST, joinedToastText, LEFT_APPOINTMENT_TOAST, leaveAppointmentText } from '../groupTexts';
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
  // 시트를 닫고 다른 약속을 연 뒤 늦게 온 앞 약속의 응답 · 실패가 새 시트를 덮거나 닫지 않게 — 마지막으로 연 약속만 반영
  const joinTarget = useRef<string | null>(null);
  const joinersTarget = useRef<string | null>(null);

  const openJoin = async (a: GroupAppointment) => {
    setJoinersFor(null);
    joinersTarget.current = null;
    joinTarget.current = a.id;
    setJoinFor(a);
    setDefaults(null);
    try {
      const loaded = await getJoinDefaults();
      if (joinTarget.current === a.id) setDefaults(loaded);
    } catch (e) {
      if (joinTarget.current !== a.id) return;
      joinTarget.current = null;
      setJoinFor(null);
      toast(userMessage(e, '기본값을 불러오지 못했어요'));
    }
  };

  // 실패(오프라인 · 지난 약속)면 시트를 열어 둔 채 토스트 — 다시 누르면 같은 요청이라 서버엔 내 참여 한 줄 (9-35)
  //   길찾기를 못 하면(어림 이동시간) 확인 창 — 확인하면 그 분을 직접 정한 값(MANUAL)으로 다시 보냄 (9-어, H03 저장과 같은 길). 확인 창은 가드 밖에서
  const join = async (choice: JoinChoice) => {
    const target = joinFor;
    if (!target) return;
    // 집 위치가 없으면 서버는 이동시간을 못 구해 '잠시 뒤 다시' 문구로 끝남 — 보내기 전에 이유와 설정 바로 가기를 알림 (탐색 시험 · 카카오 키 없는 로컬에서 확인)
    if (defaults && defaults.homeName == null) {
      toast(HOME_MISSING_JOIN_TOAST, {
        actionLabel: HOME_MISSING_JOIN_ACTION,
        onAction: () => {
          // 토스트가 떠 있는 사이 다른 약속 시트를 열었다면 그 시트는 닫지 않음
          if (joinTarget.current === target.id) {
            joinTarget.current = null;
            setJoinFor(null);
          }
          router.push('/settings');
        },
      });
      return;
    }
    let ask: TravelConfirmNeeded | null = null;
    await run(async () => {
      try {
        await finishJoin(target.id, choice);
      } catch (e) {
        if (!(e instanceof TravelConfirmNeeded)) throw e;
        ask = e;
      }
    }, '내 알람을 만들지 못했어요. 다시 해 주세요');
    const fallback = ask as TravelConfirmNeeded | null;
    if (!fallback) return;
    const ok = await confirm({ title: '이동시간을 확인해 주세요', message: travelConfirmMessage(fallback), okLabel: TRAVEL_CONFIRM_OK });
    if (!ok) return;
    await run(() => finishJoin(target.id, { ...choice, travelMinutes: fallback.minutes }), '내 알람을 만들지 못했어요. 다시 해 주세요');
  };

  const finishJoin = async (appointmentId: string, choice: JoinChoice) => {
    const result = await joinSharedAppointment(appointmentId, choice);
    if (joinTarget.current === appointmentId) {
      joinTarget.current = null;
      setJoinFor(null);
    }
    const done = joinedToastText(result as typeof result & { wakeAt?: Date; departAt?: Date }); // 실데이터는 만든 기상 · 출발 시각이 같이 옴(JoinResult 타입은 alarm/types.ts라 여기서 넓힘)
    toast(result.phoneFailed ? `${done}. 폰에 못 건 알람은 앱을 다시 열면 걸어요` : done);
    onChanged();
  };

  const openJoiners = async (a: GroupAppointment) => {
    joinersTarget.current = a.id;
    setJoinersFor(a);
    setJoiners(null);
    try {
      const loaded = await getAppointmentJoiners(a.id);
      if (joinersTarget.current === a.id) setJoiners(loaded);
    } catch (e) {
      if (joinersTarget.current !== a.id) return;
      joinersTarget.current = null;
      setJoinersFor(null);
      toast(userMessage(e, '참여자를 불러오지 못했어요'));
    }
  };

  // [나는 빠지기] — 내 알람만 지움, 알림 없음 (9-21)
  const leave = async (a: GroupAppointment) => {
    joinersTarget.current = null;
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
    joinProps: { appointment: joinFor, defaults, busy, onJoin: join, onClose: () => {
        joinTarget.current = null;
        setJoinFor(null);
      },
    },
    joinersProps: {
      appointment: joinersFor,
      joiners,
      onClose: () => {
        joinersTarget.current = null;
        setJoinersFor(null);
      },
      onJoin: openJoin,
      onLeave: leave,
    },
  };
}
