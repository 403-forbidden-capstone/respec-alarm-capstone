// H03 일정 편집 시트 (U14 · U15, 이슈 #211 · D41 A · D44 A · N6) — 시트의 값과 문구를 만드는 순수 계산
// 단위 테스트는 __tests__/editSheet.test.ts
import { formatTime } from '@/lib/format';
import type { Weekday } from '@/lib/weekday';

import { rruleToRepeat, sameDays } from './repeat';
import type { AlarmChange } from './schedule';
import type { Appointment, AppointmentPatch, EditScope, Importance } from './types';

// 편집 시트가 들고 있는 값 — 날짜와 시각은 at 하나 (날짜를 고르면 시각은 그대로, 시각을 고르면 날짜는 그대로)
// placeLat · placeLng = 장소의 좌표 — 처음 값(실데이터는 DB 좌표, 가짜 데이터는 없음)이거나 새로 고른 장소의 좌표
export type ScheduleEditValue = {
  title: string;
  at: Date;
  place: string;
  placeLat?: number;
  placeLng?: number;
  repeatDays: Weekday[]; // 비어 있으면 반복 없음
  importance: Importance;
};

// 삭제 되돌리기 토스트가 떠 있는 시간 — 지나면 그때 지움 (삭제 되돌리기 계약: docs/screen-data-map.md H03)
export const UNDO_MS = 5000;

export function editValueOf(a: Pick<Appointment, 'title' | 'at' | 'place' | 'importance' | 'recurrenceRule' | 'placeLat' | 'placeLng'>): ScheduleEditValue {
  // 처음 장소의 좌표도 들고 있다가 되돌리기 patch에 같이 실음 — 이름만 보내면 서버가 장소가 바뀐 걸로 보고 좌표를 비움(L1 #285 리뷰)
  return {
    title: a.title,
    at: a.at,
    place: a.place,
    ...(a.placeLat !== undefined && a.placeLng !== undefined ? { placeLat: a.placeLat, placeLng: a.placeLng } : {}),
    repeatDays: rruleToRepeat(a.recurrenceRule),
    importance: a.importance,
  };
}

// 바뀐 칸 — 제목은 앞뒤 공백을 뺀 값으로 비교, 장소는 이름으로 (좌표만 다른 같은 이름은 그대로)
export function changedFields(initial: ScheduleEditValue, value: ScheduleEditValue) {
  return {
    title: value.title.trim() !== initial.title.trim(),
    at: value.at.getTime() !== initial.at.getTime(),
    place: value.place !== initial.place,
    importance: value.importance !== initial.importance,
    repeatDays: !sameDays(value.repeatDays, initial.repeatDays),
  };
}

export function isEditChanged(initial: ScheduleEditValue, value: ScheduleEditValue): boolean {
  return Object.values(changedFields(initial, value)).some(Boolean);
}

// 바뀐 칸만 담은 patch (updateAppointment에 그대로)
export function toPatch(initial: ScheduleEditValue, value: ScheduleEditValue): AppointmentPatch {
  const changed = changedFields(initial, value);
  const patch: AppointmentPatch = {};
  if (changed.title) patch.title = value.title.trim();
  if (changed.at) patch.at = value.at;
  if (changed.place) {
    patch.place = value.place;
    if (value.placeLat !== undefined && value.placeLng !== undefined) {
      patch.placeLat = value.placeLat;
      patch.placeLng = value.placeLng;
    }
  }
  if (changed.importance) patch.importance = value.importance;
  if (changed.repeatDays) patch.repeatDays = value.repeatDays;
  return patch;
}

// 반복 범위(이번만 · 이후 모두)를 먼저 물어야 하는지 — 반복 일정이면 true
//   고치는 중 반복 요일을 바꿨으면 묻지 않음: 요일은 "이번 회차부터 이후 모두"에만 먹는 값이라(updateAppointment) 이번만과 섞일 수 없음
export function needsScope(repeated: boolean, patch?: AppointmentPatch): boolean {
  return repeated && patch?.repeatDays === undefined;
}

// 묻지 않을 때 쓰는 범위 — 반복 요일을 바꾸면 이후 모두, 그 밖(반복 아님)은 한 일정뿐이라 이번만
export function scopeWithoutAsking(patch?: AppointmentPatch): EditScope {
  return patch?.repeatDays === undefined ? 'this' : 'following';
}

// 일정 지우기 확인 창 문구 한 곳 — scope는 반복 일정에서 고른 범위
export function deleteConfirmCopy({ shared, repeated, scope }: { shared: boolean; repeated: boolean; scope?: EditScope }): { title: string; message: string; okLabel: string } {
  const title = !repeated ? '일정을 지울까요?' : scope === 'following' ? '이후 일정을 모두 지울까요?' : '이번 일정을 지울까요?';
  return {
    title,
    message: shared ? '공동 약속이라 모두에게서 사라져요' : '지운 뒤 잠깐은 되돌릴 수 있어요',
    okLabel: '지우기',
  };
}

// 공동 약속에서 나만 빠지기 확인 창 문구
export const LEAVE_CONFIRM = { title: '이 약속에서 빠질까요?', message: '내 알람만 사라지고 다른 사람은 그대로예요', okLabel: '빠지기' } as const;

// 일정을 고쳐서 알람 시각이 바뀐 뒤 토스트 글자 — "알람 오전 7:10 → 오전 6:50". 여러 개면 첫 알람과 "외 n개". 바뀐 알람이 없으면 빈 글자
export function moveToast(changes: readonly AlarmChange[]): string {
  const first = changes[0];
  if (!first) return '';
  const rest = changes.length > 1 ? ` 외 ${changes.length - 1}개` : '';
  return `알람 ${formatTime(first.from)} → ${formatTime(first.to)}${rest}`;
}
