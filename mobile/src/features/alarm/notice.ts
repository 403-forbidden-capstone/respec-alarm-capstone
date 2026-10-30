// 준비 · 출발 알림 문구 (이슈 #230 PR 1a → 1b) — 폰 알림에 뜨는 한 줄을 웹 미리 보기(H07)에도 같은 글자로
//   글자는 서버 알림 문구 함수(_shared/ring-package.ts)를 그대로 불러 만듦 — 서버 alarm-commit · 앱 reconcile과 같은 함수라 한쪽만 고쳐 갈라질 일이 없음
//   서버 조건도 같음: 준비는 같은 약속의 켜진 출발 알람이 있어야 하고, 출발은 이동분이 있어야 함. 기상 · 도착은 문구 없음(기본 머리글)
import { departureNotice, prepareNotice } from '@shared/ring-package.ts';

import type { Appointment, RingKind } from './types';

// 알림 시각 글자의 시간대 — lib/format과 같은 한국 시간 (lib/alarmSync reconcile DEFAULT_TIME_ZONE과 같은 값)
export const NOTICE_TIME_ZONE = 'Asia/Seoul';

// at = 이 알람이 울리는 시각. 문구가 없으면 undefined
export function ringNotice(appointment: Appointment, kind: RingKind, at: Date): string | undefined {
  try {
    if (kind === 'PREPARE') {
      const depart = appointment.alarms.find((x) => x.kind === 'DEPARTURE' && x.enabled);
      return depart ? prepareNotice({ prepareAt: at, departAt: depart.at, timeZone: NOTICE_TIME_ZONE }) : undefined;
    }
    if (kind === 'DEPARTURE') {
      return departureNotice({ departAt: at, appointmentAt: appointment.at, travelMinutes: appointment.travelMinutes, timeZone: NOTICE_TIME_ZONE });
    }
  } catch {
    // 문구는 덧붙임일 뿐 — 서식이 안 되면 기본 머리글 (서버 tryText와 같은 방침)
  }
  return undefined;
}
