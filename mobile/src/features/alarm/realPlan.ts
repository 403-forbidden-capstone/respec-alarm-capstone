// ① 약속 기반 알람 — 실데이터 계산 · 저장 (서버 함수 alarm-suggest · alarm-commit · place-search) + 고친 값 기록
//   계산(미리 보기)은 DB에 안 쓰고, 저장은 alarm-commit → 응답을 폰에 반영(applyCommit). 요청 · 응답 모양은 request.ts (서버의 H05 초안 모양 하나)
//   · 고친 값 기록은 따로 insert하지 않고 alarm-commit의 edits로 보냄 — 저장이 성공해야 user_edit_logs에 남음
//   · 저장은 중복 키를 서버가 아직 안 읽어서(lib/edge) 자동 재시도하지 않음. 읽기(alarm-suggest · place-search)만 한 번 재시도
import { applyCommit, reconcile, syncNow } from '@/lib/alarmSync';
import { now } from '@/lib/clock';
import { dbTimeMs, parseDbTime } from '@/lib/dbTime';
import { callEdge, EdgeError, messageFor } from '@/lib/edge';
import { UserError } from '@/lib/errors';
import { dayKey } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

import { manualTimes, orderError, sameEdits } from './adjust';
import { forgetDetail, recallDetail, rememberDetail } from './detailCache';
import { dropEdits, MAX_EDITS_PER_REQUEST, peekEdits, queueEdit } from './editQueue';
import { createEdits, fromEditRow, settingsEdits, toEditPayloads, type EditLogLine, type SettingsAfter } from './edits';
import { toStandaloneAppointment, TRAVEL_SOURCE_LABEL } from './map';
import { toDepartCheck } from './morning';
import { rememberPlaces, toPlace, uniqueByName, validNear, type PlaceDto } from './places';
import {
  createCommitBody,
  existingBody,
  joinBody,
  newAppointmentBody,
  settingsCommitBody,
  standaloneBody,
  toCreatedAppointment,
  toEstimate,
  toPreview,
  type Body,
  type CommitResponse,
  type StandaloneInput,
  type Suggestion,
} from './request';
import { loadDetail } from './realRows';
import { mirrorArrive } from './realWrite';
import { draftAt } from './schedule';
import { TravelConfirmNeeded, travelFallbackOf } from './travelConfirm';
import {
  ORIGIN_HOME,
  RING_KINDS,
  type AlarmEdits,
  type AlarmPreview,
  type AlarmSettingsDraft,
  type AppointmentDraft,
  type DepartCheck,
  type Estimate,
  type JoinChoice,
  type JoinDefaults,
  type JoinResult,
  type LatLng,
  type Place,
  type PinAddress,
  type SavedAppointment,
  type SaveFollowUp,
  type SettingsSaveResult,
  type UserEditLog,
} from './types';

const COMMIT_TIMEOUT_MS = 30_000; // 카카오 길찾기를 불러서 읽기보다 오래 걸릴 수 있음

// ---------------------------------------------------------------------------
// 장소 (H05 · H03)
// ---------------------------------------------------------------------------

const RECENT_PLACE_DAYS = 90;
const RECENT_PLACE_COUNT = 8;

