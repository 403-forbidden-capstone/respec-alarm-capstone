// 단계 실행기 — 단계마다 PASS / FAIL / SKIP을 정함 (네트워크 없음, 시험 가능)
//   PASS  끝까지 확인됨 (생략한 확인이 있으면 notes에 적음)
//   FAIL  있는 기능이 대본대로 안 됨
//   SKIP  아직 없는 기능이거나 앞 단계가 안 돼서 못 함 (이유를 적음)
export class Skip extends Error {}
export class Fail extends Error {}

export const skip = (reason) => {
  throw new Skip(reason);
};

// 조건이 거짓이면 FAIL
export function must(cond, msg) {
  if (!cond) throw new Fail(msg);
}

// supabase-js 응답에서 오류면 FAIL, 아니면 data
export function ok(res, what) {
  if (res.error) throw new Fail(`${what}: ${res.error.message}`);
  return res.data;
}

// step: { n, who, screen, action, expect, ch, deps?: number[], run(ctx) }
// ctx.note(msg)로 "생략한 확인"을 남김. run 안에서 skip() / must() 사용
export async function runSteps(steps, ctx, { log = () => {} } = {}) {
  const results = [];
  const byN = new Map();
  for (const step of steps) {
    const notes = [];
    ctx.note = (m) => notes.push(m);
    let status = 'PASS';
    let reason = '';
    const blocker = (step.deps ?? []).map((d) => byN.get(d)).find((r) => r && r.status !== 'PASS');
    if (blocker) {
      status = 'SKIP';
      reason = `앞 단계 ${blocker.n}이(가) ${blocker.status}`;
    } else {
      try {
        await step.run(ctx);
      } catch (e) {
        if (e instanceof Skip) {
          status = 'SKIP';
          reason = e.message;
        } else if (e instanceof Fail) {
          status = 'FAIL';
          reason = e.message;
        } else {
          status = 'FAIL';
          reason = `예기치 않은 오류: ${e?.message ?? e}`;
        }
      }
    }
    const r = { n: step.n, who: step.who, ch: step.ch, action: step.action, status, reason, notes };
    results.push(r);
    byN.set(step.n, r);
    log(r);
  }
  return results;
}

export function summarize(results) {
  const count = { PASS: 0, FAIL: 0, SKIP: 0 };
  for (const r of results) count[r.status]++;
  const firstFail = results.find((r) => r.status === 'FAIL');
  const firstBlocked = results.find((r) => r.status !== 'PASS');
  return { count, firstFail, firstBlocked };
}

// 친구_개발현황.md 시나리오 표에 붙일 줄
export function statusRow(results, { date, main }) {
  const { count, firstBlocked } = summarize(results);
  const first = firstBlocked ? `${firstBlocked.n} ${firstBlocked.status}${firstBlocked.reason ? `: ${firstBlocked.reason}` : ''}` : '없음';
  return `| ${date} | ${main} | PASS ${count.PASS} / FAIL ${count.FAIL} / SKIP ${count.SKIP} | ${first} |`;
}

export function reportMarkdown(results, { date, main }) {
  const { count } = summarize(results);
  const lines = [
    `# 친구 대본 자동 시험 — ${date} (main ${main})`,
    '',
    `PASS ${count.PASS} / FAIL ${count.FAIL} / SKIP ${count.SKIP} (37단계)`,
    '',
    '| 단계 | 누가 | 장 | 결과 | 이유 · 생략한 확인 |',
    '|---|---|---|---|---|',
  ];
  for (const r of results) {
    const why = [r.reason, ...r.notes.map((n) => `(생략) ${n}`)].filter(Boolean).join(' / ');
    lines.push(`| ${r.n} | ${r.who} | ${r.ch} | ${r.status} | ${why.replace(/\|/g, '/')} |`);
  }
  return lines.join('\n') + '\n';
}
