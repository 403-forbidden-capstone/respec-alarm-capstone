// 알람 조정 제안 적용 (ALG-07 · 안건 D111 · D23 A) — suggestion-apply 본문. 지금은 준비 알람 당김(PREPARE_ADVANCE)만
//   적용 · 고쳐 적용 · 되돌리기: 그 일정의 이번 회차와 이후 회차(같은 묶음 · 같은 사람, 이번만 지운 회차 빼고)의 당김 분을 바꾸고 알람 시각을 맞춤 → 폰에 다시 걸 꾸러미
//     알람 시각은 다시 계산(길찾기 · 준비 시간 예측)하지 않고 당김 차이만큼만 옮김 — 사용자가 받아들인 "○분 앞당김" 그대로 (예측이 그사이 바뀌어도 다른 이유로 같이 움직이지 않게)
//       준비 알람 = 당김 차이만큼, 기상 = 준비 전 활동을 넘는 만큼의 차이만 (calc/chain.ts와 같은 규칙 — 다음에 일정을 고쳐 다시 계산해도 같은 시각)
//       이미 지났거나 옮긴 시각이 지금보다 앞인 알람은 그대로 두고, 당김 분 칸만 바꿈 (다음 계산부터 반영)
//   무시: 알람은 그대로, 제안만 IGNORED (실측 3번 뒤 다시 후보, D24 C)
//   되돌리기: 당김을 적용 전 값(current_value)으로, 제안은 대기(PENDING)로 — D23 미정이라 앱의 다른 제안 되돌리기와 같게 (작성자 결정, D23 A)
//   준비 알람을 직접 고른 일정은 옮기지 않음 (plan-core도 당김을 안 씀)
import { activityOrderError, activityPlanOf, type AlarmKind } from './calc/index.ts';
import { must } from './db.ts';
import { HttpError } from './errors.ts';
import { loadAlarms } from './plan.ts';
import { inferBeforePrepare, type AlarmRow } from './plan-core.ts';
import type { Reader } from './read.ts';
import { buildRingPackages, subtitleFor, type RingPackage } from './ring-package.ts';
import type { Db } from './supabase.ts';
import { safeTimeZone } from './tz.ts';

export const MAX_ADVANCE_MINUTES = 120; // appointment_participants.prepare_advance_minutes 0 ~ 120 (#484)
export type ApplyAction = 'APPLY' | 'EDIT' | 'IGNORE' | 'REVERT';
export type ApplyRequest = { suggestionId: string; action: ApplyAction; minutes?: number };
const ACTIONS: readonly ApplyAction[] = ['APPLY', 'EDIT', 'IGNORE', 'REVERT'];

// 요청 { suggestion_id, action, minutes? } — minutes = 고쳐 적용할 때 이번 제안으로 더 당길 분 (0이면 당기지 않음)
export function readApplyRequest(r: Reader): ApplyRequest {
  const suggestionId = r.uuid('suggestion_id', { required: true }) as string;
  const action = r.string('action', { required: true }) as ApplyAction;
  if (action && !ACTIONS.includes(action)) r.problemAt('action', 'APPLY · EDIT · IGNORE · REVERT 중 하나여야 해요');
  const minutes = r.int('minutes', { min: 0, max: MAX_ADVANCE_MINUTES });
  if (action === 'EDIT' && minutes == null) r.problemAt('minutes', '고쳐 적용할 분이 필요해요');
  return { suggestionId, action, ...(minutes != null ? { minutes } : {}) };
}

export type AlarmShift = { alarm_id: string; scheduled_at: string };

// 당김을 old → new로 바꿀 때 옮길 알람 (순수). prepareMinutes = 참여 조건의 준비 시간(기상 ~ 출발) — 준비 전 활동을 되찾는 데 씀
export function shiftForAdvance(alarms: readonly AlarmRow[], oldAdvance: number, newAdvance: number, prepareMinutes: number | null): AlarmShift[] {
  const prep = alarms.find((a) => a.alarm_type === 'PREPARE');
  const delta = newAdvance - oldAdvance;
  if (!prep || prep.time_source === 'MANUAL' || !delta) return [];
  const wake = alarms.find((a) => a.alarm_type === 'WAKE');
  let prepAt = Date.parse(prep.scheduled_at) - delta * 60_000;
  const out: AlarmShift[] = [];
  if (wake) {
    const before = inferBeforePrepare(alarms, oldAdvance, prepareMinutes) ?? 0;
    const wakeAt = wake.time_source === 'MANUAL'
      ? Date.parse(wake.scheduled_at)
      : Date.parse(wake.scheduled_at) - (Math.max(0, newAdvance - before) - Math.max(0, oldAdvance - before)) * 60_000;
    if (wakeAt !== Date.parse(wake.scheduled_at)) out.push({ alarm_id: wake.alarm_id, scheduled_at: new Date(wakeAt).toISOString() });
    prepAt = Math.max(prepAt, wakeAt); // 준비 알람은 기상보다 앞설 수 없음 (직접 고른 기상)
  }
  if (prepAt !== Date.parse(prep.scheduled_at)) out.push({ alarm_id: prep.alarm_id, scheduled_at: new Date(prepAt).toISOString() });
  return out;
}

