// 루틴 편집(A04) 초안 고치기 — 저장 전까지 화면이 들고 있는 값을 바꿈 (저장은 api.ts saveRoutine)
// 모두 새 값을 돌려주고 받은 값은 건드리지 않음
import { dateParts, minuteOfDay } from '@/lib/format';

import { WEEKDAYS, type Routine, type RoutineStep, type Weekday } from './types';

const pad = (n: number) => String(n).padStart(2, '0');

// 단계마다 시작 시각 (21:30) — 첫 단계 시각에 앞 단계들의 걸리는 시간을 더함 (목업 rAdd와 같은 규칙), 자정을 넘기면 0시부터
export function stepTimes(r: Routine): string[] {
  let t = r.startMinute;
  return r.steps.map((s) => {
    const m = ((t % 1440) + 1440) % 1440;
    t += s.minutes;
    return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  });
}

// 반복 요일 켜기 · 끄기 — 월요일부터 순서대로 둠
export function toggleDay(r: Routine, day: Weekday): Routine {
  const picked = r.days.includes(day) ? r.days.filter((d) => d !== day) : [...r.days, day];
  return { ...r, days: WEEKDAYS.filter((d) => picked.includes(d)) };
}

// 단계 추가 — 맨 뒤에 '새 단계' 5분 · 알람 없음 (목업 rAdd)
export function addStep(r: Routine): Routine {
  const last = r.steps.reduce((n, s) => Math.max(n, Number(s.id.replace(/\D/g, '')) || 0), 0);
  return { ...r, steps: [...r.steps, { id: `s${last + 1}`, name: '새 단계', minutes: 5, alarm: false }] };
}

export function updateStep(r: Routine, id: string, patch: Partial<Omit<RoutineStep, 'id'>>): Routine {
  return { ...r, steps: r.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}

// 단계 빼기 — 마지막 하나는 남김
export function removeStep(r: Routine, id: string): Routine {
  if (r.steps.length <= 1) return r;
  return { ...r, steps: r.steps.filter((s) => s.id !== id) };
}

// 순서 바꾸기 — 한 칸 위(-1) · 아래(+1), 끝이면 그대로
export function moveStep(r: Routine, id: string, by: -1 | 1): Routine {
  const i = r.steps.findIndex((s) => s.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= r.steps.length) return r;
  const steps = [...r.steps];
  [steps[i], steps[j]] = [steps[j], steps[i]];
  return { ...r, steps };
}

// 저장할 수 있는지 — 반복 요일이 하나는 있어야 함 (목업: 요일이 없으면 저장 버튼을 끔)
export function canSave(r: Routine) {
  return r.days.length > 0 && r.steps.length > 0;
}

// 루틴이 처음 시작되는 날 — from(지금)부터 세어 고른 요일 중 가장 가까운 날. 오늘이 고른 요일이어도 시작 시각이 지났으면 다음 주
// daysAhead: 0 = 오늘, 1 = 내일 … 7 = 다음 주 같은 요일. 요일을 하나도 안 골랐으면 null
export function nextStart(r: Pick<Routine, 'days' | 'startMinute'>, from: Date): { weekday: Weekday; daysAhead: number } | null {
  if (!r.days.length) return null;
  const today = (dateParts(from).weekdayIndex + 6) % 7; // 월요일 0
  for (let ahead = minuteOfDay(from) >= r.startMinute ? 1 : 0; ahead <= 7; ahead++) {
    const weekday = WEEKDAYS[(today + ahead) % 7];
    if (r.days.includes(weekday)) return { weekday, daysAhead: ahead };
  }
  return null;
}

// 시작하는 날 말 — 오늘 · 내일 · 다음 수요일. 요일이 없으면 빈 글자
export function startWord(r: Pick<Routine, 'days' | 'startMinute'>, from: Date): string {
  const next = nextStart(r, from);
  if (!next) return '';
  if (next.daysAhead === 0) return '오늘';
  if (next.daysAhead === 1) return '내일';
  return `다음 ${next.weekday}요일`;
}

// 저장 안내 (목업 rSave) — 켜 둔 루틴이면 단계 알람 개수 · 처음 울리는 날 (from = 지금)
export function savedMessage(r: Routine, from: Date) {
  if (!r.active) return '저장했어요 · 루틴은 꺼 둔 상태예요';
  const alarms = r.steps.filter((s) => s.alarm).length;
  const when = startWord(r, from);
  if (!when) return '저장했어요';
  return alarms ? `저장했어요 · 루틴 알람 ${alarms}개가 ${when}부터 울려요` : `저장했어요 · ${when}부터 시작해요`;
}

// 불러온 루틴에서 고친 게 있는지 — 나갈 때 확인용
export function sameRoutine(a: Routine, b: Routine): boolean {
  return (
    a.title === b.title &&
    a.goal === b.goal &&
    a.startMinute === b.startMinute &&
    a.active === b.active &&
    a.days.join() === b.days.join() &&
    a.steps.length === b.steps.length &&
    a.steps.every((s, i) => s.id === b.steps[i].id && s.name === b.steps[i].name && s.minutes === b.steps[i].minutes && s.alarm === b.steps[i].alarm)
  );
}
