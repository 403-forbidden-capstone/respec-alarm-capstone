// 이미 저장한 반복 일정을 "제목 · 요일 · 시작 시각" 열쇠로 — 가져온 수업이 이미 있는 수업인지 확인 화면이 비교함 (새 DB 칸 없음, 헤드 결정 10/30)
import { listAppointments } from '@/features/alarm/api';
import { rruleToRepeat } from '@/features/alarm/repeat';
import { minuteOfDay } from '@/lib/format';

import { existingKey } from './timetableImport';

export async function loadExistingKeys(): Promise<ReadonlySet<string>> {
  const list = await listAppointments();
  const keys: string[] = [];
  for (const a of list) {
    const days = rruleToRepeat(a.recurrenceRule);
    if (days.length > 0) keys.push(existingKey({ title: a.title, days, startMinutes: minuteOfDay(a.at) }));
  }
  return new Set(keys);
}
