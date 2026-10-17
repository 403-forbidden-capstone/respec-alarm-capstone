import { useCallback, useEffect, useRef } from 'react';

const REPEAT_SLOW = 160; // 길게 누르는 첫 1초 동안 간격(ms) — 공용 Stepper와 같은 박자
const REPEAT_FAST = 60; // 1초 뒤부터
const REPEAT_SWITCH = 1000;

// 버튼을 길게 누르는 동안 step(delta)를 반복 — onLongPress에서 start, onPressOut에서 stop
// step은 최신 값을 읽도록 부르는 쪽이 함수형 갱신(setState(prev => …))으로 씀. 값이 끝에 닿아도 놓을 때까지 돌지만 값은 그대로
export function useHoldRepeat(step: (delta: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(step);
  useEffect(() => {
    latest.current = step;
  });

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => stop, [stop]); // 화면(시트)이 닫히면 멈춤

  const start = useCallback(
    (delta: number) => {
      stop();
      const startedAt = Date.now();
      const tick = () => {
        latest.current(delta);
        timer.current = setTimeout(tick, Date.now() - startedAt > REPEAT_SWITCH ? REPEAT_FAST : REPEAT_SLOW);
      };
      tick();
    },
    [stop],
  );

  return { start, stop };
}
