// 울림 계획 계산 — 순수 함수만 (네이티브 · 웹 대체와 상관없이 같은 값이 나오게 공통(TS)에서 계산)
// 네이티브(Kotlin)는 여기서 나온 RingPlan을 받아 그대로 실행함. 판단은 하지 않음
// 같은 입력 → 같은 계획은 spec/cases.json을 단위 테스트가 확인 (__tests__/plan.test.ts)
import {
  ALARM_INTENSITIES,
  ALARM_TYPES,
  ALARM_VIBRATIONS,
  type AlarmIntensity,
  type AlarmType,
  type AlarmVibration,
  type OneTapEventType,
  type RingPackage,
  type RingPlan,
} from './types';

export const DEFAULT_SOUND_KEY = 'default';

/** 강도에서 정하는 배경음 키 · 진동 (D1 A) — 서버 calc/intensity.ts LEVEL_FIELDS · 네이티브 AlarmSoundKeys / AlarmVibration.defaultFor와 같은 대응 */
const SOUND_KEY_OF_INTENSITY: Record<AlarmIntensity, string> = { SOFT: 'theme_calm', NORMAL: 'theme_default', STRONG: 'theme_urgent' };
const VIBRATION_OF_INTENSITY: Record<AlarmIntensity, AlarmVibration> = { SOFT: 'NONE', NORMAL: 'SHORT_REPEAT', STRONG: 'STRONG_CONTINUOUS' };

/** 꾸러미에 배경음이 없거나 비면 강도에서 */
export function soundKeyOf(pkg: Pick<RingPackage, 'intensity'> & Partial<Pick<RingPackage, 'soundKey'>>): string {
  return (typeof pkg.soundKey === 'string' ? pkg.soundKey.trim() : '') || SOUND_KEY_OF_INTENSITY[pkg.intensity] || SOUND_KEY_OF_INTENSITY.NORMAL;
}

/** 꾸러미에 진동이 없거나 모르는 값이면 강도에서 */
export function vibrationOf(pkg: Pick<RingPackage, 'intensity'> & Partial<Pick<RingPackage, 'vibration'>>): AlarmVibration {
  return ALARM_VIBRATIONS.includes(pkg.vibration as AlarmVibration) ? (pkg.vibration as AlarmVibration) : VIBRATION_OF_INTENSITY[pkg.intensity] ?? 'SHORT_REPEAT';
}

/** 한 번 울리는 최대 시간 — 백그라운드 재생 제한 때문, 실기기로 확정 예정 (7장 7.4.2 · T-6) */
export const MAX_RING_MILLIS = 3 * 60_000;

/** 기본 미루기 시간 — 알림의 "미루기" 버튼이 씀 (알람 화면은 아래 목록에서 고름). 호환을 위해 10분 유지 */
export const SNOOZE_MILLIS = 10 * 60_000;

/** 알람 화면에서 고르는 미루기 시간 (분) — D3 기본안 A: 5 · 10 · 15분 */
export const SNOOZE_MINUTES_OPTIONS: readonly number[] = [5, 10, 15];

/** 미루기 한도 기본값 (알람 한 개당 3번) — 꾸러미의 snoozeLimit이 틀렸을 때만 씀 */
export const DEFAULT_SNOOZE_LIMIT = 3;



/** 평가 보정을 아무리 크게 줘도 이 밑으로는 안 내림 (소리가 안 나는 알람이 되지 않게) */
export const MIN_VOLUME_PERCENT = 10;

// 볼륨 = 알람 볼륨 최대치 × 강도별 비율 (alarm-core.md · #29) → 그다음 × (1 + volumeAdjust)
const BASE_VOLUME_PERCENT: Record<AlarmIntensity, number> = { SOFT: 60, NORMAL: 80, STRONG: 100 };

// 안 끄면 다시 울림 — 약 5분 뒤 1번 · 보통 5분 간격 2번 · 강 3분 간격 3번 (alarm-core.md · #29 · 7장 7.4.2)
// "간격"의 읽기 (해석 — 문서에 측정 기준 없음, 지형님 확인. 되돌리기 쉬움: 이 표만 바꾸면 네이티브는 그대로):
//   간격 = 한 울림(최대 3분)이 끝난 뒤 다음 울림이 시작될 때까지 쉬는 시간
//   약: 울림 → 5분 쉼 → 울림 (첫 울림 시작 0분 → 8분)
//   보통: 울림 → 5분 쉼 → 울림 → 5분 쉼 → 울림 (0 → 8 → 16분)
//   강: 울림 → 3분 쉼 → 울림 ×3 (0 → 6 → 12 → 18분)
//   마지막 울림까지 끝나는 때: 약 11분 · 보통 19분 · 강 21분 (첫 울림 시작 기준, unansweredSpanMillis)
//   시작-시작으로 읽으면 강은 3분 울림이 쉬는 틈 없이 12분 이어져서 쓰지 않음
const RE_RING_GAP_MINUTES: Record<AlarmIntensity, readonly number[]> = {
  SOFT: [5],
  NORMAL: [5, 5],
  STRONG: [3, 3, 3],
};

