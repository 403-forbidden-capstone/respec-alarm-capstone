import { useEffect } from 'react';

import { onEventsUploaded } from '@/lib/alarmSync';
import { onSignOut } from '@/lib/session';

import { followUpOneTap } from '../oneTap';
import { followUpPrepareStart } from '../prepareStart';
import { resetAlarmMemory } from '../reset';

// 알람 기능이 앱 전체에 거는 훅 — 앱 시작 때 한 번 (루트 레이아웃)
//   · 원탭 뒤처리(출발 · 도착 시각과 지각)를 울림 기록 올리기 훅에 등록
//   · 준비 시작 기록(준비 알람을 끈 시각 → 참여 조건의 준비 시작, 안건 D111 3번)도 같은 훅에 등록
//   · 로그아웃 때 알람 기능의 메모리(장소 좌표 · 읽어 둔 설정 · 저장 대기 기록)를 비우도록 등록 — 다음 계정에 안 섞이게
// 루트 레이아웃에서 useAlarmSync보다 먼저(같은 컴포넌트에서 위에) 불러야 함: 효과는 선언 순서대로 돌아서, 앱을 열자마자 올리는 기록(꺼져 있을 때 누른 원탭)이
// 훅이 등록되기 전에 올라가 뒤처리 없이 폰에서 지워지는 일이 없음. 가짜 데이터 모드에서는 올리는 일이 없어 원탭 훅도 안 불림
export function useOneTapFollowUp() {
  useEffect(() => onEventsUploaded(followUpOneTap), []);
  useEffect(() => onEventsUploaded(followUpPrepareStart), []);
  useEffect(() => onSignOut(resetAlarmMemory), []);
}