// 검색어 없이 부르면(화면에 검색 칸이 아직 없음) 내가 쓴 곳 — 최근 약속의 도착지 · 출발지. 검색어가 있으면 place-search(카카오 키워드)
//   카카오 응답은 저장하지 않음: 약속을 저장할 때 도착지 이름 · 좌표가 appointments에 남는 것을 다시 읽을 뿐
async function recentPlaces(userId: string): Promise<Place[]> {
  const since = new Date(now().getTime() - RECENT_PLACE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('appointment_participants')
    .select('origin_name, origin_lat, origin_lng, appointments!inner(dest_name, dest_lat, dest_lng, appointment_at)')
    .eq('user_id', userId)
    .gte('appointments.appointment_at', since)
    .limit(100);
  if (error) throw error;
  const rows = [...(data ?? [])].sort((x, y) => dbTimeMs(y.appointments.appointment_at) - dbTimeMs(x.appointments.appointment_at));
  const destinations = rows.map((r) => toPlace({ name: r.appointments.dest_name, lat: r.appointments.dest_lat, lng: r.appointments.dest_lng }));
  const origins = rows.flatMap((r) => (r.origin_name && r.origin_name !== ORIGIN_HOME && r.origin_name !== '현재 위치' ? [toPlace({ name: r.origin_name, lat: r.origin_lat, lng: r.origin_lng })] : []));
  return uniqueByName([...destinations, ...origins]).slice(0, RECENT_PLACE_COUNT);
}

export async function listPlaces(query?: string, near?: LatLng): Promise<Place[]> {
  const text = query?.trim();
  const from = validNear(near); // 기준점(보통 집)을 주면 서버가 가까운 순으로 줌. 최근 장소에는 안 씀
  const places = text
    ? uniqueByName(((await callEdge<{ places: PlaceDto[] }>('place-search', { query: text, ...from, limit: 10 }, { retry: 1 })).places ?? []).map(toPlace))
    : await recentPlaces(await requireUserId());
  rememberPlaces(places);
  return places;
}

// 지도 핀 자리의 주소 (place-reverse, 카카오 좌표 → 주소) — 도로명 주소 우선. 주소를 못 구한 자리(바다 · 해외)는 null. 카카오 응답은 저장하지 않음 (rememberPlaces에도 안 넣음)
export async function reverseAddress(lat: number, lng: number): Promise<PinAddress | null> {
  if (!validNear({ lat, lng })) return null; // 서버는 범위 안 좌표만 받음
  type Dto = { address?: string | null; roadAddress?: string | null; buildingName?: string | null };
  const { place } = await callEdge<{ place: Dto | null }>('place-reverse', { lat, lng }, { retry: 1 });
  const address = place?.roadAddress?.trim() || place?.address?.trim();
  if (!address) return null;
  const name = place?.buildingName?.trim();
  return { address, ...(name ? { name } : {}) };
}

// ---------------------------------------------------------------------------
// 계산 (alarm-suggest)
// ---------------------------------------------------------------------------

// 같은 요청이 동시에 두 번 가면 한 번만 (값을 바꾸며 연달아 부르는 미리 보기에서 같은 값이 겹칠 때) — 결과를 기억해 두지는 않음 (카카오 응답은 재사용 못 함)
const running = new Map<string, Promise<Suggestion>>();

// 출발 시각까지 지난 일정도 서버가 계산 결과(details.suggestion)를 같이 줌 — 미리 보기는 그 결과로 보여 주고, 저장을 막는 것은 check.ok
export function suggest(body: Body): Promise<Suggestion> {
  const key = JSON.stringify(body);
  const existing = running.get(key);
  if (existing) return existing;
  const task = callEdge<Suggestion>('alarm-suggest', body, { retry: 1 })
    .catch((e: unknown) => {
      const suggestion = e instanceof EdgeError && e.code === 'UNPROCESSABLE' ? (e.details as { suggestion?: Suggestion } | undefined)?.suggestion : undefined;
      if (suggestion) return suggestion;
      throw e;
    })
    .finally(() => running.delete(key));
  running.set(key, task);
  return task;
}

let estimateSeq = 0;

// 새 일정 알람 계산 (H05 확인 시트)
export async function estimateAppointment(d: AppointmentDraft): Promise<Estimate> {
  if (!d.place.trim()) throw new UserError('장소를 먼저 골라 주세요');
  const at = draftAt(d.date, d.time);
  const body = newAppointmentBody(d, at);
  const s = await suggest(body);
  // 장소의 좌표가 없으면 길찾기를 못 함 — H05에는 이동시간 입력 칸이 없어 장소를 다시 고르게 안내 (H03에는 "예상 이동" 칸이 있음)
  if (s.travel.manual_required) throw new UserError('이 장소의 위치를 몰라 이동시간을 구하지 못했어요. 장소를 검색해서 다시 골라 주세요');
  // 서버의 check.message는 화면에 보이지 않음 — check.reason(ORDER · DEPARTURE_PASSED 등)으로 앱 문구를 고르고, 모르는 이유는 기본 문구 (lib/edge messageFor)
  if (!s.check.ok) throw new UserError(messageFor('UNPROCESSABLE', { reason: s.check.reason }));
  return toEstimate(s, d, at, body, ++estimateSeq);
}

const emptyPreview = (): AlarmPreview => ({ alarms: [], travelMinutes: 0, travelSource: '', autoTravelMinutes: 0, predictedPrepMinutes: 0, autoPredictedPrepMinutes: 0 });

// 값을 바꾸면 알람이 어떻게 되는지 (H03 저장 전 미리 보기)
export async function previewAlarms(id: string, edits: AlarmEdits): Promise<AlarmPreview> {
  const saved = recallDetail(id) ?? (await readDetail(id));
  if (!saved) return emptyPreview();
  return toPreview(await suggest(existingBody(saved, edits)), saved, edits);
}

async function readDetail(id: string) {
  const detail = await loadDetail(id, await requireUserId(), now().getTime());
  if (detail) rememberDetail(detail);
  return detail;
}

// 지금 나가면 (홈 아침 카드 [다시 확인], 이슈 #230) — 저장된 약속으로 alarm-suggest 미리 보기를 불러 이동시간만 새로 구함 (저장 안 함)
//   도착 = 지금 + 이동, 여유 · 상태는 departNow (morning.ts toDepartCheck). 출발 시각이 지나 서버가 UNPROCESSABLE을 줘도 suggest()가 계산 결과(details.suggestion)를 꺼내 줌
//   카카오 응답은 앱 메모리에도 담지 않음(D5): 이동분(숫자)만 꺼내 쓰고, 같은 요청이 동시에 겹치면 한 번만(suggest) — 결과를 기억해 두지는 않음
export async function checkDepartNow(appointmentId: string): Promise<DepartCheck> {
  const s = await suggest({ appointment_id: appointmentId });
  const minutes = s.travel.minutes;
  if (minutes == null) throw new UserError('이동시간을 구하지 못했어요. 알람 설정에서 예상 이동을 직접 입력해 주세요');
  return toDepartCheck({
    appointmentAt: parseDbTime(s.appointment_at),
    travelMinutes: minutes,
    source: s.travel.source ? TRAVEL_SOURCE_LABEL[s.travel.source] : '',
    now: now(),
  });
}

// ---------------------------------------------------------------------------
// 저장 (alarm-commit)
// ---------------------------------------------------------------------------

const warnDev = (what: string, e: unknown) => {
  if (__DEV__) console.warn(`[alarm] ${what}`, e);
};

// 저장 결과를 폰에 반영하고 못 건 알람 id를 돌려줌 (수는 .size, 같은 id는 한 번) — 던지지 않음
//   applyCommit이 던지면 이번에 걸려던 알람 모두를 못 건 것으로 셈 (꾸러미가 없으면 하나로)
async function phoneFailedIds(result: Parameters<typeof applyCommit>[0]): Promise<Set<string>> {
  try {
    const summary = await applyCommit(result);
    if (summary.failed.length) warnDev('폰에 못 건 알람', summary.failed);
    return new Set(summary.failed.map((f) => f.alarmId));
  } catch (e) {
    warnDev('저장 뒤처리 실패 (폰 예약)', e);
    const ids = new Set((result.ring_packages ?? []).map((p) => p.alarmId));
    if (!ids.size) ids.add('(폰 예약)');
    return ids;
  }
}

// 반복 회차 넘기기 — 기다리지 않고, 던져도(동기 오류 포함) 저장 흐름은 그대로 (못 건 회차는 다음 앱 열림 때 걸림)
function rollSeries(seriesId: string) {
  try {
    void syncNow({ rollSeriesId: seriesId });
  } catch (e) {
    warnDev('저장 뒤처리 실패 (반복 회차)', e);
  }
}

// 뒤처리가 못 한 것이 있을 때만 followUp을 채움 (화면은 saveNotice.ts 문구로 알림)
const followUpOf = (phoneFailed: number, itemsFailed = false): { followUp?: SaveFollowUp } =>
  phoneFailed > 0 || itemsFailed ? { followUp: { phoneFailed, itemsFailed } } : {};

// 새 일정 저장 (H05). source(하루 기록에 남길 출처)는 실데이터에선 안 씀 — 하루 기록은 울림 · 확인 기록에서 읽음
//   저장이 끝난 뒤의 뒤처리(폰 예약 · 준비물)는 실패해도 오류로 돌리지 않음: 같은 요청을 다시 보내면 일정이 하나 더 생김.
//   대신 못 한 것을 followUp으로 돌려줘 화면이 "저장했지만 ~못 했어요"로 알림. 폰 예약은 다음 맞추기(앱이 앞에 올 때)에서 다시 걸리고,
//   준비물은 다시 넣는 길이 없어 알리기만 함. 폰 예약이 실패해도 준비물은 넣음 (둘은 서로 영향 없음)
export async function createAppointment(estimate: Estimate, source?: string): Promise<SavedAppointment> {
  void source;
  const a = estimate.appointment;
  const blocked = orderError(a.alarms);
  if (blocked) throw new UserError(blocked);
  const body = createCommitBody(estimate, manualTimes(a.alarms), toEditPayloads(createEdits(estimate)));
  if (!body) throw new UserError('계산한 값이 없어요. 알람을 다시 계산해 주세요');
  const userId = await requireUserId();

  const res = await callEdge<CommitResponse>('alarm-commit', body, { timeoutMs: COMMIT_TIMEOUT_MS });
  const saved = toCreatedAppointment(res, estimate);

  const phoneFailed = (await phoneFailedIds({ ...res, appointment_at: a.at.toISOString() })).size; // 약속 시각은 맞춘 뒤 훅(onAlarmsSynced)의 upcoming용
  let itemsFailed = false;
  const items = a.items.map((x) => x.trim()).filter(Boolean);
  if (items.length && res.appointment_id) {
    try {
      const { error } = await supabase
        .from('todos')
        .insert(items.map((title) => ({ user_id: userId, appointment_id: res.appointment_id, title: title.slice(0, 100), todo_type: 'ITEM' as const, due_date: dayKey(a.at) })));
      if (error) throw error;
    } catch (e) {
      itemsFailed = true;
      warnDev('준비물 저장 실패', e);
    }
  }
  // 반복 일정이면 서버가 다음 회차들(앞으로 14일치)을 만들어 폰에 걸게 함 — 첫 회차는 위에서 이미 걸었고, 나머지는 몇 초 뒤 맞추기가 끝나면 걸림.
  //   준비물 저장 뒤에 불러야 서버가 회차를 만들 때 준비물을 복사함. 기다리지 않음 — 실패해도 저장 흐름은 그대로 (syncNow는 던지지 않고, 못 건 회차는 다음 앱 열림 때 걸림)
  //   묶음 번호(series_id)는 새 약속이면 appointment_id (DB가 채움, 설계메모 1절)
  if (a.recurrenceRule && res.appointment_id) rollSeries(res.appointment_id);
  return { ...saved, ...followUpOf(phoneFailed, itemsFailed) };
}

// 공동 약속 [내 알람 만들기] (친구 9장) — 그룹원이 G02 연결 일정에서 누름. 서버가 내 참여 조건 · 알람을 만들고(이미 있으면 같은 한 줄을 고침), 응답을 폰에 걺
//   실패(오프라인 · 지난 약속 PAST_APPOINTMENT · 그룹 밖 FORBIDDEN)는 lib/edge 문구로 그대로 던짐 → 화면이 다시 하기. 저장 뒤 폰 예약 실패는 못 건 수만
//   길찾기를 못 하면(ROUTE_UNAVAILABLE + 어림값) TravelConfirmNeeded — 시트가 어림 분을 보여 주고 확인하면 그 분을 MANUAL로 다시 보냄 (9-어, H03과 같은 길)
export async function joinSharedAppointment(appointmentId: string, choice: JoinChoice): Promise<JoinResult> {
  let res: CommitResponse;
  try {
    res = await callEdge<CommitResponse>('alarm-commit', joinBody(appointmentId, choice), { timeoutMs: COMMIT_TIMEOUT_MS });
  } catch (e) {
    const fallback = choice.travelMinutes == null ? travelFallbackOf(e) : null;
    throw fallback ? new TravelConfirmNeeded(fallback) : e;
  }
  return { phoneFailed: (await phoneFailedIds(res)).size };
}

// [내 알람 만들기] 시트 기본값 — 내 프로필(온보딩 값): 집 이름 · 기본 수단 · 기본 준비 시간
export async function getJoinDefaults(): Promise<JoinDefaults> {
  const userId = await requireUserId();
  const { data, error } = await supabase.from('profiles').select('home_name, default_transport, default_prepare_minutes').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return { homeName: data?.home_name ?? null, transport: data?.default_transport ?? 'TRANSIT', prepareMinutes: data?.default_prepare_minutes ?? 60 };
}

// 알람 설정 저장 (H03) — 여유 · 출발 위치 · 이동 수단 · 이동 · 준비 · 알람 시각 · 종류별 켜기 · 강도를 한 번에
//   바뀐 곳은 고친 값 기록(edits)으로 같이 보냄. 시각 입력이 바뀌었으면 먼저 계산해서 자동값을 알아냄(고친 값 기록의 auto_value)
//   돌려주는 값 = 이번 저장으로 일정 알람이 꺼졌는지 · 켜졌는지 (종류를 모두 껐거나 껐던 종류를 다시 켠 경우) + 폰에 못 건 알람이 있으면 followUp
export async function saveAlarmSettings(id: string, draft: AlarmSettingsDraft): Promise<SettingsSaveResult> {
  const userId = await requireUserId();
  const saved = await loadDetail(id, userId, now().getTime());
  if (!saved) return { turnedOff: false, turnedOn: false };

  const base = existingBody(saved, draft);
  let after: SettingsAfter = { alarms: saved.alarms, autoTravelMinutes: saved.auto.travelMinutes, autoPrepareMinutes: saved.auto.predictedPrepMinutes };
  if (!sameEdits(draft, saved.edits)) {
    const s = await suggest(base);
    if (s.travel.manual_required) throw new UserError('이동시간을 구하지 못했어요. 예상 이동에 직접 입력해 주세요');
    const preview = toPreview(s, saved, draft);
    const blocked = orderError(preview.alarms);
    if (blocked) throw new UserError(blocked);
    after = { alarms: preview.alarms, autoTravelMinutes: preview.autoTravelMinutes, autoPrepareMinutes: preview.autoPredictedPrepMinutes };
  }

  const lines: EditLogLine[] = settingsEdits(saved, draft, after);
  // 한 요청의 edits는 50줄까지 (서버 상한) — 이번 저장의 줄을 먼저 담고 남는 자리만큼 쌓아 둔 기록을 실음. 못 보낸 기록은 큐에 남아 다음 저장에
  const queued = peekEdits(id, MAX_EDITS_PER_REQUEST - lines.length);
  let res: CommitResponse;
  try {
    res = await callEdge<CommitResponse>('alarm-commit', settingsCommitBody(base, draft, toEditPayloads([...lines, ...queued].slice(0, MAX_EDITS_PER_REQUEST))), { timeoutMs: COMMIT_TIMEOUT_MS });
  } catch (e) {
    // 길찾기를 못 해 서버가 어림값만 가졌으면 저장을 멈추고 화면이 사용자에게 확인받게 함 (7장 7.1.2 "근사값은 사용자 확인 → MANUAL")
    //   확인하면 화면이 그 분을 예상 이동(직접 입력)으로 넣어 다시 부름 → MANUAL로 저장. 이미 직접 입력한 값을 보냈는데도 같은 오류면 멈추지 않고 그대로 던짐(되풀이 방지)
    const fallback = draft.travelMinutes == null ? travelFallbackOf(e) : null;
    if (fallback) throw new TravelConfirmNeeded(fallback);
    throw e;
  }
  dropEdits(queued);
  forgetDetail(id);

  // 저장(alarm-commit)은 끝났음 — 뒤처리(폰 예약 · 도착 목표 맞추기)가 실패해도 실패로 돌리지 않음 (createAppointment와 같은 방침):
  //   실패 토스트가 뜨면 저장된 줄 모르고 화면이 저장 전 상태로 남고, 같은 저장을 다시 눌러도 같은 서버 상태일 뿐임.
  //   폰 예약은 다음 맞추기(앱이 앞에 올 때 reconcile)에서 서버 값으로 다시 걸림. 둘은 서로 영향이 없게 따로 감쌈. 못 건 수는 followUp으로 화면에 알림
  //   도착 목표를 폰에 못 건 것도 같이 셈 — 홈 빨간 줄(맞춘 뒤 훅)과 같은 기준, 같은 알람은 한 번
  const failedIds = await phoneFailedIds({ ...res, appointment_at: saved.at.toISOString() });
  try {
    const arrive = res.participant_id ? await mirrorArrive(userId, res.participant_id) : [];
    if (arrive.length) for (const f of (await reconcile({ alarmIds: arrive })).failed) failedIds.add(f.alarmId);
  } catch (e) {
    warnDev('저장 뒤처리 실패 (도착 목표 맞추기)', e);
  }

  const nowEnabled = res.alarms.some((x) => x.alarm_type !== 'ARRIVE' && x.alarm_type !== 'ROUTINE' && x.is_enabled);
  const wasOn = (kind: (typeof RING_KINDS)[number]) => saved.alarms.find((x) => x.kind === kind)?.enabled;
  const kindOff = RING_KINDS.some((kind) => draft.kinds[kind] === false && wasOn(kind) === true);
  const kindOn = RING_KINDS.some((kind) => draft.kinds[kind] === true && wasOn(kind) === false);
  return { turnedOff: kindOff && saved.enabled && !nowEnabled, turnedOn: kindOn && !saved.enabled && nowEnabled, ...followUpOf(failedIds.size) };
}

// ---------------------------------------------------------------------------
// 일정 없는 알람 (D46 · Q10) — 입력 화면(알람 목록 "+")은 새 UI라 아직 없고 api만
// ---------------------------------------------------------------------------

// 만들기: 시각 필수. 고치기: alarmId만 있으면 시각 없이 강도 · 켜기만도 됨
export async function saveStandaloneAlarm(input: StandaloneInput): Promise<SavedAppointment> {
  if (!input.alarmId && !input.at) throw new UserError('알람 시각을 골라 주세요');
  const queued = peekEdits(null);
  const body = { ...standaloneBody(input), edits: toEditPayloads(queued) };
  const res = await callEdge<CommitResponse>('alarm-commit', body, { timeoutMs: COMMIT_TIMEOUT_MS });
  dropEdits(queued);
  const row = res.alarms[0];
  if (!row) throw new UserError('알람을 저장하지 못했어요. 다시 해 주세요');
  const phoneFailed = (await phoneFailedIds(res)).size;
  // 새로 만든 반복 알람이면 다음 회차들도 바로 넘김 (createAppointment와 같음). 묶음 번호 = 첫 회차의 alarm_id. 고치기(alarmId 있음)는 어느 회차인지 몰라 건너뜀 — 다음 앱 열림 때 넘김
  if (!input.alarmId && row.recurrence_rule) rollSeries(row.alarm_id);
  return { ...toStandaloneAppointment({ ...row, alarm_type: 'WAKE' }), ...followUpOf(phoneFailed) };
}

// ---------------------------------------------------------------------------
// 고친 값 기록 (user_edit_logs)
// ---------------------------------------------------------------------------

// 저장과 따로 부르는 곳(S01 등)의 기록 — 같은 일정의 다음 alarm-commit에 실어 보냄 (editQueue.ts). 앱 안에서 지우는 길은 없음
export async function recordEdit(log: EditLogLine): Promise<void> {
  queueEdit(log);
}

export async function listEditLogs(): Promise<UserEditLog[]> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from('user_edit_logs')
    .select('created_at, screen, field, appointment_id, alarm_id, alarm_type, auto_value, edited_value')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data ?? []).reverse().map(fromEditRow);
}
