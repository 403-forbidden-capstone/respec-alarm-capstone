// 보고서 (마크다운) — 사람 × 날짜 줄마다 PR 코드 · 쓴 씨앗 · 상황 이름, 밤 대화, 위치 조정 표, 기능 확인 표, 질문 예산, 버그 후보
import type { AdjustRow } from './adjust-runs.ts';
import { BUDGET_PER_DAY, BUDGET_PER_WEEK } from './coach.ts';
import { isOversleeper, oversleepDayNumber } from './day.ts';
import { scheduledDays } from './persona.ts';
import type { BugCandidate, ChecksOutput } from './checks.ts';
import type { LedgerSummary } from './ledger.ts';
import { hm } from './time.ts';
import type { DayArtifact, WeekResult } from './week.ts';

export interface ReportInput {
  command: string;
  codeLabel: string; // 앱 코드 번호 칸 — main@커밋 7자리 (PR 코드면 그 브랜치)
  seed: string;
  days: number;
  weeks: WeekResult[];
  adjust: Record<string, AdjustRow[]>;
  checks: ChecksOutput;
  ledger: LedgerSummary;
  startedAt: string;
}

const LEVEL = ['약', '보통', '강'] as const;
const t = (iso: string | null | undefined): string => (iso ? hm(new Date(iso)) : '—');
const SRC: Record<string, string> = { LOCATION: '위치', BUTTON: '원탭', MANUAL: '직접', USAGE: '폰사용' };
const yn = (b: boolean | null | undefined): string => (b === true ? '예' : b === false ? '아니오' : '—');
const esc = (s: string): string => s.replace(/\|/g, '\\|');
const cell = (s: string | number | null | undefined): string => esc(String(s ?? '—'));

function alarmCell(d: DayArtifact): string {
  const tr = d.truth;
  return tr.alarmWakeAt ? t(tr.alarmWakeAt) : `없음(${tr.noAlarmReason ?? '?'})`;
}

function tripsCell(d: DayArtifact, f: (tr: DayArtifact['record']['trips'][number]) => string): string {
  return d.record.trips.length ? d.record.trips.map(f).join(' / ') : '—';
}

function dayRow(personaId: string, codeLabel: string, d: DayArtifact): string {
  const r = d.record;
  const level = r.alarmLevel != null ? LEVEL[r.alarmLevel] : '—';
  const dep = tripsCell(d, (x) => `${t(x.trueDepart)}→${t(x.recordedDepart)}${x.departSource ? `(${SRC[x.departSource]})` : ''}`);
  const arr = tripsCell(d, (x) => `${t(x.trueArrive)}→${t(x.recordedArrive)}${x.arriveSource ? `(${SRC[x.arriveSource]})` : ''}`);
  const late = tripsCell(d, (x) => `${x.trulyLate ? `진짜 ${Math.round(x.trueLateMin)}분 지각` : '정시'}/앱 ${x.isLate === true ? `지각 ${x.lateMinutes}분` : x.isLate === false ? '정시' : '—'}`);
  const cards = d.night.cards.length ? d.night.cards.map((c) => `${c.title}:${c.status === 'SAVED' ? '저장' : c.status === 'REJECTED' ? '거절' : c.status}`).join(', ') : '카드 없음';
  return `| ${personaId} | ${d.world.date}(${d.world.weekday}) | ${cell(codeLabel)} | ${cell(d.seed)} | ${cell(d.world.situation ?? '깔끔한 날')} | ${cell(cards)} | ${cell(alarmCell(d))} | ${level} | ${cell(r.actualPrepareMinutes != null ? `${r.actualPrepareMinutes}분` : '—')} | ${cell(dep)} | ${cell(arr)} | ${cell(late)} | ${r.oneTapCount} | ${d.night.questionsAsked} |`;
}

