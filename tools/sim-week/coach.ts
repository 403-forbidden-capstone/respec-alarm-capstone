// 코치 (밤 대화, 글 없이) — 서버 대화 로직을 모델 없이 흉내 낸다.
//   서버 순수 함수(supabase/functions/_shared/ai/turn-core.ts · context-core.ts)를 그대로 부름. 모델 자리에만 가짜가 들어감:
//     문맥(context-core.buildContext) ← 앱이 아는 약속 · 알람 · 어제 기록(DB 행 모양)
//     턴 1 · 확인할 기록에 반응: sim-user 정정 → T2F(가짜, fact_feedback) → applyFast → 앱 일(정정 반영) → applyTaskResults
//     턴 2 · 내일 일정 말하기: T2F(가짜, appointments) → applyFast → 앱 일(카드 계산 = L1 computePlan) → applyTaskResults
//     카드 [저장] · [거절]: sim-user 수락 확률 → applyCardAction → 앱이 약속 · 알람 저장
//     서버 질문(pickServerQuestion, 하루 1 · 주 3) → 답 → 턴 3: 준비시간 가감 카드 → 같은 길
//   앱 일 = 앱이 L1 · L2 함수로 하는 일: 카드 알람 계산(l1.planAppt) · 기록 정정(location.correctRecordTime)
//   질문 예산은 서버 고르기(pickServerQuestion)와 따로, 기록(app.asked)만 보고 다시 셈 — 어기면 버그 후보로 표시
import { aiContext, aiTurn } from './bridge.ts';
import { learnedAt, type AppState, type AskedQuestion } from './app-state.ts';
import { FakeLlm } from './fake-llm.ts';
import { hasEarlierWake, planAppt } from './l1.ts';
import { correctRecordTime } from './location.ts';
import type { Ledger } from './ledger.ts';
import { kakaoMinutesFor, worldDay } from './persona.ts';
import { acceptsCard, answerPrepCheck, reviewFacts, statedAppts, type FactToCheck } from './sim-user.ts';
import { addDaysKey, isoKst, kstDate } from './time.ts';
import type { AppAppt, DayRecord, PlanSummary, WorldAppt, WorldDay } from './types.ts';

// 서버 질문 예산 (D104 · 7.15) — turn-core 의 QUESTION_PER_DAY · QUESTION_PER_WEEK 와 같지만 코드 값이 아니라 지시 값으로 다시 셈
export const BUDGET_PER_DAY = 1;
export const BUDGET_PER_WEEK = 3;

export interface CardLog {
  id: string;
  kind: string;
  title: string;
  status: string; // 마지막 상태 (SAVED · REJECTED · FAILED …)
  accepted: boolean | null; // 사람이 눌렀나 (null = 누를 카드가 아님)
  wakeAt: string | null;
  level: number | null;
  note: string | null;
}

export interface FeedbackLog {
  factId: string;
  kind: string;
  recorded: string | null;
  truth: string | null;
  status: string;
  to: string | null;
  fix: { id: string; ok: boolean; error: string | null } | null;
}

export interface NightLog {
  forDay: number; // 이 밤이 맞춘 날 (1부터)
  forDate: string; // 맞춘 날 날짜
  now: string; // 대화 시각
  facts: number; // 확인할 기록 줄 수
  feedback: FeedbackLog[];
  cards: CardLog[];
  question: { kind: string; subjectKey: string; text: string; answer: string } | null;
  questionsAsked: number; // 이 밤 서버 질문 수 (0 · 1)
  budget: { sameDay: number; last7Days: number; violations: string[] };
  lines: string[]; // 서버가 말하려 한 것 (처리 결과 줄, T1 글 대신)
  bugs: string[]; // 이 밤에 찾은 버그 후보
}

const MORNING_LEVEL = ['SOFT', 'NORMAL', 'STRONG'] as const;
const RING = ['WAKE', 'PREPARE', 'DEPARTURE'];

// ---------------- 문맥 만들기 ----------------

