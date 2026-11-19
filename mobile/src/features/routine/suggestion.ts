// 루틴 제안 → 루틴 편집(A04) 초안 (안건 D114, 순수 함수)
//   제안의 단계 시각은 기상 알람 기준 분(D29) · 밤 루틴만 고정 시각인데, 루틴 편집은 "첫 단계 시각 + 단계마다 걸리는 분"이라 여기서 바꿈
//   기상 기준 단계: 그 사람의 다음 기상 알람(그 요일) 시각 + 분 — 기상 알람이 없으면 7:00으로 두고 사용자가 고침
//   걸리는 분: 다음 단계가 시작하기까지 (마지막 단계는 제안의 분) — 루틴 편집은 단계가 이어서 시작하므로
import { WEEKDAYS, type Weekday } from '@/lib/weekday';

import type { Routine, RoutineSuggestion } from './types';

export const DEFAULT_WAKE_MINUTE = 7 * 60;

// 0 일 ~ 6 토 → '월' ~ '일'
export const dayOfNumber = (n: number): Weekday => WEEKDAYS[(((n + 6) % 7) + 7) % 7];
export const daysOf = (nums: readonly number[]): Weekday[] => WEEKDAYS.filter((w) => nums.map(dayOfNumber).includes(w));

const minuteOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// 밤 루틴(고정 시각)인지
export const isNightRoutine = (s: Pick<RoutineSuggestion, 'draft'>) => s.draft.steps.some((x) => x.at != null);

export function suggestionToRoutine(s: RoutineSuggestion, wakeMinute: number | null): Routine {
  const wake = wakeMinute ?? DEFAULT_WAKE_MINUTE;
  const starts = s.draft.steps.map((x) => (x.at ? minuteOf(x.at) : wake + (x.offsetFromWake ?? 0)));
  return {
    id: null,
    title: s.title,
    goal: s.draft.goal,
    days: daysOf(s.draft.days),
    startMinute: starts[0] ?? wake,
    steps: s.draft.steps.map((x, i) => ({
      id: `s${i + 1}`,
      name: x.name,
      minutes: i + 1 < starts.length ? Math.max(1, starts[i + 1] - starts[i]) : x.minutes,
      alarm: x.alarm,
    })),
    active: true,
    sourceJournal: null,
    sourceSuggestion: s.id,
  };
}

// 카드 한 줄 — "월 · 수 · 목 · 2단계 · 기상 알람에 맞춰" / "일 · 화 · 목 · 2단계 · 밤 21:30부터"
export function suggestionSummary(s: RoutineSuggestion): string {
  const days = daysOf(s.draft.days).join(' · ');
  const first = s.draft.steps[0];
  const when = isNightRoutine(s) && first?.at ? `밤 ${first.at}부터` : '기상 알람에 맞춰';
  return `${days} · ${s.draft.steps.length}단계 · ${when}`;
}
