// ⑥ AI 일기 · 루틴 — 데이터 접근은 이 파일에서만 합니다.
// 지금은 src/mocks의 가짜 데이터를 돌려주고, Supabase가 붙으면 이 파일 안에서만 바꿉니다.
//   읽기 · 쓰기 위치는 docs/screen-data-map.md (H01 오늘 루틴 · 내일 준비물)
import { dateParts } from '@/lib/format';
import { db } from '@/mocks/data';

import type { RoutineProgress, Todo } from './types';

// 오늘 루틴 (H01 아침)
export async function getTodayRoutine(): Promise<RoutineProgress | null> {
  const r = db.morningRoutine;
  return { id: r.id, title: r.title, steps: [...r.steps], done: r.done };
}

// 다음 단계 완료 — 다 끝낸 뒤 한 번 더 누르면 처음부터
export async function advanceRoutine(id: string): Promise<RoutineProgress | null> {
  const r = db.morningRoutine;
  if (r.id !== id) return null;
  r.done = (r.done + 1) % (r.steps.length + 1);
  return getTodayRoutine();
}

// 그날 준비물 (H01 저녁 · 내일 준비물)
export async function listTodos(day: Date): Promise<Todo[]> {
  const { day: d } = dateParts(day);
  return db.todos.filter((t) => t.day === d).map(({ id, title, done }) => ({ id, title, done }));
}

export async function toggleTodo(id: string) {
  const t = db.todos.find((x) => x.id === id);
  if (t) t.done = !t.done;
}
