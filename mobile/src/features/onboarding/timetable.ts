// 수업 시간표 단계(L02-6, D66-1 B 직접 입력 초안)의 순수 함수 — 줄 상태 · 첫 수업 날짜 · 일정 입력값 만들기 (시험: __tests__/timetable.test.ts)
import { defaultDraft } from '@/features/alarm/api';
import { sortDays } from '@/features/alarm/repeat';
import type { AppointmentDraft, Estimate, LatLng, Transport } from '@/features/alarm/types';
import { addDays, dateParts, formatMinuteOfDay, minuteOfDay, startOfDay } from '@/lib/format';
import { WEEKDAYS, type Weekday } from '@/lib/weekday';

import type { ClassRow } from './components/TimetableStep';

// 수업 줄 수 상한 — 한 번에 길찾기를 줄마다 부르므로 (카카오 도보 하루 한도). 나머지는 일정 화면에서
export const MAX_CLASS_ROWS = 10;

export type RowStatus = 'empty' | 'partial' | 'complete';

// 줄이 얼마나 채워졌나 — 과목 · 요일 1개 이상 · 시작 시각 · 장소가 모두 있어야 complete, 모두 비면 empty, 그 사이는 partial
export function rowStatus(row: Pick<ClassRow, 'name' | 'days' | 'startMinutes' | 'place'>): RowStatus {
  const filled = [row.name.trim() !== '', row.days.length > 0, row.startMinutes != null, row.place.trim() !== ''];
  if (filled.every(Boolean)) return 'complete';
  return filled.some(Boolean) ? 'partial' : 'empty';
}

// 요일 → Date.getDay() 번호 (0 = 일요일)
const DAY_INDEX: Record<Weekday, number> = Object.fromEntries(WEEKDAYS.map((day, i) => [day, (i + 1) % 7])) as Record<Weekday, number>;

// 선택한 요일 중 지금 이후로 가장 가까운 수업 날짜(그날 0시, 한국 시간) — 오늘이 그 요일이고 시작 시각이 아직 안 지났으면 오늘, 아니면 다음 해당 요일
// 지금 시각은 부르는 쪽이 넘김 (lib/clock now()). 요일이 비어 있으면 오늘
export function firstDate(days: readonly Weekday[], startMinutes: number, nowDate: Date): Date {
  const today = startOfDay(nowDate);
  if (!days.length) return today;
  const wanted = new Set(days.map((day) => DAY_INDEX[day]));
  for (let offset = 0; offset < 8; offset += 1) {
    const day = addDays(today, offset);
    if (!wanted.has(dateParts(day).weekdayIndex)) continue;
    if (offset > 0 || startMinutes > minuteOfDay(nowDate)) return day;
  }
  return today; // 위 반복에서 반드시 잡히므로 닿지 않음
}

// 길찾기를 못 해 대략값으로만 나온 계산 — 이대로 반복 일정에 저장하면 계속 쓰이므로 저장하지 않고 다시 누르게 함
// 줄에 달 이유 글자를 돌려줌 (이동 분을 알면 넣음). 저장해도 되면 null
export function needsRetry(estimate: Pick<Estimate, 'travelNeedsConfirm'> & { appointment?: { travelMinutes?: number } }): string | null {
  if (!estimate.travelNeedsConfirm) return null;
  const minutes = estimate.appointment?.travelMinutes;
  const rough = typeof minutes === 'number' ? `대략 ${minutes}분` : '대략적인 값';
  return `길 찾기를 못 해 ${rough}으로만 나왔어요. 잠시 뒤 다시 눌러 주세요`;
}

// 수업 한 줄 → 일정 입력값. 줄은 complete여야 함
//   transport = 프로필 기본 이동 수단 — profiles.default_transport와 일정의 Transport는 같은 DB enum(transport_type)이라 바꿀 것 없음
//   importance · items · alarms = 새 일정 화면(H05)이 쓰는 기본 입력값(api.ts defaultDraft) 그대로 — L1 기본값 그대로, 여기서 새로 정하지 않음
export function toDraft(row: ClassRow, coords: LatLng | undefined, transport: Transport, date: Date): AppointmentDraft {
  if (rowStatus(row) !== 'complete' || row.startMinutes == null) throw new Error('채우지 않은 수업 줄은 일정으로 바꿀 수 없어요');
  const base = defaultDraft(date);
  return {
    title: row.name.trim(),
    date: startOfDay(date),
    time: formatMinuteOfDay(row.startMinutes),
    repeat: sortDays(row.days),
    place: row.place.trim(),
    placeLat: coords?.lat,
    placeLng: coords?.lng,
    transport,
    importance: base.importance,
    items: base.items,
    alarms: base.alarms,
  };
}
