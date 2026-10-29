// 하루 시뮬레이터 (결정론 — 난수는 사람 · 날 · 용도마다 시드 고정) — "진짜로 일어난 일"만 만든다. 앱이 어떻게 보는지는 location.ts.
//   알람 시각 → 인물 성향대로 실제 기상(미루기 · 늦잠 · 누워서 폰 보기 · 다시 잠) → 준비(평소 ± 흔들림 + 요일 사유 + 서두름) → 출발
//   → 이동(평소 ± 흔들림 + 사고) → 도착 → 진짜 지각. 알람이 없는 약속은 알람 없이 평소 기상.
//   섞을 위치 상황(편의점 · 조깅 · 도착 전 귀가)은 여기서 "집 반경 밖에 잠깐 나갔다 옴" 같은 진짜 움직임으로 만들고,
//   신호가 어떻게 잡히는지(반경 · 감지 지연)는 location.ts 가 같은 진실을 값만 바꿔 다시 읽을 수 있게 분리해 둠.
import { addMin, diffMin, isoKst, kstDate } from './time.ts';
import { extraPrep } from './persona.ts';
import { rngFor } from './rng.ts';
import type { Persona, PlanSummary, WorldAppt, WorldDay } from './types.ts';

export interface Excursion {
  kind: 'CONVENIENCE' | 'JOG' | 'TRASH' | 'STORE' | 'RETURN_HOME';
  startAt: string; // 현관에서 나선 시각
  endAt: string; // 다시 현관으로 돌아온 시각
  maxDistanceM: number; // 가장 멀리 간 곳 (집 반경과 견줘 신호가 생기는지 정함)
}

export interface TripTruth {
  worldApptId: string;
  title: string;
  apptAt: string;
  tracked: boolean; // 앱에 저장된 약속인가 (아니면 앱은 이 이동을 아예 모름)
  plannedDepartAt: string | null;
  plannedWakeAt: string | null;
  firstTrip: boolean;
  fromHome: boolean; // false면 앞 약속 자리에서 바로 이동 (앱은 집에서 출발한다고 앎)
  leaveHomeAt: string; // 현관에서 최종으로 나선 시각
  arriveAt: string; // 건물에 닿은 시각
  travelMin: number;
  excursions: Excursion[]; // 나서기 전 집 근처 왕복
  falseStart: { startAt: string; backAt: string } | null; // 도착 전 귀가 (RETURN) — 나갔다가 집으로 되돌아옴
  exitWalkMin: number; // 현관에서 반경 150m 벗어나는 데 (v3 범위, 반경에 비례해 늘임)
  returnHomeAt: string | null; // 약속 뒤 집에 돌아온 시각
  trulyLateMin: number;
  trulyLate: boolean; // +5분 넘으면 지각 (앱 규칙 D · #41 과 같은 기준)
  buildingOffsetM: number;
}

export interface DayTruth {
  personaId: string;
  day: number;
  date: string;
  weekday: string;
  situation: string | null;
  alarmWakeAt: string | null;
  alarmLevel: number | null;
  noAlarmReason: string | null; // 기상 알람이 없었던 이유
  snoozes: number;
  overslept: number; // 알람을 놓친 분
  dismissAt: string; // 알람 해제 (또는 알람이 없으면 자연 기상)
  wakeDetectedAt: string; // 앱이 기상으로 읽는 시각 (해제 뒤 첫 폰 사용)
  wakeAutoDetected: boolean; // 못 읽으면 원탭 필요
  getUpAt: string; // 진짜 일어난 시각
  prepMin: number; // 일어나서 (첫 이동 출발)까지
  extraTags: string[];
  skippedTags: string[];
  trips: TripTruth[];
  notes: string[];
}

export const LATE_AFTER = 5; // 앱의 지각 기준과 같은 분 수 (participantTimes.LATE_AFTER_MINUTES)

const iso = (d: Date) => isoKst(d);