// 쉬는 시간 표를 "첫 울림 시작으로부터의 거리"로 바꿈. 네이티브는 이 거리 그대로 AlarmManager에 걸어 둠
function reRingOffsetsFor(intensity: AlarmIntensity): number[] {
  let offset = 0;
  return RE_RING_GAP_MINUTES[intensity].map((gapMinutes) => {
    offset += MAX_RING_MILLIS + gapMinutes * 60_000;
    return offset;
  });
}

// 알림 · 알람 화면 한 줄. WAKE · PREPARE · DEPARTURE는 ring.tsx(H07)와 같은 문구, ARRIVE · ROUTINE은 목업에 없어 임시 (작성자 판단)
// 서버가 꾸러미에 notice를 주면(약속의 준비 · 출발 알림) 이 줄 대신 그 글자를 씀 — buildRingPlan. 기상(WAKE)은 서버가 notice를 안 줘서 이 줄 그대로
const HEADING: Record<AlarmType, string> = {
  WAKE: '일어날 시간이에요',
  PREPARE: '준비할 시간이에요',
  DEPARTURE: '출발할 시간이에요',
  ARRIVE: '약속 장소에 도착했나요?',
  ROUTINE: '루틴 할 시간이에요',
};

// 일정 알림(알림음 · 진동 한 번)의 원탭 — alarm-core.md 소리 줄 · screen-data-map H07:
//   준비 시작 · 출발 · 루틴 단계 = ACKNOWLEDGED, 도착 = ARRIVAL_CONFIRMED
const ONE_TAP: Record<Exclude<AlarmType, 'WAKE'>, { label: string; eventType: OneTapEventType }> = {
  PREPARE: { label: '준비 시작', eventType: 'ACKNOWLEDGED' },
  DEPARTURE: { label: '출발했어요', eventType: 'ACKNOWLEDGED' },
  ARRIVE: { label: '도착했어요', eventType: 'ARRIVAL_CONFIRMED' },
  ROUTINE: { label: '했어요', eventType: 'ACKNOWLEDGED' },
};

/** 알람 볼륨 최대치의 몇 %로 울릴지 (정수 10~100). volumeAdjust는 비율: -0.1 = 10% 줄임 */
export function volumePercentFor(intensity: AlarmIntensity, volumeAdjust = 0): number {
  const adjust = Number.isFinite(volumeAdjust) ? volumeAdjust : 0;
  const percent = Math.round(BASE_VOLUME_PERCENT[intensity] * (1 + adjust));
  return Math.min(100, Math.max(MIN_VOLUME_PERCENT, percent));
}

/** 꾸러미 한 개의 울림 계획. 꾸러미에 notice가 있으면 그 글자가 heading, 없거나 비면 종류별 HEADING */
export function buildRingPlan(
  pkg: Pick<RingPackage, 'type' | 'intensity'> & Partial<Pick<RingPackage, 'soundKey' | 'volumeAdjust' | 'notice' | 'snoozeLimit'>>,
): RingPlan {
  const soundKey = pkg.soundKey?.trim() || DEFAULT_SOUND_KEY;
  // notice는 서버가 준 JSON 값이라 글자가 아닐 수도 있음(숫자 · null 등) — trim에서 던져 알람이 안 걸리면 안 되므로 글자일 때만 보고, 아니면 기본 줄
  const heading = (fallback: string) => (typeof pkg.notice === 'string' ? pkg.notice.trim() : '') || fallback;
  // 기상·출발 알람은 사용자가 해제할 때까지 알람음·진동·AI 음성이 함께 반복됩니다.
  if (pkg.type === 'WAKE' || pkg.type === 'DEPARTURE') {
    return {
      sound: true,
      volumePercent: volumePercentFor(pkg.intensity, pkg.volumeAdjust),
      soundKey,
      maxRingMillis: MAX_RING_MILLIS,
      reRingOffsetsMillis: pkg.type === 'WAKE' ? reRingOffsetsFor(pkg.intensity) : [],
      snoozeMillis: SNOOZE_MILLIS,
      snoozeMinutesOptions: [...SNOOZE_MINUTES_OPTIONS],
      snoozeLimit: Number.isInteger(pkg.snoozeLimit) && (pkg.snoozeLimit as number) >= 0 ? (pkg.snoozeLimit as number) : DEFAULT_SNOOZE_LIMIT,
      heading: heading(HEADING[pkg.type]),
      oneTapLabel: null,
      oneTapEventType: null,
    };
  }
  const oneTap = ONE_TAP[pkg.type];
  return {
    sound: false, // 알람음 없음 — 보통 알림(알림음 · 진동 한 번)
    volumePercent: 0,
    soundKey,
    maxRingMillis: 0,
    reRingOffsetsMillis: [],
    snoozeMillis: 0,
    snoozeMinutesOptions: [],
    snoozeLimit: 0,
    heading: heading(HEADING[pkg.type]),
    oneTapLabel: oneTap.label,
    oneTapEventType: oneTap.eventType,
  };
}