function joinRow(app: AppState, appt: AppAppt, rec: DayRecord | null, wa: WorldAppt | undefined) {
  const trip = rec?.trips.find((t) => t.apptId === appt.worldId);
  return {
    participant_id: appt.worldId,
    appointment_id: appt.worldId,
    user_id: 'u0',
    transport_type: appt.transport,
    est_travel_minutes: appt.plan?.travelMinutes ?? null,
    departed_at: trip?.recordedDepart ?? null,
    departed_source: trip?.departSource ?? null,
    arrived_at: trip?.recordedArrive ?? null,
    arrived_source: trip?.arriveSource ?? null,
    is_late: trip?.isLate ?? null,
    late_minutes: trip?.lateMinutes ?? null,
    appointment: {
      appointment_id: appt.worldId,
      title: appt.title,
      appointment_at: isoKst(appt.at),
      dest_name: appt.dest?.shortName ?? appt.dest?.name ?? '',
      importance: appt.importance,
      recurrence_rule: wa?.repeat === 'WEEKLY' ? 'FREQ=WEEKLY' : null,
    },
  };
}

function alarmRows(app: AppState, morning: string) {
  const rows: unknown[] = [];
  for (const appt of Object.values(app.saved)) {
    if (appt.date !== morning || !appt.plan) continue;
    const manualKinds = new Set(Object.keys(appt.overrides.manualTimes ?? {}));
    for (const a of appt.plan.alarms) {
      if (!RING.includes(a.kind)) continue;
      rows.push({
        alarm_id: `${appt.worldId}-${a.kind}`,
        participant_id: appt.worldId,
        routine_id: null,
        alarm_type: a.kind,
        scheduled_at: isoKst(a.at),
        intensity: MORNING_LEVEL[appt.plan.level],
        is_enabled: a.enabled,
        time_source: manualKinds.has(a.kind) ? 'MANUAL' : 'AUTO',
      });
    }
  }
  return rows;
}

function earlierRows(rec: DayRecord | null) {
  if (!rec) return [];
  return rec.trips.flatMap((t) =>
    t.actions
      .filter((a) => a.type.startsWith('DEPART'))
      .map((a) => ({
        event_at: a.at,
        alarms: { alarm_type: 'DEPARTURE', participant_id: t.apptId, appointment_participants: { departed_at: t.recordedDepart, departed_source: t.departSource } },
      })),
  );
}

function buildCtx(app: AppState, review: string, morning: string, now: string, allWorlds: WorldDay[]) {
  const reviewRec = app.records.find((r) => r.date === review) ?? null;
  const waOf = (id: string) => allWorlds.flatMap((w) => w.appts).find((a) => a.id === id);
  const participants = Object.values(app.saved)
    .filter((a) => a.date === review || a.date === morning)
    .map((a) => joinRow(app, a, a.date === review ? reviewRec : null, waOf(a.worldId as string)));
  const days = aiTurn.dayOf(now, 'Asia/Seoul', false);
  return aiContext.buildContext({
    type: 'BEFORE_SLEEP',
    now,
    days: { review: days.review, morning: days.morning },
    nickname: app.persona.name,
    participants,
    alarms: alarmRows(app, morning),
    wake: reviewRec?.wakeRecordedAt ? { confirmed_at: reviewRec.wakeRecordedAt, input_source: reviewRec.wakeSource } : null,
    earlierRows: earlierRows(reviewRec),
    todos: [],
    question: null,
    confirmFactIds: [],
  }) as { context: any; refs: any };
}

// ---------------- 앱 일: 카드 계산 · 정정 ----------------

async function computeAppt(app: AppState, world: WorldDay, wa: WorldAppt, draft: any, now: Date, sameDayWake: boolean, prepareOverride?: number): Promise<AppAppt> {
  const p = app.persona;
  const said = statedAppts(p, world).find((s) => s.title === wa.title && s.time === wa.time);
  const importance = (draft?.importance ?? wa.importance ?? 'NORMAL') as AppAppt['importance'];
  const appt: AppAppt = {
    id: wa.id,
    worldId: wa.id,
    title: wa.title,
    date: wa.date,
    time: wa.time,
    at: wa.at,
    dest: wa.place,
    importance,
    importanceSource: said?.importance ? 'SAID' : draft?.importance ? 'KEYWORD' : 'DEFAULT',
    transport: wa.transport,
    bufferMinutes: p.buffer_minutes,
    overrides: prepareOverride != null ? { prepareMinutes: prepareOverride } : {},
    items: [],
    plan: null,
    saved: false,
    savedVia: null,
  };
  const { summary } = await planAppt(appt, {
    now,
    profile: { bufferMinutes: p.buffer_minutes, defaultTransport: p.transport, home: world.home, defaultPrepareMinutes: app.onboardingPrepare },
    learned: learnedAt(app, now),
    sameDayWake,
    kakaoMinutes: kakaoMinutesFor(p, wa),
  });
  appt.plan = summary;
  return appt;
}