function nightBlock(personaId: string, d: DayArtifact): string[] {
  const n = d.night;
  const out: string[] = [`**${personaId} ${n.forDate}(${d.world.weekday}) 맞춘 밤 — ${n.now.slice(0, 16).replace('T', ' ')}**`];
  out.push(`- 확인할 기록 ${n.facts}줄${n.feedback.length ? '' : ' · 정정 없음'}`);
  for (const f of n.feedback) {
    out.push(`  - 정정 ${f.factId} ${f.kind} ${t(f.recorded)}→(진짜 ${t(f.truth)}) ${f.status}${f.to ? ` ${t(f.to)}` : ''} → ${f.fix ? (f.fix.ok ? '반영됨' : `못 함(${f.fix.error})`) : '정정 요청 없음'}`);
  }
  for (const c of n.cards) out.push(`- 카드 ${c.id} [${c.kind}] ${c.title}: ${c.status}${c.wakeAt ? ` · 기상 ${t(c.wakeAt)} ${c.level != null ? LEVEL[c.level] : ''}` : ''}${c.note ? ` · ${c.note}` : ''}`);
  if (n.question) out.push(`- 서버 질문 ${n.question.kind}: "${n.question.text}" → 답: ${n.question.answer}`);
  out.push(`- 질문 수 ${n.questionsAsked} (같은 날 ${n.budget.sameDay} · 7일 ${n.budget.last7Days})`);
  if (n.lines.length) out.push(`- 서버 처리 줄(T1 글 대신): ${n.lines.map((l) => l.replace(/\n/g, ' ')).join(' ⏐ ')}`);
  return out;
}