/** 안 끄고 그대로 두었을 때 각 울림이 시작되는 시각 (첫 울림 포함) */
export function ringStartTimes(plan: RingPlan, firstRingAtMillis: number): number[] {
  return [firstRingAtMillis, ...plan.reRingOffsetsMillis.map((offset) => firstRingAtMillis + offset)];
}

/** 첫 울림 시작부터 마지막 울림이 끝날 때까지 (서버가 놓침 시각을 셀 때 쓰는 "다시 울림 총 소요", 7장 7.9.2) */
export function unansweredSpanMillis(plan: RingPlan): number {
  const last = plan.reRingOffsetsMillis[plan.reRingOffsetsMillis.length - 1] ?? 0;
  return last + plan.maxRingMillis;
}

/** 미루면 다시 울릴 시각 — 다시 울림이 아니라 미루기라 횟수(snoozeCount)에 셈. snoozeMinutes를 주면 그 분 뒤, 안 주면 기본 미루기 시간 뒤 */
export function snoozeRingAt(plan: RingPlan, nowMillis: number, snoozeMinutes?: number): number {
  return nowMillis + (snoozeMinutes == null ? plan.snoozeMillis : snoozeMinutes * 60_000);
}

/** 아직 더 미룰 수 있는지 — snoozeCount(이미 미룬 횟수)가 한도에 닿으면 false. 한도가 이상한 값이면 못 미룸 */
export function canSnooze(snoozeCount: number, snoozeLimit: number): boolean {
  return Number.isFinite(snoozeCount) && Number.isFinite(snoozeLimit) && snoozeCount < snoozeLimit;
}

/** 고른 분이 고를 수 있는 미루기 시간인지 */
export function isSnoozeMinutesAllowed(plan: RingPlan, snoozeMinutes: number): boolean {
  return plan.snoozeMinutesOptions.includes(snoozeMinutes);
}

/**
 * 이만큼 미루면 출발 시각보다 몇 분 늦는지 — (다시 울릴 시각 = 지금 + 미룰 분) − 출발 시각(departAt)을 분으로 올림. 안 늦으면 0
 * 출발 시각과 같으면 아직 안 늦음(0), 1ms라도 넘으면 1분. departAt이 없으면 판단할 수 없어 0 (표시 안 함).
 * L6 안건후보: 늦어요 기준 = 기본안은 "다시 울릴 시각 > departAt" (남은 준비 시간은 안 뺌 — 꾸러미에 준비 시간이 없음)
 */
export function snoozeLateMinutes(nowMillis: number, snoozeMinutes: number, departAtMillis: number | null | undefined): number {
  if (departAtMillis == null || !Number.isFinite(departAtMillis) || !Number.isFinite(nowMillis)) return 0;
  const overMillis = nowMillis + snoozeMinutes * 60_000 - departAtMillis;
  return overMillis > 0 ? Math.ceil(overMillis / 60_000) : 0;
}

/** 이만큼 미루면 늦는지 — snoozeLateMinutes가 1분 이상이면 true */
export function isSnoozeLate(nowMillis: number, snoozeMinutes: number, departAtMillis: number | null | undefined): boolean {
  return snoozeLateMinutes(nowMillis, snoozeMinutes, departAtMillis) > 0;
}

// 늦어요 표시 글자 — 막지 않고 보여 주기만 함 (네이티브 · 웹 미리보기 같음). 출발 시각 글자(departClock)는 "9:00"처럼 오전 · 오후 없이 시:분 (화면이 서식을 만듦)