const digestOf = (plan: PlanSummary) => ({
  alarms: plan.alarms.filter((a) => RING.includes(a.kind)).map((a) => ({ kind: a.kind, at: isoKst(a.at), enabled: a.enabled })),
  level: plan.level as number,
  with_wake: plan.withWake,
});

// 카드가 가리키는 진짜 약속 — 새 약속 카드는 제목 · 날짜 · 시각으로, 알람 고침 카드는 별칭(a#) → 카드 저장 때 넘긴 약속 id(state.bound)로
const findWorldAppt = (world: WorldDay, c: any, state?: any): WorldAppt | undefined => {
  const d = c.draft;
  if (d) return world.appts.find((a) => a.title === d.title && a.date === d.date && a.time === d.time);
  const ref = c.edit?.appointment_id as string | undefined;
  const id = (ref && state?.bound?.[ref]) ?? ref;
  return world.appts.find((a) => a.id === id);
};

// ---------------- 한 밤 ----------------

export async function runNight(app: AppState, opts: { dayIndex: number; ledger: Ledger }): Promise<NightLog> {
  const { persona: p, seed } = app;
  const world = worldDay(p, opts.dayIndex);
  const review = addDaysKey(world.date, -1);
  const nowIso = `${review}T22:00:00+09:00`;
  const now = new Date(nowIso);
  const llm = new FakeLlm(opts.ledger);
  const allWorlds = [...app.worlds, world];
  const log: NightLog = { forDay: opts.dayIndex + 1, forDate: world.date, now: nowIso, facts: 0, feedback: [], cards: [], question: null, questionsAsked: 0, budget: { sameDay: 0, last7Days: 0, violations: [] }, lines: [], bugs: [] };
  const reviewRec = opts.dayIndex > 0 ? app.records[opts.dayIndex - 1] : null;
  const reviewWorld = opts.dayIndex > 0 ? app.worlds[opts.dayIndex - 1] : null;

  const { context: ctx, refs } = buildCtx(app, review, world.date, nowIso, allWorlds);
  let state = aiTurn.initTurnState(ctx);
  log.facts = ctx.today.facts.length;

  // ---- 턴 1: 확인할 기록에 반응 (정정) ----
  const checks: (FactToCheck & { tripApptId: string })[] = [];
  for (const f of ctx.today.facts as any[]) {
    if (f.kind !== 'DEPART' && f.kind !== 'ARRIVE') continue;
    const ref = refs.facts[f.id];
    const trip = reviewRec?.trips.find((t) => t.apptId === ref?.participant_id);
    if (!trip) continue;
    const recorded = f.kind === 'DEPART' ? trip.recordedDepart : trip.recordedArrive;
    const truth = f.kind === 'DEPART' ? trip.trueDepart : trip.trueArrive;
    if (!recorded || !truth) continue;
    checks.push({ factId: f.id, kind: f.kind, source: f.source, recordedMs: Date.parse(recorded), trueMs: Date.parse(truth), earlier: f.earlier === true, tripApptId: trip.apptId });
  }
  const feedback = reviewFacts(p, checks);
  if (feedback.length) {
    const fast1 = llm.t2f({ fact_feedback: feedback });
    const r1 = aiTurn.applyFast(state, fast1, ctx, 1);
    state = r1.state;
    const fixResults = (r1.fixes as any[]).map((fx) => {
      const pid = refs.facts[fx.fact]?.participant_id as string | undefined;
      const result = applyFix(app, reviewRec, reviewWorld, pid, fx);
      const fb = feedback.find((x) => x.fact_id === fx.fact);
      log.feedback.push({
        factId: fx.fact,
        kind: fx.kind,
        recorded: checks.find((c) => c.factId === fx.fact) ? isoKst(new Date(checks.find((c) => c.factId === fx.fact)!.recordedMs)) : null,
        truth: checks.find((c) => c.factId === fx.fact) ? isoKst(new Date(checks.find((c) => c.factId === fx.fact)!.trueMs)) : null,
        status: fb?.status ?? '?',
        to: fx.to,
        fix: { id: fx.id, ok: result.ok, error: result.error },
      });
      return result;
    });
    // 정정 요청이 안 만들어진 말(앞 출발 DENY 같은 줄만 남는 것)도 기록
    for (const fb of feedback) if (!log.feedback.some((x) => x.factId === fb.fact_id)) log.feedback.push({ factId: fb.fact_id, kind: '?', recorded: null, truth: null, status: fb.status, to: fb.value_time, fix: null });
    const o1 = aiTurn.applyTaskResults(state, { cards: [], fixes: fixResults.map((r) => ({ id: r.id, ok: r.ok, error: r.error })) }, ctx, 1);
    if (o1.ok) {
      state = o1.state;
      log.lines.push(llm.t1(o1.event));
    }
    // DENY 정정이 앱에서 안 되는 것은 알려진 빈틈(fixes.ts denyDetection) — 시험이 센 것만 표시
    for (const r of fixResults) if (!r.ok && r.error === '아직 안 됨') log.bugs.push(`정정 ${r.id}: 앱이 못 하는 정정(${r.error}) — voice/fixes.ts denyDetection (L2 PR 6 대기)`);
  }

  // ---- 턴 2: 내일 일정 말하기 → 카드 ----
  if (world.appts.length) {
    const fast2 = llm.t2f({ appointments: statedAppts(p, world) });
    const r2 = aiTurn.applyFast(state, fast2, ctx, 2);
    state = r2.state;
    const results: any = { cards: [], fixes: [] };
    for (const c of state.cards.filter((x: any) => x.status === 'NEEDS_ESTIMATE')) {
      const wa = findWorldAppt(world, c);
      if (!wa) {
        results.cards.push({ id: c.id, status: 'FAILED', error: '일정을 못 찾음' });
        continue;
      }
      try {
        const appt = await computeAppt(app, world, wa, c.draft, now, !c.first_of_day);
        if (!appt.plan!.checkOk) results.cards.push({ id: c.id, status: 'FAILED', error: appt.plan!.checkMessage ?? '알람을 계산하지 못했어요' });
        else results.cards.push({ id: c.id, status: 'READY', estimate: digestOf(appt.plan!) });
      } catch (e) {
        results.cards.push({ id: c.id, status: 'FAILED', error: String((e as Error).message).slice(0, 80) });
      }
    }
    const o2 = aiTurn.applyTaskResults(state, results, ctx, 2);
    if (o2.ok) {
      state = o2.state;
      for (const [id, why] of Object.entries(o2.invalid as Record<string, string>)) log.bugs.push(`카드 ${id}: 서버가 앱 계산 요약을 거부 (${why}) — turn-core.ts checkDigest`);
      log.lines.push(llm.t1(o2.event));
    } else log.bugs.push(`applyTaskResults 거절: ${o2.reason}`);

    // ---- 카드 수락 · 거절 ----
    let n = 0;
    for (const c of [...state.cards].sort((a: any, b: any) => (a.draft?.time ?? '').localeCompare(b.draft?.time ?? ''))) {
      if (c.status !== 'READY') {
        log.cards.push({ id: c.id, kind: c.kind, title: c.draft?.title ?? c.summary, status: c.status, accepted: null, wakeAt: null, level: null, note: c.error });
        continue;
      }
      const accept = acceptsCard(p, seed, world.date, n++);
      const wa = findWorldAppt(world, c) as WorldAppt;
      if (!accept) {
        const out = aiTurn.applyCardAction(state, { id: c.id, action: 'REJECTED' }, ctx, 2);
        if (out.ok) state = out.state;
        log.cards.push({ id: c.id, kind: c.kind, title: wa.title, status: 'REJECTED', accepted: false, wakeAt: null, level: null, note: '저장 안 함 → 그 약속은 알람 없음' });
        continue;
      }
      // 저장할 때 앱(서버)은 그날 이미 저장된 알람을 보고 기상을 다시 정함 (alarm-commit이 loadSameDayWake로 다시 계산)
      const sameDaySaved = Object.values(app.saved).filter((a) => a.date === wa.date);
      const appt = await computeAppt(app, world, wa, c.draft, now, hasEarlierWake({ id: wa.id, at: wa.at } as AppAppt, sameDaySaved));
      const out = aiTurn.applyCardAction(state, { id: c.id, action: 'SAVED', appointment_id: wa.id, alarms: digestOf(appt.plan!).alarms.map((a) => ({ ...a, level: appt.plan!.level })) }, ctx, 2);
      if (!out.ok) {
        log.bugs.push(`카드 ${c.id} 저장 거절: ${out.reason}`);
        continue;
      }
      state = out.state;
      if (out.invalid) log.bugs.push(`카드 ${c.id}: 저장 알람 요약을 서버가 안 받음 (${out.invalid}) — turn-core.ts applyCardAction`);
      appt.saved = true;
      appt.savedVia = 'CHAT_CARD';
      app.saved[wa.id] = appt;
      const wake = appt.plan!.alarms.find((a) => a.kind === 'WAKE' && a.enabled);
      log.cards.push({ id: c.id, kind: c.kind, title: wa.title, status: 'SAVED', accepted: true, wakeAt: wake ? isoKst(wake.at) : null, level: appt.plan!.level, note: appt.plan!.withWake ? null : '그날 둘째 일정: 기상 알람 없음' });
      log.lines.push(llm.t1(out.event));
    }

    // ---- 서버 질문 (하루 1 · 주 3) ----
    const ctx2 = buildCtx(app, review, world.date, nowIso, allWorlds).context;
    const picked = aiTurn.pickServerQuestion(ctx2, { askedInConversation: false, recent: app.asked }, nowIso);
    if (picked) {
      const q: AskedQuestion = { kind: picked.question.kind, subject_key: picked.subject_key, asked_at: nowIso };
      app.asked.push(q);
      log.questionsAsked = 1;
      const ans = answerPrepCheck(p, world);
      log.question = { kind: q.kind, subjectKey: q.subject_key, text: picked.question.text, answer: `${ans.direction}${ans.minutes ? ` +${ans.minutes}분` : ''} (${ans.why})` };
      if (ans.direction === 'MORE') {
        const fast3 = llm.t2f({ prep_adjustment: { direction: 'MORE', minutes: ans.minutes, save: 'UNCONFIRMED' } });
        const r3 = aiTurn.applyFast(state, fast3, ctx, 3);
        state = r3.state;
        const results3: any = { cards: [], fixes: [] };
        for (const c of state.cards.filter((x: any) => x.status === 'NEEDS_ESTIMATE')) {
          const wa = findWorldAppt(world, c, state);
          const base = wa ? app.saved[wa.id] : undefined;
          if (!wa || !base?.plan) {
            results3.cards.push({ id: c.id, status: 'FAILED', error: '바꿀 일정을 찾지 못했어요' });
            continue;
          }
          // 앱 voice/real.ts prepareOf: 자동 준비 시간 + delta (직접 고른 값 = MANUAL)
          const appt = await computeAppt(app, world, wa, { importance: base.importance }, now, !base.plan.withWake, Math.max(0, base.plan.prepareMinutes + (c.edit?.prepare_delta ?? 0)));
          results3.cards.push({ id: c.id, status: appt.plan!.checkOk ? 'READY' : 'FAILED', estimate: digestOf(appt.plan!), error: appt.plan!.checkMessage });
        }
        const o3 = aiTurn.applyTaskResults(state, results3, ctx, 3);
        if (o3.ok) {
          state = o3.state;
          for (const [id, why] of Object.entries(o3.invalid as Record<string, string>)) log.bugs.push(`카드 ${id}: 서버가 앱 계산 요약을 거부 (${why})`);
        }
        for (const c of state.cards.filter((x: any) => x.status === 'READY' && x.kind === 'ALARM_EDIT')) {
          const wa = findWorldAppt(world, c, state) as WorldAppt;
          if (!acceptsCard(p, seed, world.date, n++, 1)) {
            const o = aiTurn.applyCardAction(state, { id: c.id, action: 'REJECTED' }, ctx, 3);
            if (o.ok) state = o.state;
            log.cards.push({ id: c.id, kind: c.kind, title: wa.title, status: 'REJECTED', accepted: false, wakeAt: null, level: null, note: `서버 질문 답(${log.question.answer}) 카드 거절` });
            continue;
          }
          const base = app.saved[wa.id];
          const appt = await computeAppt(app, world, wa, { importance: base.importance }, now, !base.plan!.withWake, Math.max(0, base.plan!.prepareMinutes + (c.edit?.prepare_delta ?? 0)));
          appt.overrides.manualTimes = undefined;
          const o = aiTurn.applyCardAction(state, { id: c.id, action: 'SAVED', appointment_id: wa.id, alarms: digestOf(appt.plan!).alarms.map((a) => ({ ...a, level: appt.plan!.level })) }, ctx, 3);
          if (o.ok) {
            state = o.state;
            if (o.invalid) log.bugs.push(`카드 ${c.id}: 저장 알람 요약을 서버가 안 받음 (${o.invalid})`);
            appt.saved = true;
            appt.savedVia = 'CHAT_CARD';
            app.saved[wa.id] = appt;
            const wake = appt.plan!.alarms.find((a) => a.kind === 'WAKE' && a.enabled);
            log.cards.push({ id: c.id, kind: c.kind, title: wa.title, status: 'SAVED', accepted: true, wakeAt: wake ? isoKst(wake.at) : null, level: appt.plan!.level, note: `내일만 준비시간 ${c.edit?.prepare_delta ?? 0}분 (질문 답 반영)` });
            log.lines.push(llm.t1(o.event));
          }
        }
      }
    }
  }

  log.budget = budgetOf(app.asked, nowIso, review);
  log.bugs.push(...log.budget.violations);
  return log;
}

