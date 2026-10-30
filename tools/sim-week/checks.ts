// 기능 확인 표 — 학습루프_기초_1030.md 5절의 6줄을 "입력 → 기대값 → 하네스 결과 → 일치?"로
//   하네스가 앱의 L1 계산(computePlan, l1.ts planAppt)에 입력을 넣고 나온 값을 읽음. 기대값은 문서 값 그대로 (결과에 맞춰 바꾸지 않음).
//   일치?가 "아니오"이면 버그 후보로 올림(어느 코드 · 줄). 여러 날이 필요한 줄은 일수가 모자라면 "7일 시험에서 확인".
import { calc } from './bridge.ts';
import { planAppt, prepareLabel, statsFrom } from './l1.ts';
import { worldDay, loadPersonas } from './persona.ts';
import { addMin } from './time.ts';
import type { AppAppt, Importance, PlanSummary } from './types.ts';

export interface CheckRow {
  no: number;
  situation: string; // 문서 5절 "상황"
  input: string;
  expected: string;
  result: string;
  ok: boolean | null; // null = 이 실행에서는 못 봄
  note: string | null;
}

export interface BugCandidate {
  where: string; // 파일:줄
  what: string;
  source: string; // 어느 표 · 어느 줄에서 보였나
}

export interface ChecksOutput {
  rows: CheckRow[];
  bugs: BugCandidate[];
}

// ---- 계산 도우미: p01 월요일 10:30 수업 하나를 기준으로 입력만 바꿔 부름 ----
// 하루에 움직이는 폭 상한 — roll.ts PREPARE_DAILY_STEP_MAX (서버 파일이 supabase 클라이언트를 끌어와 Node에서 안 불러, 값만 옮김)
const PREPARE_DAILY_STEP_MAX = 10;
const NIGHT_BEFORE = (a: AppAppt) => addMin(a.at, -12 * 60);

async function planWith(o: { importance?: Importance; sameDayWake?: boolean; records?: readonly number[]; lateCount4w?: number; defaultPrepare?: number | null; prepareBound?: { around: number; within: number }; wakeSensitivity?: 'LIGHT' | 'NORMAL' | 'HEAVY'; wakeMargin?: 'TIGHT' | 'NORMAL' | 'LOOSE' }): Promise<PlanSummary> {
  const p = loadPersonas(['p01'])[0];
  const world = worldDay(p, 0);
  const wa = world.appts[0];
  const appt: AppAppt = {
    id: 'chk', worldId: wa.id, title: wa.title, date: wa.date, time: wa.time, at: wa.at, dest: wa.place, importance: o.importance ?? 'NORMAL', importanceSource: 'SAID',
    transport: 'TRANSIT', bufferMinutes: 15, overrides: {}, items: [], plan: null, saved: false, savedVia: null,
  };
  const { summary } = await planAppt(appt, {
    now: NIGHT_BEFORE(appt),
    profile: { bufferMinutes: 15, defaultTransport: 'TRANSIT', home: world.home, defaultPrepareMinutes: o.defaultPrepare === undefined ? null : o.defaultPrepare, wakeSensitivity: o.wakeSensitivity ?? null, wakeMargin: o.wakeMargin ?? null },
    learned: { stats: statsFrom([...(o.records ?? [])].reverse()), lateCount4w: o.lateCount4w ?? 0, travelSamples: [] },
    sameDayWake: o.sameDayWake ?? false,
    kakaoMinutes: 58,
    ...(o.prepareBound ? { prepareBound: o.prepareBound } : {}),
  });
  return summary;
}

const wakeToDepart = (s: PlanSummary): number | null => (s.wakeAt ? Math.round((s.departAt.getTime() - s.wakeAt.getTime()) / 60_000) : null);
const LEVEL_NAME = ['약', '보통', '강'] as const;

