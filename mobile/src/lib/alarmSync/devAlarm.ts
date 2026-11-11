// 개발 화면(dev/alarm-test)의 시험 알람 — 서버에 행이 없어서 맞추기(reconcile)가 "서버에 없음"으로 지우면 안 됨 (#332, L8 3차)
//   알람 id 앞머리로 알아봄: UUID 모양은 그대로 두고(폰 코어·기록이 UUID를 기대함) 앞 8자리만 고정 값
import { makeUuid } from '@capstone/alarm-core';

export const DEV_ALARM_ID_PREFIX = 'de70a1a0-';

export const makeDevAlarmId = (): string => DEV_ALARM_ID_PREFIX + makeUuid().slice(DEV_ALARM_ID_PREFIX.length);

export const isDevAlarmId = (id: string): boolean => id.startsWith(DEV_ALARM_ID_PREFIX);

// AI 음성 시험 알람 — 개발 알람 중 앞머리가 더 긴 것. 시험 [즉시 정지]가 이것만 끄고 "1분 뒤 울리기" 같은 개발 예약 알람은 그대로 둠 (네이티브 VoiceTest.VOICE_ID_PREFIX와 같은 값)
export const VOICE_TEST_ALARM_ID_PREFIX = 'de70a1a0-a1ce-';

export const makeVoiceTestAlarmId = (): string => VOICE_TEST_ALARM_ID_PREFIX + makeUuid().slice(VOICE_TEST_ALARM_ID_PREFIX.length);

export const isVoiceTestId = (id: string): boolean => id.startsWith(VOICE_TEST_ALARM_ID_PREFIX);