export function renderReport(input: ReportInput): string {
  const L: string[] = [];
  const bugs: { b: BugCandidate; n: number }[] = [];
  const addBug = (where: string, whatRaw: string, source: string) => {
    const what = whatRaw.replace(/정정 x\d+:/, '정정:').replace(/카드 c\d+/, '카드');
    const found = bugs.find((x) => x.b.where === where && x.b.what === what);
    if (found) found.n++;
    else bugs.push({ b: { where, what, source }, n: 1 });
  };
  for (const b of input.checks.bugs) addBug(b.where, b.what, b.source);

  L.push(`# sim-week 기능 모드 보고서`);
  L.push('');
  L.push(`- 실행: \`${input.command}\` (${input.startedAt})`);
  L.push(`- 앱 코드 번호: ${input.codeLabel} · 사람 ${input.weeks.map((w) => w.persona.id).join(' · ')} · ${input.days}일치 · 씨앗 "${input.seed}"`);
  L.push(`- 모드: ${input.ledger.note}. 가짜 모델 호출 ${input.ledger.calls}회(규칙 출력) · 실제 모델 호출 0 · 누적 $${input.ledger.spentUsd.toFixed(4)} · --budget ${input.ledger.budgetUsd ?? '없음'}(표시만)`);
  L.push('');

  L.push('## 사람 × 날짜');
  L.push('');
  L.push('시각은 KST. 출발 · 도착은 "진짜→앱 기록(출처)", 기록이 없으면 —. 질문 = 그날 알람을 맞춘 전날 밤의 서버 질문 수. 카드 = 전날 밤 대화에서 저장 · 거절.');
  L.push('');
  L.push('| 사람 | 날짜 | PR 코드 | 쓴 씨앗 | 상황 | 카드(전날 밤) | 기상 알람 | 강도 | 준비(기상~출발) | 출발 | 도착 | 지각 | 원탭 필요 | 질문 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const w of input.weeks) for (const d of w.days) L.push(dayRow(w.persona.id, input.codeLabel, d));
  L.push('');

  L.push('## 밤 대화 (글 없이 — 카드 · 정정 · 질문)');
  L.push('');
  for (const w of input.weeks) {
    for (const d of w.days) {
      L.push(...nightBlock(w.persona.id, d));
      L.push('');
      for (const b of d.night.bugs) addBug(b.split(' — ')[1] ?? 'coach.ts', b.split(' — ')[0], `${w.persona.id} ${d.night.forDate}`);
    }
  }

  L.push('## 위치 조정 표 (같은 씨앗, 값만 바꿈)');
  L.push('');
  for (const w of input.weeks) {
    const rows = input.adjust[w.persona.id] ?? [];
    L.push(`**${w.persona.id}** (${w.days.length}일, 이동 ${rows[0]?.trips ?? 0}건)`);
    L.push('');
    L.push('| 값 | 변경 | 출발 기록 | 도착 기록 | 출발 오차(분) | 도착 오차(분) | 앱 지각 | 진짜 지각 | 오판 | 원탭 필요 |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) L.push(`| ${r.group} | ${cell(r.label)} | ${r.departRecorded} | ${r.arriveRecorded} | ${r.avgDepartErrMin ?? '—'} | ${r.avgArriveErrMin ?? '—'} | ${r.appLate} | ${r.trulyLate} | ${r.misjudge} | ${r.oneTap} |`);
    L.push('');
  }

  L.push('## 기능 확인 표 (학습루프_기초_1030.md 5절)');
  L.push('');
  L.push('| # | 상황 | 입력 | 기대값 | 하네스 결과 | 일치? |');
  L.push('|---|---|---|---|---|---|');
  for (const r of input.checks.rows) {
    const ok = r.ok === null ? '7일 시험에서 확인' : r.ok ? '예' : '아니오';
    L.push(`| ${r.no === 5.5 ? '5b' : r.no} | ${cell(r.situation)} | ${cell(r.input)} | ${cell(r.expected)} | ${cell(r.result)}${r.note ? ` (${cell(r.note)})` : ''} | ${ok} |`);
  }
  L.push('');

  L.push('## 질문 예산 (D104 · 7.15: 하루 1 · 주 3)');
  L.push('');
  for (const w of input.weeks) {
    const nights = w.days.map((d) => d.night);
    const total = nights.reduce((s, n) => s + n.questionsAsked, 0);
    const maxDay = Math.max(0, ...nights.map((n) => n.questionsAsked));
    const bad = nights.flatMap((n) => n.budget.violations);
    L.push(`- ${w.persona.id}: 질문 ${total}개 (하루 최대 ${maxDay}, 한도 ${BUDGET_PER_DAY}/${BUDGET_PER_WEEK}) → ${bad.length ? `위반 ${bad.length}건` : '위반 없음'} · 원탭이 필요했던 수 ${w.days.reduce((s, d) => s + d.record.oneTapCount, 0)}`);
  }
  L.push('');

  L.push('## 늦잠 (자격 인물 주 1회, 그 사람의 일정이 있는 날 중)');
  L.push('');
  for (const w of input.weeks) {
    const p = w.persona;
    if (!isOversleeper(p)) { L.push(`- ${p.id}: 대상 아님 (chronotype ${p.chronotype} · 취침 ${p.sleep_pattern})`); continue; }
    const target = oversleepDayNumber(p);
    if (target == null) { L.push(`- ${p.id}: 주 0회(일정 없음)`); continue; }
    const hit = w.days.filter((d) => d.truth.overslept > 0).map((d) => `${d.world.day}일차 ${d.world.date}(${d.world.weekday})`);
    const note = hit.length ? hit.join(', ') : target > w.days.length ? `${target}일차 예정 — 이번 실행(${w.days.length}일)에 안 닿음` : `${target}일차 예정인데 그날 앱 알람이 없어 안 걸림`;
    L.push(`- ${p.id}: 주 1회 (일정 있는 날 ${scheduledDays(p).join('·')}일차 중 ${target}일차) → ${note}`);
  }
  L.push('');

  L.push('## 앱 판정 오판 (진짜와 다르게 본 것 — 버그가 아니라 설계 한계일 수 있음)');
  L.push('');
  const mis: Record<string, string[]> = {};
  for (const w of input.weeks) {
    for (const d of w.days) {
      for (const tr of d.obs.trips) for (const m of tr.misjudge) (mis[m] ??= []).push(`${w.persona.id} ${d.world.date}${d.world.situation ? `(${d.world.situation})` : ''}`);
    }
  }
  if (!Object.keys(mis).length) L.push('- 없음');
  for (const [name, where] of Object.entries(mis)) L.push(`- ${name} ${where.length}번: ${where.join(', ')}`);
  L.push('');

  L.push('## 버그 후보');
  L.push('');
  if (!bugs.length) L.push('- 없음');
  for (const { b, n } of bugs) L.push(`- ${b.where} — ${b.what}${n > 1 ? ` (${n}번)` : ''} [${b.source}]`);
  L.push('');
  L.push('## 이번 하네스가 안 하는 것');
  L.push('');
  L.push('- 모델 호출 · 대화 글(T1 · 사람 말) · 7일 본 시험 · p09~p12. 못 부른 L2 함수와 이유는 `tools/sim-week/docs.md`.');
  L.push('');
  return L.join('\n');
}
