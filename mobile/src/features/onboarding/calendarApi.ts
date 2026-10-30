// 폰 캘린더 읽기 — 권한 확인 · 캘린더 목록 · 앞으로 2주 일정에서 수업 후보. 서버를 부르지 않고 폰 안에서만 처리 (규칙은 calendar.ts)
// 가짜 데이터 모드는 미리 정한 캘린더 · 일정을 돌려줌. 웹(실데이터)은 캘린더 API가 없어 안내
// 권한: expo-calendar 플러그인이 읽기 · 쓰기 권한을 같이 넣고 요청도 같이 묻지만(CalendarModule.kt), 이 앱은 읽기만 씀
import * as Calendar from 'expo-calendar';
import { Platform } from 'react-native';

import { UserError } from '@/lib/errors';
import { isMock } from '@/lib/mode';

import { toBatch, windowOf, type CalendarChoice, type CalendarEventLike } from './calendar';
import type { ImportBatch } from './timetableImport';

export type CalendarAccess = 'granted' | 'denied' | 'blocked'; // blocked = 다시 묻지 않음 — 폰 설정에서 켜야 함

const MOCK_CALENDARS: CalendarChoice[] = [
  { id: 'mock-1', title: '내 캘린더', source: 'Google' },
  { id: 'mock-2', title: '학교 시간표', source: 'Google' },
];

// 가짜 데이터 모드 — 매주 반복되는 수업 둘 + 한 번뿐인 병원 (병원은 후보에서 빠져야 함)
function mockEvents(now: Date): CalendarEventLike[] {
  const { start } = windowOf(now);
  const at = (days: number, h: number, m: number) => new Date(start.getTime() + days * 86_400_000 + (h * 60 + m) * 60_000); // start = 오늘 0시(한국 시간)
  const weekly = { frequency: 'weekly', interval: 1 };
  const out: CalendarEventLike[] = [];
  for (let d = 0; d < 14; d++) {
    const date = new Date(start.getTime() + d * 86_400_000);
    const dow = new Date(date.getTime() + 9 * 3_600_000).getUTCDay(); // 0 = 일요일 (한국 시간)
    if (dow === 1 || dow === 3) out.push({ title: '자료구조', startDate: at(d, 10, 30), endDate: at(d, 12, 0), location: '공학관 301', recurrenceRule: weekly });
    if (dow === 2 || dow === 4) out.push({ title: '운영체제', startDate: at(d, 13, 0), endDate: at(d, 14, 30), location: '정보관 B102', recurrenceRule: weekly });
  }
  out.push({ title: '병원', startDate: at(3, 15, 0), endDate: at(3, 16, 0), location: '', recurrenceRule: null });
  return out;
}

function assertAvailable() {
  if (!isMock() && Platform.OS === 'web') throw new UserError('폰 캘린더는 폰 앱에서만 가져올 수 있어요');
}

export async function ensureCalendarAccess(): Promise<CalendarAccess> {
  if (isMock()) return 'granted';
  assertAvailable();
  const current = await Calendar.getCalendarPermissions();
  if (current.granted) return 'granted';
  if (!current.canAskAgain) return 'blocked';
  const asked = await Calendar.requestCalendarPermissions();
  if (asked.granted) return 'granted';
  return asked.canAskAgain ? 'denied' : 'blocked';
}

export async function listCalendars(): Promise<CalendarChoice[]> {
  if (isMock()) return MOCK_CALENDARS;
  assertAvailable();
  const calendars = await Calendar.getCalendars();
  return calendars.map((c) => ({ id: c.id, title: c.title, source: c.source?.name ?? '' }));
}

// 고른 캘린더의 앞으로 2주 일정 → 수업 후보
export async function loadCandidates(calendarIds: readonly string[], now: Date): Promise<ImportBatch> {
  if (isMock()) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return toBatch(mockEvents(now));
  }
  assertAvailable();
  const { start, end } = windowOf(now);
  const events = await Calendar.listEvents([...calendarIds], start, end);
  return toBatch(
    events.map((e) => ({
      title: e.title ?? '',
      startDate: e.startDate,
      endDate: e.endDate,
      allDay: e.allDay,
      location: e.location,
      recurrenceRule: e.recurrenceRule ? { frequency: e.recurrenceRule.frequency, interval: e.recurrenceRule.interval } : null,
    })),
  );
}
