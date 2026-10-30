// 가짜 모델 — 기능 모드에서 "모델이 낼 출력"을 규칙으로 만듦 (글 없이 구조만). 모델 호출 · 네트워크 호출 없음.
//   서버 순수 함수(turn-core)가 받는 T2F 출력(FastExtract)을 인물의 진실에서 만들어 넘기는 곳.
//   T1(대화 글)은 만들지 않음 — 처리 결과 줄을 그대로 옮긴 한 줄만 남김 (보고서에서 서버가 무엇을 말하려 했는지 보는 용).
//   호출 수는 장부에 0원으로 적어, 기능 모드에서 모델 호출이 0이라는 것을 보고서에 보임.
import type { Ledger } from './ledger.ts';

export interface FastExtractLike {
  appointments: unknown[];
  alarm_changes: unknown[];
  fact_feedback: unknown[];
  prep_adjustment: unknown | null;
  safety_flag: boolean;
}

export class FakeLlm {
  t2fCalls = 0;
  t1Calls = 0;
  private ledger: Ledger;
  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  // T2F 한 번 — 안 맡은 칸은 비워서 FastExtract 모양으로
  t2f(parts: Partial<FastExtractLike>): FastExtractLike {
    this.t2fCalls++;
    this.ledger.record('T2F(fake)', 0);
    return { appointments: [], alarm_changes: [], fact_feedback: [], prep_adjustment: null, safety_flag: false, ...parts };
  }

  // T1 대신 — 서버 처리 결과 줄(applied · pending · rejected · clarify)을 한 줄로 (글을 지어내지 않음)
  t1(event: { applied: string[]; pending: { summary: string }[]; rejected: { target: string; reason: string }[]; clarify: string[] } | undefined): string {
    this.t1Calls++;
    this.ledger.record('T1(fake)', 0);
    if (!event) return '(처리 결과 없음)';
    const parts = [
      ...event.applied.map((x) => `저장됨: ${x}`),
      ...event.pending.map((x) => `확인 필요: ${x.summary}`),
      ...event.rejected.map((x) => `거절: ${x.target} (${x.reason})`),
      ...event.clarify.map((x) => `되물을 것: ${x}`),
    ];
    return parts.length ? parts.join(' / ') : '(처리할 것 없음)';
  }

  get calls(): number {
    return this.t2fCalls + this.t1Calls;
  }
}
