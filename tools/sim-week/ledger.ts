// 누적 $ 장부 — 기능 모드에서는 모델을 안 부르므로 늘 0원 · 0회.
//   인터페이스(record · assertCanSpend · summary)는 실호출 모드 자리 표시: 나중에 live 클라이언트가 같은 장부에 돈을 적고,
//   --budget(상한 $)을 넘으면 즉시 멈추도록 쓸 자리. 지금은 상한을 받아서 보고서에 표시만 함.
export type LedgerMode = 'FEATURE' | 'LIVE';

export interface LedgerEntry {
  label: string; // 어떤 호출인지 (예: 'sim-user', 'T1')
  usd: number;
}

export interface LedgerSummary {
  mode: LedgerMode;
  budgetUsd: number | null; // --budget 값 (없으면 null)
  spentUsd: number;
  calls: number;
  note: string;
}

export class BudgetExceeded extends Error {
  constructor(spent: number, budget: number) {
    super(`누적 비용 $${spent.toFixed(4)} 가 상한 $${budget.toFixed(2)} 를 넘음 — 즉시 멈춤`);
  }
}

export class Ledger {
  readonly mode: LedgerMode;
  readonly budgetUsd: number | null;
  private spent = 0;
  private entries: LedgerEntry[] = [];

  constructor(opts: { mode?: LedgerMode; budgetUsd?: number | null } = {}) {
    this.mode = opts.mode ?? 'FEATURE';
    this.budgetUsd = opts.budgetUsd ?? null;
  }

  // 돈이 드는 호출 하나를 적음. 기능 모드에서 0원 아닌 값이 오면 버그(모델을 부른 것)라 던짐
  record(label: string, usd: number): void {
    if (this.mode === 'FEATURE' && usd !== 0) throw new Error(`기능 모드에서 비용이 생김: ${label} $${usd}`);
    this.entries.push({ label, usd });
    this.spent += usd;
    if (this.budgetUsd != null && this.spent > this.budgetUsd) throw new BudgetExceeded(this.spent, this.budgetUsd);
  }

  // 호출 전 검사 (실호출 모드 자리) — 예상 비용을 더하면 상한을 넘는지
  assertCanSpend(estimateUsd: number): void {
    if (this.mode === 'FEATURE') return;
    if (this.budgetUsd != null && this.spent + estimateUsd > this.budgetUsd) throw new BudgetExceeded(this.spent + estimateUsd, this.budgetUsd);
  }

  summary(): LedgerSummary {
    return {
      mode: this.mode,
      budgetUsd: this.budgetUsd,
      spentUsd: this.spent,
      calls: this.entries.length,
      note: this.mode === 'FEATURE' ? '기능 모드: 모델 호출 없음 — 상한은 표시만 (실호출 모드 자리 표시)' : '실호출 모드',
    };
  }
}
