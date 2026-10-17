// 요일 — 월요일부터. 반복 요일 칩(components/ui/DayPicker) · 일정 반복(features/alarm/repeat) · 루틴 반복이 같이 씀
export const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
