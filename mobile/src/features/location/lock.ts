// 위치 판정 기억(상태 · 계획 · 등록 목록 · 쓸 것)을 한 번에 하나씩만 고치게 하는 줄 — 백그라운드 작업(task.ts)과 앱 화면 쪽(register.ts)이 같이 씀
//   읽기 → 해석 → 저장이 겹치면 한쪽 결과가 사라짐 (transitions.ts interpretSignals 안내). 앞 일이 실패해도 다음 일은 이어서
//   줄 안에서 줄을 다시 부르면 서로 기다려 멈춤 — withLock 안에서는 withLock을 부르지 않음
let tail: Promise<unknown> = Promise.resolve();

export function withLock<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task);
  tail = run.catch(() => {});
  return run;
}

// 로그아웃 표 — 로그아웃 정리가 올리면, 그 전에 시작한 등록(register.ts)이 줄 차례가 와도 앞 계정 집을 다시 등록하지 않고 멈춤
let epoch = 0;
export const currentEpoch = (): number => epoch;
export const bumpEpoch = (): void => {
  epoch += 1;
};