export interface TruthInput {
  persona: Persona;
  world: WorldDay;
  // 앱에 저장된 약속의 알람 (월드 약속 id → 계획). 없으면 앱은 그 약속을 모름
  plans: Record<string, PlanSummary | undefined>;
  seed?: string;
}

function alarmOf(plan: PlanSummary | undefined, kind: 'WAKE' | 'PREPARE' | 'DEPARTURE'): Date | null {
  const a = plan?.alarms.find((x) => x.kind === kind && x.enabled);
  return a ? a.at : null;
}

// 한 날을 살아 본다
export function simulateTruth(input: TruthInput): DayTruth {
  const { persona: p, world } = input;
  const seed = input.seed ?? 'sim';
  const r = (purpose: string) => rngFor(seed, p.id, world.day, purpose);
  const notes: string[] = [];
  const flow = p.flow;
  const first = world.appts[0];
  const firstPlan = first ? input.plans[first.id] : undefined;
  const wakeAlarm = alarmOf(firstPlan, 'WAKE');

  // ---- 기상 ----
  let snoozes = 0;
  let overslept = 0;
  let dismiss: Date;
  let detected: Date;
  let getUp: Date;
  let autoDetected = true;
  const rWake = r('wake');
  const habit = flow?.wake.habit ?? 'UP_AT_ALARM';
  let noAlarmReason: string | null = null;
  if (wakeAlarm && first) {
    const level = firstPlan?.level ?? 1;
    let s = Math.round(rWake.gauss(p.snooze_tendency, 0.7));
    if (world.weekday === 'MON' && p.snooze_tendency >= 2) s += 1;
    if (level === 2 && rWake.chance(0.5)) s -= 1;
    snoozes = Math.max(0, Math.min(5, s));
    const sleepThrough = p.chronotype === 'LATE' ? 0.25 : p.chronotype === 'EARLY' ? 0.03 : 0.08;
    if (rWake.chance(level === 2 ? sleepThrough / 2 : sleepThrough)) overslept = rWake.int(15, 45);
    dismiss = addMin(wakeAlarm, snoozes * 5 + overslept);
    let lie = 0;
    if (habit === 'BED_PHONE' && flow) {
      const long = flow.wake.lie_phone_long?.weekdays.includes(world.weekday) ? flow.wake.lie_phone_long : null;
      lie = rWake.range(long ? long.min : flow.wake.lie_phone_min);
    } else if (habit === 'RESLEEP' && flow && rWake.chance(flow.wake.resleep_prob)) {
      lie = rWake.range(flow.wake.resleep_min); // 해제하고 다시 잠들었다 일어남
    }
    const unlock = flow ? rWake.range(flow.wake.first_unlock_delay) : 1;
    detected = addMin(dismiss, unlock);
    if (habit === 'AWAKE_BEFORE_ALARM' && flow) {
      const before = rWake.range(flow.wake.awake_before_min[1] > 0 ? flow.wake.awake_before_min : [3, 10]);
      detected = addMin(wakeAlarm, -before); // 알람 전에 깨서 폰을 봄 → 앱은 이른 기상으로 읽음
      dismiss = detected;
    }
    getUp = addMin(detected, lie);
    autoDetected = flow ? rWake.chance(flow.wake.auto_confirm_prob) : true;
  } else {
    // 알람 없음 — 일정이 없는 날이거나 앱이 그 약속의 알람을 못 만듦
    noAlarmReason = first ? '앱에 저장된 알람 없음' : '일정 없음';
    const noise = rWake.gauss(0, 18);
    getUp = addMin(world.naturalWake, noise);
    dismiss = getUp;
    detected = addMin(getUp, -rWake.int(1, 12)); // 폰을 먼저 보다 일어남
    autoDetected = flow ? rWake.chance(flow.wake.auto_confirm_prob) : true;
  }

  // ---- 상황: 조깅 (일어난 뒤 준비 전) ----
  let prepStart = getUp;
  const excursionsHome: Excursion[] = [];
  const jogEx: Excursion[] = [];
  if (world.situation === 'JOG' && first) {
    const rj = r('jog');
    const dur = rj.int(28, 42);
    const start = addMin(getUp, 3);
    jogEx.push({ kind: 'JOG', startAt: iso(start), endAt: iso(addMin(start, dur)), maxDistanceM: rj.int(1200, 2200) });
    prepStart = addMin(start, dur + 2);
    notes.push(`아침 조깅 ${dur}분`);
  }
  void excursionsHome;

  // ---- 준비 ----
  const rPrep = r('prep');
  const extra = extraPrep(p, world.weekday);
  const noise = rPrep.gauss(0, 4.5);
  let prep = p.prep_minutes + extra.minutes + noise;
  const plannedDepart1 = alarmOf(firstPlan, 'DEPARTURE') ?? (firstPlan ? firstPlan.departAt : null);
  const skipped: string[] = [];
  if (plannedDepart1) {
    const readyAt = addMin(prepStart, prep);
    let lateBy = diffMin(plannedDepart1, readyAt);
    if (lateBy > 0) {
      const rush = Math.min(5, lateBy);
      prep -= rush;
      lateBy -= rush;
      notes.push(`서둘러서 준비 ${Math.round(rush)}분 줄임`);
      const skip = flow?.prep.skip_when_late ?? [];
      if (lateBy > 8) {
        for (const tag of extra.tags) {
          if (skip.includes(tag)) {
            const minutes = p.recurring_reasons.find((x) => x.tag === tag && x.weekdays.includes(world.weekday))?.extra_minutes ?? 0;
            prep -= minutes;
            skipped.push(tag);
          }
        }
      }
    }
  }
  prep = Math.max(8, prep);
  let ready = addMin(prepStart, prep);

  // ---- 이동 (약속마다) ----
  const trips: TripTruth[] = [];
  let prevArrive: Date | null = null;
  let prevAppt: WorldAppt | null = null;
  const tripFlow = flow?.travel;
  world.appts.forEach((a, idx) => {
    const rt = r(`trip${idx}`);
    const plan = input.plans[a.id];
    const plannedDepart = alarmOf(plan, 'DEPARTURE') ?? plan?.departAt ?? null;
    const plannedWake = alarmOf(plan, 'WAKE');
    const firstTrip = idx === 0;
    // 둘째 이동부터: 앞 약속 뒤 집에 돌아와 있나 (간격이 150분보다 짧으면 앞 자리에서 바로 이동)
    let fromHome = true;
    let readyForTrip = ready;
    if (!firstTrip && prevArrive && prevAppt) {
      const planned = plannedDepart ?? addMin(a.at, -(a.travelMinutes + 15));
      fromHome = diffMin(prevArrive, planned) >= 150;
      readyForTrip = addMin(planned, -rt.int(0, 6)); // 둘째 이동은 알람에 맞춰 나갈 채비를 함
    }

    // 나서기 전 집 근처 왕복 (v3 습관: 쓰레기 · 편의점) + 상황(편의점)
    const exs: Excursion[] = [];
    let leave = firstTrip ? readyForTrip : readyForTrip;
    const natural = flow?.depart.trip;
    let exMinutes = 0;
    if (world.situation === 'CONVENIENCE' && firstTrip) {
      exMinutes = 7;
      exs.push({ kind: 'CONVENIENCE', startAt: iso(addMin(leave, 1)), endAt: iso(addMin(leave, 1 + exMinutes)), maxDistanceM: 180 });
      notes.push('편의점 7분 다녀옴');
    } else if (natural && fromHome && rt.chance(natural.prob)) {
      exMinutes = Math.round(rt.range(natural.minutes));
      const kind = natural.kind === 'TRASH_TRIP' ? 'TRASH' : 'STORE';
      exs.push({ kind, startAt: iso(addMin(leave, 1)), endAt: iso(addMin(leave, 1 + exMinutes)), maxDistanceM: rt.int(60, 260) });
      notes.push(`${kind === 'TRASH' ? '쓰레기 버리러' : '가게에'} ${exMinutes}분 나갔다 옴`);
    }
    if (exMinutes > 0) leave = addMin(leave, exMinutes + 2);
    // 알람보다 일찍 준비가 끝나면 출발 알람을 기다렸다 나감 (앱의 출발 알람이 "나갈 때"를 정함)
    if (plannedDepart) leave = new Date(Math.max(leave.getTime(), addMin(plannedDepart, -2).getTime()));
    else if (firstTrip) leave = addMin(leave, 4);

    // 이동 시간
    const nominal = a.travelMinutes;
    let travel = nominal + (tripFlow?.weekday_extra[world.weekday] ?? 0) + rt.gauss(0, tripFlow?.sd ?? Math.max(1.2, nominal * 0.06));
    for (const inc of tripFlow?.incidents ?? []) {
      if (rt.chance(inc.prob)) {
        const m = rt.range(inc.minutes);
        travel += m;
        notes.push(`${inc.kind} +${Math.round(m)}분`);
      }
    }
    travel = Math.max(3, Math.round(travel));

    // 도착 전 귀가 (RETURN) — 첫 이동에서 나선 지 얼마 안 돼 집으로 되돌아옴
    let falseStart: TripTruth['falseStart'] = null;
    if (world.situation === 'RETURN' && firstTrip) {
      const x = Math.max(7, Math.min(14, Math.round(travel * 0.25)));
      const back = addMin(leave, 2 * x);
      falseStart = { startAt: iso(leave), backAt: iso(back) };
      leave = addMin(back, 4); // 챙겨서 다시 나섬
      notes.push(`나선 지 ${x}분 만에 되돌아옴 (${2 * x + 4}분 손해)`);
    }

    const arrive = addMin(leave, travel);
    const lateMin = diffMin(a.at, arrive);
    const exitWalk = flow ? rt.range(flow.depart.exit_walk_min) : 2;
    const returnAt = addMin(arrive, 85 + rt.int(0, 40) + (a.transport === 'WALK' ? a.travelMinutes : travel));
    trips.push({
      worldApptId: a.id,
      title: a.title,
      apptAt: iso(a.at),
      tracked: plan != null,
      plannedDepartAt: plannedDepart ? iso(plannedDepart) : null,
      plannedWakeAt: plannedWake ? iso(plannedWake) : null,
      firstTrip,
      fromHome,
      leaveHomeAt: iso(leave),
      arriveAt: iso(arrive),
      travelMin: travel,
      excursions: [...(firstTrip ? jogEx : []), ...exs],
      falseStart,
      exitWalkMin: exitWalk,
      returnHomeAt: iso(returnAt),
      trulyLateMin: Math.round(lateMin * 10) / 10,
      trulyLate: lateMin > LATE_AFTER,
      buildingOffsetM: a.buildingOffsetM,
    });
    prevArrive = arrive;
    prevAppt = a;
    if (firstTrip) ready = leave;
  });

  const firstTrip = trips[0];
  const prepMin = firstTrip ? Math.round(diffMin(getUp, kstDateOf(firstTrip.leaveHomeAt))) : 0;
  return {
    personaId: p.id,
    day: world.day,
    date: world.date,
    weekday: world.weekday,
    situation: world.situation,
    alarmWakeAt: wakeAlarm ? iso(wakeAlarm) : null,
    alarmLevel: firstPlan ? firstPlan.level : null,
    noAlarmReason,
    snoozes,
    overslept,
    dismissAt: iso(dismiss),
    wakeDetectedAt: iso(detected),
    wakeAutoDetected: autoDetected,
    getUpAt: iso(getUp),
    prepMin: Math.round(prep),
    extraTags: extra.tags,
    skippedTags: skipped,
    trips,
    notes: [...notes, ...(prepMin ? [] : [])],
  };
}

export const kstDateOf = (isoText: string): Date => new Date(isoText);
export { kstDate };
