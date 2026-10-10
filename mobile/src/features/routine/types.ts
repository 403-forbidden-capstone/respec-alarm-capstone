// ⑥ AI 일기 · 루틴 — 이 기능에서 쓰는 타입

// 오늘 루틴 진행 (H01) — 단계를 순서대로 끝냄
export type RoutineProgress = {
  id: string;
  title: string;
  steps: string[];
  done: number; // 끝낸 단계 수
};

// 준비물 (DB todos, todo_type = ITEM)
export type Todo = {
  id: string;
  title: string;
  done: boolean;
};