type SuggestionRow = { suggestion_id: string; user_id: string; target_alarm_id: string | null; suggestion_type: string; status: string; current_value: string | null; suggested_value: string; result_value: string | null };
type Occurrence = { appointment_id: string; appointment_at: string; title: string; dest_name: string | null };
type Participant = { participant_id: string; appointment_id: string; prepare_minutes: number; prepare_advance_minutes: number | null; est_travel_minutes: number | null; activity_plan?: unknown };

export type ApplyCtx = { db: Db; write: Db; userId: string; now: Date };
export type ApplyResponse = { suggestion_id: string; status: string; advance: number | null; ring_packages: RingPackage[]; moved_alarm_ids: string[] };

const int = (v: string | null | undefined) => (v != null && /^\d+$/.test(v) ? Number(v) : 0);

export async function runSuggestApply(ctx: ApplyCtx, req: ApplyRequest): Promise<ApplyResponse> {
  const s = must<SuggestionRow | null>(
    'alarm_suggestions',
    await ctx.db.from('alarm_suggestions').select('suggestion_id, user_id, target_alarm_id, suggestion_type, status, current_value, suggested_value, result_value')
      .eq('suggestion_id', req.suggestionId).eq('user_id', ctx.userId).maybeSingle(),
  );
  if (!s) throw new HttpError('NOT_FOUND', '제안을 찾지 못했어요');
  if (s.suggestion_type !== 'PREPARE_ADVANCE' || !s.target_alarm_id) throw new HttpError('UNPROCESSABLE', '이 제안은 여기서 적용할 수 없어요');
  const reverting = req.action === 'REVERT';
  if (reverting ? s.status !== 'APPLIED' && s.status !== 'EDITED' : s.status !== 'PENDING') throw new HttpError('CONFLICT', reverting ? '적용한 제안만 되돌릴 수 있어요' : '이미 처리한 제안이에요');

  const at = ctx.now.toISOString();
  if (req.action === 'IGNORE') {
    must('alarm_suggestions', await ctx.write.from('alarm_suggestions').update({ status: 'IGNORED', responded_at: at }).eq('suggestion_id', s.suggestion_id).eq('user_id', ctx.userId));
    return { suggestion_id: s.suggestion_id, status: 'IGNORED', advance: null, ring_packages: [], moved_alarm_ids: [] };
  }

  const current = int(s.current_value);
  const advance = req.action === 'APPLY' ? int(s.suggested_value)
    : req.action === 'EDIT' ? Math.min(MAX_ADVANCE_MINUTES, current + (req.minutes ?? 0))
    : current;

  // 대상 알람 → 그 회차 → 같은 묶음의 이번 회차 · 이후 회차 (이번만 지운 회차 빼고)
  const target = must<{ participant_id: string | null } | null>('alarms', await ctx.db.from('alarms').select('participant_id').eq('alarm_id', s.target_alarm_id).eq('user_id', ctx.userId).maybeSingle());
  if (!target?.participant_id) throw new HttpError('NOT_FOUND', '제안한 알람을 찾지 못했어요');
  const own = must<{ appointment_id: string } | null>('appointment_participants', await ctx.db.from('appointment_participants').select('appointment_id').eq('participant_id', target.participant_id).eq('user_id', ctx.userId).maybeSingle());
  if (!own) throw new HttpError('NOT_FOUND', '제안한 일정을 찾지 못했어요');
  const base = must<{ series_id: string | null; appointment_at: string } | null>('appointments', await ctx.db.from('appointments').select('series_id, appointment_at').eq('appointment_id', own.appointment_id).maybeSingle());
  if (!base) throw new HttpError('NOT_FOUND', '제안한 일정을 찾지 못했어요');
  const occurrences = base.series_id
    ? must<(Occurrence & { exception_kind: string | null })[]>('appointments', await ctx.db.from('appointments').select('appointment_id, appointment_at, title, dest_name, exception_kind').eq('series_id', base.series_id).gte('appointment_at', base.appointment_at))
        .filter((o) => o.exception_kind !== 'CANCELED')
    : must<Occurrence[]>('appointments', await ctx.db.from('appointments').select('appointment_id, appointment_at, title, dest_name').eq('appointment_id', own.appointment_id));
  const byId = new Map(occurrences.map((o) => [o.appointment_id, o]));
  const participants = byId.size
    ? must<Participant[]>('appointment_participants', await ctx.db.from('appointment_participants').select('participant_id, appointment_id, prepare_minutes, prepare_advance_minutes, est_travel_minutes, activity_plan').in('appointment_id', [...byId.keys()]).eq('user_id', ctx.userId))
    : [];
  const profile = must<{ timezone: string | null } | null>('profiles', await ctx.db.from('profiles').select('timezone').eq('user_id', ctx.userId).maybeSingle());
  const tz = safeTimeZone(profile?.timezone);

  const ringPackages: RingPackage[] = [];
  const moved: string[] = [];
  for (const p of participants) {
    const occ = byId.get(p.appointment_id)!;
    const alarms = await loadAlarms(ctx.db, p.participant_id, ctx.userId);
    const shifts = shiftForAdvance(alarms, Math.max(0, p.prepare_advance_minutes ?? 0), advance, p.prepare_minutes)
      .filter((x) => {
        const before = alarms.find((a) => a.alarm_id === x.alarm_id);
        return before && Date.parse(before.scheduled_at) > ctx.now.getTime() && Date.parse(x.scheduled_at) > ctx.now.getTime();
      });
    // 기상 뒤 할 일이 있는 회차: 당긴 준비 알람이 할 일 안으로 들어가면(회의가 끝나기 전) 이 회차는 당기지 않음 — 알람 · 당김 분 모두 그대로
    //   기상을 임의로 더 당기지도 않음. 다음 계산(plan-core)도 같은 사슬을 실패로 보므로 당김 분을 남기지 않는 쪽
    const plan = activityPlanOf(p.activity_plan);
    if (plan) {
      const next = new Map(shifts.map((x) => [x.alarm_id, x.scheduled_at]));
      const chain = alarms
        .filter((a) => a.alarm_type !== 'ARRIVE')
        .map((a) => ({ kind: a.alarm_type as AlarmKind, at: new Date(next.get(a.alarm_id) ?? a.scheduled_at) }));
      if (activityOrderError(chain, plan.items)) continue;
    }
    for (const x of shifts) {
      must('alarms', await ctx.write.from('alarms').update({ scheduled_at: x.scheduled_at, last_calculated_at: at }).eq('alarm_id', x.alarm_id).eq('user_id', ctx.userId));
      moved.push(x.alarm_id);
    }
    must('appointment_participants', await ctx.write.from('appointment_participants').update({ prepare_advance_minutes: advance }).eq('participant_id', p.participant_id).eq('user_id', ctx.userId));
    if (shifts.length) {
      const next = new Map(shifts.map((x) => [x.alarm_id, x.scheduled_at]));
      const updated = alarms.map((a) => (next.has(a.alarm_id) ? { ...a, scheduled_at: next.get(a.alarm_id)! } : a));
      const appointmentAt = new Date(Date.parse(occ.appointment_at));
      // 문구(출발까지 몇 분)는 같은 회차의 출발 알람을 기준으로 만들어서 전부 넘기고, 돌려주는 건 옮긴 알람만
      ringPackages.push(...buildRingPackages({
        alarms: updated,
        title: occ.title,
        subtitle: subtitleFor(appointmentAt, occ.dest_name, tz),
        appointment: { appointmentAt, travelMinutes: p.est_travel_minutes, timeZone: tz },
      }).filter((pkg) => next.has(pkg.alarmId)));
    }
  }

  const status = req.action === 'APPLY' ? 'APPLIED' : req.action === 'EDIT' ? 'EDITED' : 'PENDING';
  const patch = reverting ? { status, result_value: null, responded_at: null } : { status, result_value: String(advance), responded_at: at };
  must('alarm_suggestions', await ctx.write.from('alarm_suggestions').update(patch).eq('suggestion_id', s.suggestion_id).eq('user_id', ctx.userId));
  return { suggestion_id: s.suggestion_id, status, advance, ring_packages: ringPackages, moved_alarm_ids: moved };
}