// ---------------- 질문 예산 검사 (서버 고르기와 따로, 기록만 보고) ----------------
export function budgetOf(asked: readonly AskedQuestion[], nowIso: string, reviewDate: string): { sameDay: number; last7Days: number; violations: string[] } {
  const nowMs = Date.parse(nowIso);
  const dayStart = kstDate(reviewDate, '00:00').getTime();
  const sameDay = asked.filter((q) => Date.parse(q.asked_at) >= dayStart && Date.parse(q.asked_at) <= nowMs).length;
  const last7Days = asked.filter((q) => nowMs - Date.parse(q.asked_at) < 7 * 24 * 3_600_000 && Date.parse(q.asked_at) <= nowMs).length;
  const violations: string[] = [];
  if (sameDay > BUDGET_PER_DAY) violations.push(`질문 예산 위반: 하루 ${sameDay}개 (한도 ${BUDGET_PER_DAY}) — turn-core.ts pickServerQuestion`);
  if (last7Days > BUDGET_PER_WEEK) violations.push(`질문 예산 위반: 7일 ${last7Days}개 (한도 ${BUDGET_PER_WEEK}) — turn-core.ts pickServerQuestion`);
  return { sameDay, last7Days, violations };
}

// ---------------- 앱 일: 정정 한 건 ----------------
function applyFix(app: AppState, rec: DayRecord | null, world: WorldDay | null, participantId: string | undefined, fx: { id: string; kind: string; action: 'CORRECT' | 'DENY'; to: string | null }): { id: string; ok: boolean; error: string | null } {
  const fail = (error: string) => ({ id: fx.id, ok: false, error });
  if (fx.kind !== 'DEPART' && fx.kind !== 'ARRIVE') return fail('아직 안 됨');
  if (fx.action === 'DENY') return fail('아직 안 됨'); // voice/fixes.ts denyDetection 이 아직 false (L2 PR 6 대기)
  if (!rec || !world || !participantId) return fail('대상 없음');
  const toMs = fx.to ? Date.parse(fx.to) : NaN;
  if (!Number.isFinite(toMs)) return fail('시각 모름');
  const d = correctRecordTime(rec, world, participantId, fx.kind, toMs);
  if (d == null) return fail('대상 없음');
  if (d === 'keep') return fail('이미 확인한 기록');
  void app;
  return { id: fx.id, ok: true, error: null };
}