export async function runChecks(opts: { days: number }): Promise<ChecksOutput> {
  const rows: CheckRow[] = [];
  const bugs: BugCandidate[] = [];

  // 1. 기록 0건, 온보딩 70분 · 보통
  {
    const s = await planWith({ defaultPrepare: 70 });
    const mins = wakeToDepart(s);
    const label = prepareLabel(s.prepareBasis.n);
    const ok = mins === 70 && s.prepareSource === 'DEFAULT' && label === '배우는 중 0/5';
    rows.push({
      no: 1, situation: '기록 0건, 온보딩 70분 · 보통', input: '기록 없음 · default_prepare_minutes 70 · 잠귀 보통(기본)',
      expected: '기상~출발 70분, 출처 첫 값(DEFAULT), "배우는 중 0/5"',
      result: `기상~출발 ${mins}분 · 출처 ${s.prepareSource} · "${label}" · 강도 ${LEVEL_NAME[s.level]}`, ok, note: null,
    });
    if (!ok) bugs.push({ where: 'supabase/functions/_shared/plan-core.ts computePlan의 predictPrepare 입력 · firstPrepareMinutes', what: `온보딩 첫 값 70분이 계산에 안 닿음 (기상~출발 ${mins}분)`, source: '표 1줄' });
  }

  // 2. 매일 실제 85분 (온보딩 70분) — 여러 날 필요
  if (opts.days < 6) {
    rows.push({
      no: 2, situation: '매일 실제 85분 (온보딩 70분)', input: '매일 기상~출발 실측 85분이 쌓임, 반복 회차마다 다시 계산',
      expected: '매 회차 +10분 넘게 안 움직임, 5일차부터 "내 기록 기반 5건"',
      result: '7일 시험에서 확인', ok: null, note: `이번 실행은 ${opts.days}일치 — 기록 5건이 쌓인 뒤 계산(6번째 알람)까지 못 봄`,
    });
  } else {
    const series: { n: number; minutes: number; label: string }[] = [];
    const records: number[] = [];
    let prev: number | null = null;
    for (let k = 0; k < 8; k++) {
      const s = await planWith({ defaultPrepare: 70, records, prepareBound: prev == null ? undefined : { around: prev, within: PREPARE_DAILY_STEP_MAX } });
      series.push({ n: s.prepareBasis.n, minutes: s.prepareMinutes, label: prepareLabel(s.prepareBasis.n) });
      prev = s.prepareMinutes;
      records.push(85);
    }
    const steps = series.slice(1).map((x, i) => x.minutes - series[i].minutes);
    const maxStep = Math.max(...steps.map(Math.abs));
    const firstPersonal = series.findIndex((x) => x.label.startsWith('내 기록 기반'));
    const ok = maxStep <= 10 && firstPersonal === 5 && series[5].label === '내 기록 기반 5건';
    rows.push({
      no: 2, situation: '매일 실제 85분 (온보딩 70분)', input: '매일 기상~출발 85분 기록, 회차마다 prepareBound ±10 로 다시 계산 (alarm-roll 과 같은 입력)',
      expected: '매 회차 +10분 넘게 안 움직임, 5일차부터 "내 기록 기반 5건"',
      result: `준비 ${series.map((x) => x.minutes).join(' → ')}분 (최대 ${maxStep}분 움직임) · 기록 5건 뒤 계산부터 "${series[5].label}"`, ok,
      note: '"5일차부터"는 기록 5건이 쌓인 뒤 첫 계산(6번째 알람)으로 읽음 — 문서가 날 번호를 안 정함',
    });
    if (!ok) bugs.push({ where: 'supabase/functions/_shared/plan-core.ts clampPrepareToBound · calc/prepare.ts predictPrepare', what: `회차 변화 최대 ${maxStep}분 / 내 기록 출처 시작 인덱스 ${firstPersonal}`, source: '표 2줄' });
  }

  // 3. 같은 기록, 빠듯 / 넉넉
  {
    const records = [60, 70, 80, 90, 100, 75, 85];
    const q = [0.7, 0.8, 0.9].map((p) => Math.round(calc.percentile(records, p) as number));
    // 깨우는 여유(profiles.wake_margin) TIGHT · NORMAL · LOOSE를 계산 입력(profile.wake_margin)으로 실제로 바꿔 세 번 부름 (#274)
    const margins = ['TIGHT', 'NORMAL', 'LOOSE'] as const;
    const plans = [] as PlanSummary[];
    for (const m of margins) plans.push(await planWith({ defaultPrepare: 70, records, wakeMargin: m }));
    const mins = plans.map((x) => x.prepareMinutes);
    const increasing = mins[0] < mins[1] && mins[1] < mins[2];
    rows.push({
      no: 3, situation: '같은 기록, 빠듯 / 넉넉', input: `같은 기록 ${records.join(' · ')}분(7건), 깨우는 여유 빠듯(TIGHT) · 보통(NORMAL) · 넉넉(LOOSE)`,
      expected: '넉넉이 더 이름 (0.7 < 0.8 < 0.9 분위수 → 준비 시간 빠듯 < 보통 < 넉넉)',
      result: `빠듯 ${mins[0]} · 보통 ${mins[1]} · 넉넉 ${mins[2]}분 (기상~출발 ${plans.map((x) => wakeToDepart(x)).join(' · ')}분). 참고: 기록 분위수 0.7 · 0.8 · 0.9 = ${q.join(' · ')}분, 개인 보정은 기록 7건이라 7/17 비중으로 섞임`,
      ok: increasing, note: null,
    });
    if (!increasing) bugs.push({ where: 'supabase/functions/_shared/plan-core.ts computePlan의 predictPrepare 입력 (personalPrepareOf · wakeMarginOf) · calc/prepare.ts personalPrepareOf', what: `빠듯/보통/넉넉이 빠듯 < 보통 < 넉넉으로 안 나옴 (${mins.join(' · ')}분)`, source: '표 3줄' });
  }

  // 4. 그날 두 번째 일정
  {
    const a = await planWith({ sameDayWake: true, records: [], defaultPrepare: 70 });
    const b = await planWith({ sameDayWake: true, records: Array.from({ length: 12 }, (_, i) => 80 + i), defaultPrepare: 70 });
    const ok = a.prepareMinutes === 15 && b.prepareMinutes === 15;
    rows.push({
      no: 4, situation: '그날 두 번째 일정', input: '기상 알람이 이미 있는 날의 두 번째 일정 · 기록 0건 / 12건',
      expected: '준비 15분 그대로 (기록 수와 상관없음)',
      result: `기록 0건 → ${a.prepareMinutes}분(${a.prepareSource}) · 기록 12건 → ${b.prepareMinutes}분(${b.prepareSource}, n=${b.prepareBasis.n})`, ok, note: null,
    });
    if (!ok) bugs.push({ where: 'supabase/functions/_shared/plan-core.ts computePlan의 withWake 분기(commonP80 · personalPrepareOf)', what: '두 번째 일정 준비가 기록에 따라 변함', source: '표 4줄' });
  }

  // 5. 잠귀 깊음 · 매우 중요 · 최근 지각 2번
  {
    const strong = await planWith({ importance: 'HIGH', lateCount4w: 2, wakeSensitivity: 'HEAVY' });
    const stronger = await planWith({ importance: 'HIGH', lateCount4w: 5, wakeSensitivity: 'HEAVY' });
    const ok = strong.level === 2 && stronger.level === 2;
    rows.push({
      no: 5, situation: '잠귀 깊음 · 매우 중요 · 최근 지각 2번', input: '잠귀 깊음(HEAVY) · 중요도 매우 중요 · 4주 지각 2번 (5번도 봄)',
      expected: '강 (최대 강에서 멈춤)',
      result: `강도 ${LEVEL_NAME[strong.level]} (지각 5번이어도 ${LEVEL_NAME[stronger.level]})`, ok,
      note: '이 줄의 "강"은 매우 중요 + 지각 2번만으로도 나옴 — 잠귀만의 효과는 5b에서 따로 봄',
    });
    if (!ok) bugs.push({ where: 'supabase/functions/_shared/calc/intensity.ts autoLevel', what: '강도가 최대 강으로 안 멈추거나 올림 규칙 어긋남', source: '표 5줄' });

    // 5b: 잠귀 깊음 단독 — 문서 D69: 가벼움 · 보통 → 보통, 깊음 → 강
    const heavy = await planWith({ importance: 'LOW', lateCount4w: 0, wakeSensitivity: 'HEAVY' });
    const okB = heavy.level === 2;
    rows.push({
      no: 5.5, situation: '(5b) 잠귀 깊음만, 보통 일정 · 지각 없음', input: '잠귀 깊음(HEAVY) · 중요도 보통 · 지각 0번',
      expected: '강 (D69 · 학습루프 1절 ①: 깊음 → 기본 강도 강)',
      result: `강도 ${LEVEL_NAME[heavy.level]}`, ok: okB, note: '표 5절 6줄 밖의 추가 확인 — 잠귀 입력은 #274(학습 기초 b)부터 계산이 읽음',
    });
    if (!okB) bugs.push({ where: 'supabase/functions/_shared/plan-core.ts computePlan의 wakeSensitivityOf → autoLevel · resolveIntensity 입력 · calc/intensity.ts autoLevel', what: '잠귀 깊음만으로는 강으로 안 올라감', source: '표 5b' });
  }

  // 6. 잠귀 가벼움 · 보통 일정
  {
    const low = await planWith({ importance: 'LOW', wakeSensitivity: 'NORMAL' });
    const normal = await planWith({ importance: 'NORMAL', wakeSensitivity: 'NORMAL' });
    const ok = low.level === 1 && normal.level === 1;
    rows.push({
      no: 6, situation: '잠귀 가벼움 · 보통 일정', input: '잠귀 가벼움 · 중요도 보통(LOW) / 중요(NORMAL) · 지각 없음',
      expected: '보통 (약 아님)',
      result: `보통 일정 → ${LEVEL_NAME[low.level]} · 중요 일정 → ${LEVEL_NAME[normal.level]}`, ok, note: null,
    });
    if (!ok) bugs.push({ where: 'supabase/functions/_shared/calc/intensity.ts autoLevel', what: '기본 강도가 보통이 아님', source: '표 6줄' });
  }

  return { rows, bugs };
}
