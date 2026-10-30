// 가상 유저 일주일 시험 하네스 실행기 (기능 모드 — 모델 호출 없음)
//   node tools/sim-week/run.ts --personas p01,p02 --days 1 --fake [--app-root <경로>] [--report <경로>] [--seed 글자] [--budget 달러] [--code-label 글자]
//   --days N 또는 1..N (1일째부터 이어서 N일까지. 학습이 이월되므로 중간부터는 시작 안 함)
//   --fake = 기능 모드(기본, 지금은 이것만). --live 는 거절 (실수 방지)
//   --app-root 는 bridge.ts 가 읽음 (앱 코드를 PR 브랜치를 합친 worktree 로 바꿔 부를 때)
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { runAdjust, type AdjustRow } from './adjust-runs.ts';
import { APP_ROOT, HERE, REPO } from './bridge.ts';
import { runChecks } from './checks.ts';
import { Ledger } from './ledger.ts';
import { PERSONA_IDS, loadPersonas } from './persona.ts';
import { renderReport } from './report.ts';
import { runWeek, type WeekResult } from './week.ts';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

// 앱 코드 번호 칸 — 앱 코드(mobile · supabase)가 origin/main 과 같으면 main@커밋 7자리, 다르면 그 브랜치 (PR 코드)
function codeLabel(): string {
  const given = flag('code-label');
  if (given) return given;
  const git = (...args: string[]) => execFileSync('git', ['-C', APP_ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const head = git('rev-parse', '--short=7', 'HEAD');
    let main7: string | null = null;
    try {
      main7 = git('rev-parse', '--short=7', 'origin/main');
    } catch {
      main7 = null;
    }
    let same = false;
    try {
      git('diff', '--quiet', 'origin/main', '--', 'mobile', 'supabase');
      same = true;
    } catch {
      same = false;
    }
    if (same && main7) return `main@${main7}`;
    return `PR코드@${head} (origin/main@${main7 ?? '?'}과 앱 코드가 다름${APP_ROOT === REPO ? '' : `: ${APP_ROOT}`})`;
  } catch {
    return '코드 번호 모름(git 못 읽음)';
  }
}

function parseDays(raw: string | undefined): number {
  if (!raw) return 1;
  const m = /^(?:1\.\.)?(\d+)$/.exec(raw);
  if (!m) throw new Error(`--days 는 N 또는 1..N (받은 값: ${raw}) — 학습이 이월돼서 1일째부터만 돌림`);
  const n = Number(m[1]);
  if (n < 1 || n > 7) throw new Error('--days 는 1~7');
  return n;
}

async function main() {
  if (has('live')) throw new Error('이번 하네스는 기능 모드(--fake)만 지원해요. --live(모델 실호출)는 아직 없어요.');
  const days = parseDays(flag('days'));
  const personaIds = (flag('personas') ?? 'p01').split(',').map((x) => x.trim()).filter(Boolean);
  const personas = loadPersonas(personaIds.length ? personaIds : [PERSONA_IDS[0]]);
  const seed = flag('seed') ?? 'sim';
  const budgetRaw = flag('budget');
  const ledger = new Ledger({ mode: 'FEATURE', budgetUsd: budgetRaw != null ? Number(budgetRaw) : null });
  const startedAt = new Date().toISOString();
  const code = codeLabel();

  const weeks: WeekResult[] = [];
  const adjust: Record<string, AdjustRow[]> = {};
  for (const p of personas) {
    const week = await runWeek({ persona: p, days, seed, ledger });
    weeks.push(week);
    adjust[p.id] = runAdjust(p, week.days);
  }
  const checks = await runChecks({ days });
  const command = `node tools/sim-week/run.ts ${process.argv.slice(2).join(' ')}`.trim();
  const md = renderReport({ command, codeLabel: code, seed, days, weeks, adjust, checks, ledger: ledger.summary(), startedAt });

  const stamp = startedAt.replace(/[:.]/g, '-');
  const out = resolve(flag('report') ?? resolve(HERE, 'runs', `sim-week-${stamp}.md`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md, 'utf8');

  // 콘솔 요약
  console.log(`sim-week 기능 모드 — 앱 코드 ${code} · 사람 ${personas.map((p) => p.id).join(',')} · ${days}일 · 씨앗 ${seed}`);
  for (const w of weeks) {
    for (const d of w.days) {
      const r = d.record;
      const trip = r.trips[0];
      console.log(
        [
          w.persona.id,
          r.date,
          `상황 ${r.situation ?? '깔끔'}`,
          `알람 ${d.truth.alarmWakeAt ? d.truth.alarmWakeAt.slice(11, 16) : '없음'}`,
          `출발 ${trip?.trueDepart?.slice(11, 16) ?? '—'}→${trip?.recordedDepart?.slice(11, 16) ?? '—'}`,
          `도착 ${trip?.trueArrive?.slice(11, 16) ?? '—'}→${trip?.recordedArrive?.slice(11, 16) ?? '—'}`,
          `지각 진짜 ${r.late ? '예' : '아니오'}/앱 ${r.appLate ? '예' : '아니오'}`,
          `원탭 ${r.oneTapCount}`,
          `질문 ${d.night.questionsAsked}`,
        ].join(' | '),
      );
    }
  }
  console.log('기능 확인 표:');
  for (const row of checks.rows) console.log(`  ${row.no === 5.5 ? '5b' : row.no}. ${row.situation} → ${row.ok === null ? '7일 시험에서 확인' : row.ok ? '일치' : '불일치'}: ${row.result}`);
  console.log(`보고서: ${out}`);
}

main().catch((e) => {
  console.error(`오류: ${(e as Error).message}`);
  process.exit(1);
});
