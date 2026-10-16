import { useEffect } from 'react';

import { onEventsUploaded } from '@/lib/alarmSync';

import { followUpOneTap } from '../oneTap';

// 원탭 뒤처리(출발 · 도착 시각과 지각)를 울림 기록 올리기 훅에 등록 — 앱 시작 때 한 번.
// 루트 레이아웃에서 useAlarmSync보다 먼저(같은 컴포넌트에서 위에) 불러야 함: 효과는 선언 순서대로 돌아서, 앱을 열자마자 올리는 기록(꺼져 있을 때 누른 원탭)이
// 훅이 등록되기 전에 올라가 뒤처리 없이 폰에서 지워지는 일이 없음. 가짜 데이터 모드에서는 올리는 일이 없어 훅도 안 불림
export function useOneTapFollowUp() {
  useEffect(() => onEventsUploaded(followUpOneTap), []);
}
