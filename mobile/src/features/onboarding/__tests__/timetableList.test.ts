import { describe, expect, it } from '@jest/globals';

import { repeatToRrule } from '@/features/alarm/repeat';
import type { Appointment } from '@/features/alarm/types';
import type { Weekday } from '@/lib/weekday';

import { classSeriesOf, seriesLine } from '../timetableList';

const appt = (id: string, title: string, days: Weekday[], hm: string, extra: Partial<Appointment> = {}): Appointment =>
  ({ id, title, at: new Date(`2026-11-03T${hm}:00+09:00`), place: '공학관', recurrenceRule: repeatToRrule(days), ...extra }) as Appointment;

describe('학교 시간표 목록 (classSeriesOf)', () => {
  it('반복 일정만 남기고 한 번짜리 · 일정 없는 알람은 뺌', () => {
    const list = [appt('a', '자료구조', ['월', '수'], '10:30'), appt('b', '동아리', [], '19:00'), appt('c', '알람', ['화'], '07:00', { standalone: true })];
    expect(classSeriesOf(list).map((s) => s.id)).toEqual(['a']);
  });

  it('첫 요일 → 시각 → 제목 순', () => {
    const list = [appt('fri', '영어', ['금'], '09:00'), appt('mon-late', '운영체제', ['월'], '13:00'), appt('mon-early', '자료구조', ['월', '수'], '10:30'), appt('tue', '알바', ['화', '목'], '18:00')];
    expect(classSeriesOf(list).map((s) => s.id)).toEqual(['mon-early', 'mon-late', 'tue', 'fri']);
  });

  it('남이 만든 공동 약속은 지울 수 없음', () => {
    const [mine, shared] = classSeriesOf([appt('a', '수업', ['월'], '09:00'), appt('b', '스터디', ['화'], '09:00', { canEdit: false })]);
    expect(mine.canDelete).toBe(true);
    expect(shared.canDelete).toBe(false);
  });

  it('줄 아래 글자 = 반복 · 시각 · 장소', () => {
    const [s] = classSeriesOf([appt('a', '자료구조', ['수', '월'], '10:30')]);
    expect(seriesLine(s)).toBe('매주 월 · 수 · 오전 10:30 · 공학관');
    expect(seriesLine({ ...s, place: '' })).toBe('매주 월 · 수 · 오전 10:30');
  });
});