/** 늦게 되는 시간 칩 안에 들어가는 글자 */
export const SNOOZE_LATE_CHIP = '늦어요';

/** 미루기 버튼 글자 — 고른 분이 늦으면 "15분 미루기 · 늦어요" (알림의 미루기 버튼도 같은 글자) */
export function snoozeButtonLabel(snoozeMinutes: number, late: boolean): string {
  return late ? `${snoozeMinutes}분 미루기 · ${SNOOZE_LATE_CHIP}` : `${snoozeMinutes}분 미루기`;
}

/** 미루기 버튼 바로 위 굵은 경고 한 줄 — "15분 미루면 9:00 출발보다 5분 늦어요" */
export function snoozeLateLine(snoozeMinutes: number, departClock: string, lateMinutes: number): string {
  return `${snoozeMinutes}분 미루면 ${departClock} 출발보다 ${lateMinutes}분 늦어요`;
}

/** 가장 짧은 미루기(5분)도 늦을 때 큰 시각 위에 뜨는 경고 띠 */
export function wakeNowBanner(departClock: string): string {
  return `지금 일어나야 ${departClock} 출발에 맞아요`;
}

/** "미루기 1/3회" — 이미 미룬 횟수 / 한도 */
export function snoozeCountLabel(snoozeCount: number, snoozeLimit: number): string {
  return `미루기 ${snoozeCount}/${snoozeLimit}회`;
}

/** 한도에 닿았을 때 미루기 버튼 대신 보이는 안내. departLabel = 출발 시각 글자(예: "오전 8:40"), 없으면 시각 없이 */
export function snoozeLimitNotice(departLabel?: string | null): string {
  return departLabel ? `지금 바로 준비 · ${departLabel} 출발` : '지금 바로 준비';
}

/** 예약 시각이 이미 지났는지 (같은 순간도 지난 것으로 봄) — schedule()이 안 걸고 skipped_past를 돌려주는 기준 */
export function isPastRing(atMillis: number, nowMillis: number): boolean {
  return atMillis <= nowMillis;
}

/** 꾸러미가 말이 되는지 확인 — 틀리면 던짐 (시각이 지난 것은 오류가 아니라 skipped_past) */
export function validateRingPackage(pkg: RingPackage): void {
  if (typeof pkg.alarmId !== 'string' || pkg.alarmId.length === 0) {
    throw new Error('알람 id가 비어 있어요.');
  }
  if (!ALARM_TYPES.includes(pkg.type)) {
    throw new Error(`알 수 없는 알람 종류: ${String(pkg.type)}`);
  }
  if (!ALARM_INTENSITIES.includes(pkg.intensity)) {
    throw new Error(`알 수 없는 알람 강도: ${String(pkg.intensity)}`);
  }
  if (!Number.isFinite(pkg.atMillis)) {
    throw new Error('알람 시각(atMillis)이 숫자가 아니에요.');
  }
  if (!Number.isInteger(pkg.snoozeLimit) || pkg.snoozeLimit < 0) {
    throw new Error('미루기 한도(snoozeLimit)는 0 이상의 정수여야 해요.');
  }
  if (typeof pkg.title !== 'string') {
    throw new Error('알람 제목(title)이 없어요.');
  }
}

/**
 * 네이티브에 넘기는 글자 — 꾸러미 + 울림 계획을 JSON 하나로
 * soundKey · vibration은 늘 넣음(D1 A) — 서버가 채워 준 값 그대로, 없으면 강도에서. plan.soundKey도 같은 값으로 맞춰 보냄(네이티브가 최상위 값을 우선 읽음)
 * 안 읽는 자리(꾸러미의 snoozeMinutesOptions)는 넘기지 않음 — 미루기 시간 목록과 한도는 plan에 실려 감. 값이 없는 칸은 빠짐
 * notice도 따로 안 넘김 — buildRingPlan이 plan.heading에 이미 넣었고, 네이티브는 plan.heading만 저장해 알림에 씀
 */
export function toNativePayload(pkg: RingPackage, plan: RingPlan): string {
  const soundKey = soundKeyOf(pkg);
  return JSON.stringify({
    alarmId: pkg.alarmId,
    type: pkg.type,
    atMillis: pkg.atMillis,
    title: pkg.title,
    subtitle: pkg.subtitle,
    intensity: pkg.intensity,
    snoozeLimit: pkg.snoozeLimit,
    voiceText: pkg.voiceText,
    soundKey,
    vibration: vibrationOf(pkg),
    volumeAdjust: pkg.volumeAdjust,
    departAt: pkg.departAt,
    plan: { ...plan, soundKey },
  });
}
