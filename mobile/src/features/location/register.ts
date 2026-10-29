// 지오펜스 등록 — 앱을 열 때 · 앞에 올 때, 서버의 집 · 약속을 읽어 감시 목록을 계획(planRegions)하고 폰 OS에 등록 (expo-location)
//   · 안드로이드 + 실데이터 + 로그인 + 위치 권한(앱 사용 중 · 항상) + 자동 기록 스위치 켬일 때만 일함. 아니면 아무것도 안 함
//   · 하루 앞(24시간)까지 미리 등록: 신호를 받는 쪽(task.ts)에는 감시 창이 열릴 때 깨울 타이머가 없음. 창 안인지는 신호 때 다시 확인(attach.ts)
//   · startGeofencingAsync는 목록을 통째로 바꿈 → 바뀐 게 있을 때만(diffRegions) 부름. 안드로이드는 목록을 바꿀 때마다 영역마다 "이미 안 · 밖" 첫 신호를 다시 보냄(INITIAL_TRIGGER)
//     → 바뀐 것만이 아니라 등록한 영역 전부를 "새로 등록함"으로 기록(noteRegistered) — 안 바뀐 영역의 첫 "이미 밖"을 출발로 읽는 일이 없게
//   · 읽기(네트워크)는 줄 밖에서, 비교 · 등록 · 상태 저장은 줄(lock.ts) 안에서 — 신호 해석(task.ts)과 겹치지 않게. 겹쳐 불러도 한 번만 등록
//   · 자동 기록 스위치가 꺼졌거나 위치 권한이 빠졌으면 이미 등록한 지오펜스도 끄고 등록 목록을 비움 (stopGeofences) — 스위치만 끄고 기록은 계속되는 일이 없게
//   · 던지지 않음 — 앱 시작을 막지 않게. 실패는 개발 중에만 콘솔에 (좌표는 안 남김)
import type { LocationRegion } from 'expo-location';
import { Platform } from 'react-native';

import { now } from '@/lib/clock';
import { dbTimeMs } from '@/lib/dbTime';
import { isMock } from '@/lib/mode';
import { supabase } from '@/lib/supabase';
import { currentUserId } from '@/lib/user';

import { announce, commitStep, flushActions } from './actions';
import { minutesMs } from './constants';
import { bumpEpoch, currentEpoch, withLock } from './lock';
import { errorText, nativeLocation } from './native';
import { diffRegions, planRegions, plannedDepartAt, type HomeInput, type MonitoredRegion, type ParticipantInput, type RegionPlan } from './regions';
import { clearLocationStore, commit, getLocationAuto, loadRegions, loadState } from './store';
import { GEOFENCE_TASK } from './task';
import { noteRegistered, resolvePending, type GeoAction } from './transitions';

// 약속을 읽는 범위 — 지금 −2시간 ~ +26시간. 하루 앞 등록(24시간) + 감시 창이 약속 60분 후까지 열려 있는 것을 덮음 (근거 없음 — 작성자 판단)
const READ_BEFORE_MINUTES = 2 * 60;
const READ_AFTER_MINUTES = 26 * 60;
const PLAN_AHEAD_MINUTES = 24 * 60;
const PARTICIPANT_LIMIT = 100;

// 앱이 앞에 올 때마다 새로 읽지 않고 이만큼(분) 안이면 건너뜀 (syncLocation) — 서버 읽기 + 폰 저장소 읽기가 잦아지지 않게
const SYNC_INTERVAL_MINUTES = 5;

type PlanSource = { home: HomeInput; participants: ParticipantInput[] };

// 내 집 · 약속 읽기 — "내 것"은 user_id로 한 번 더 좁힘 (RLS가 친구 약속도 보여 주므로). 약속 날짜 범위로 거름
async function readPlanSource(userId: string, nowMs: number): Promise<PlanSource> {
  const from = new Date(nowMs - minutesMs(READ_BEFORE_MINUTES)).toISOString();
  const to = new Date(nowMs + minutesMs(READ_AFTER_MINUTES)).toISOString();
  const [profile, rows] = await Promise.all([
    supabase.from('profiles').select('home_lat, home_lng, home_radius_m').eq('user_id', userId).maybeSingle(),
    supabase
      .from('appointment_participants')
      .select(
        'participant_id, origin_lat, origin_lng, departed_at, arrived_at, buffer_minutes, est_travel_minutes, appointments!inner(appointment_at, dest_lat, dest_lng, dest_radius_m), alarms(alarm_type, scheduled_at)',
      )
      .eq('user_id', userId)
      .gte('appointments.appointment_at', from)
      .lte('appointments.appointment_at', to)
      .limit(PARTICIPANT_LIMIT),
  ]);
  if (profile.error) throw profile.error;
  if (rows.error) throw rows.error;

  const home: HomeInput = profile.data ? { lat: profile.data.home_lat, lng: profile.data.home_lng, radiusM: profile.data.home_radius_m } : null;
  const participants = (rows.data ?? []).flatMap((row): ParticipantInput[] => {
    const appointment = row.appointments;
    if (!appointment?.appointment_at) return [];
    const appointmentAt = dbTimeMs(appointment.appointment_at);
    if (!Number.isFinite(appointmentAt)) return [];
    // 출발 예정 = 출발 알람 시각, 없으면 약속 − 여유 − 이동 (regions plannedDepartAt)
    const departureAlarm = (row.alarms ?? []).find((alarm) => alarm.alarm_type === 'DEPARTURE');
    const alarmAt = departureAlarm ? dbTimeMs(departureAlarm.scheduled_at) : NaN;
    const departAt = Number.isFinite(alarmAt) ? alarmAt : plannedDepartAt({ appointmentAt, travelMinutes: row.est_travel_minutes, bufferMinutes: row.buffer_minutes });
    return [
      {
        participantId: row.participant_id,
        appointmentAt,
        departAt,
        dest: { lat: appointment.dest_lat, lng: appointment.dest_lng, radiusM: appointment.dest_radius_m },
        origin: { lat: row.origin_lat, lng: row.origin_lng },
        departedAt: row.departed_at ? dbTimeMs(row.departed_at) : null,
        arrivedAt: row.arrived_at ? dbTimeMs(row.arrived_at) : null,
      },
    ];
  });
  return { home, participants };
}

// 위치 권한 — 앱 사용 중 · 항상 둘 다 허용일 때만 (지오펜스는 백그라운드 권한이 있어야 등록됨)
async function hasLocationPermissions(): Promise<boolean> {
  const { getForegroundPermissionsAsync, getBackgroundPermissionsAsync } = nativeLocation();
  const [foreground, background] = await Promise.all([getForegroundPermissionsAsync(), getBackgroundPermissionsAsync()]);
  return foreground.granted && background.granted;
}

const toNative = (r: MonitoredRegion): LocationRegion => ({
  identifier: r.id,
  latitude: r.lat,
  longitude: r.lng,
  radius: r.radiusM,
  notifyOnEnter: true,
  notifyOnExit: true,
});

// 줄 안에서 — 계획을 저장하고, 바뀐 게 있으면 등록하고, 대기 중인 출발을 확정
async function applyPlan(plan: RegionPlan, force: boolean, epoch: number): Promise<GeoAction[]> {
  if (epoch !== currentEpoch()) return []; // 읽는 사이 로그아웃 정리가 지나감 — 앞 계정 집을 다시 등록하지 않음
  const { hasStartedGeofencingAsync, startGeofencingAsync, stopGeofencingAsync } = nativeLocation();
  await commit({ plan }); // 계획은 늘 저장 — 신호 해석이 이 계획을 씀 (등록이 실패해도)
  const stored = await loadRegions();
  const diff = diffRegions(stored, plan.regions);
  const changed = diff.add.length > 0 || diff.remove.length > 0;
  let state = await loadState();
  let registered: MonitoredRegion[] | undefined; // 등록 목록을 바꿨을 때만

  if (plan.regions.length === 0) {
    // 감시할 곳이 없음 — 등록한 게 있으면 끔 (startGeofencingAsync는 빈 목록을 받지 않음)
    if (changed || force) {
      if (await hasStartedGeofencingAsync(GEOFENCE_TASK)) await stopGeofencingAsync(GEOFENCE_TASK);
      state = noteRegistered(state, { add: [], remove: diff.remove }, now().getTime());
      registered = [];
    }
  } else if (changed || force || !(await hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => true))) {
    // 등록 시각은 등록을 부르기 전 — 등록 직후 도착하는 첫 신호(받은 때 ≥ 이 시각)가 "이전 등록 때 신호"로 버려지지 않게
    //   바뀐 것만이 아니라 전부 새로 등록함으로 기록 (파일 위 설명). 폰 OS가 등록을 잃었으면(재부팅 등) 같은 목록이어도 다시 등록
    const registeredAt = now().getTime();
    await startGeofencingAsync(GEOFENCE_TASK, plan.regions.map(toNative));
    state = noteRegistered(state, { add: plan.regions, remove: diff.remove }, registeredAt);
    registered = plan.regions;
  }
  // 신호 없이 확정만 — 앱을 열 때 5분이 지난 출발 후보를 확정 (받는 쪽엔 타이머가 없음)
  return commitStep(resolvePending(state, now().getTime()), { regions: registered });
}

// 폰 OS에 등록한 지오펜스를 끔 (켜진 게 없으면 아무것도 안 함). 줄 안에서 부름. 던질 수 있음 — 부르는 쪽이 잡음
async function stopNative(): Promise<void> {
  const { hasStartedGeofencingAsync, stopGeofencingAsync } = nativeLocation();
  if (await hasStartedGeofencingAsync(GEOFENCE_TASK)) await stopGeofencingAsync(GEOFENCE_TASK);
}

// 등록한 지오펜스를 끄고 등록 목록을 비움 — 자동 기록 스위치를 끌 때 · 권한이 빠졌을 때 (PR 5의 스위치 화면도 스위치를 끄면 이 함수를 부름)
//   등록 목록이 비어 있으면 네이티브를 안 부름. 못 껐으면 목록을 남겨 다음에 다시 시도. 네이티브 오류는 던지지 않음 (저장소 오류만 던짐)
export async function stopGeofences(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await withLock(async () => {
    const stored = await loadRegions();
    if (stored.length === 0) return;
    try {
      await stopNative();
    } catch (e) {
      if (__DEV__) console.warn('[location] 지오펜스 끄기 실패 — 다음에 다시', errorText(e));
      return;
    }
    await commit({ regions: [], state: noteRegistered(await loadState(), { add: [], remove: stored.map((r) => r.id) }, now().getTime()) });
  });
}

// 감시 목록을 읽어 등록 — force = 바뀐 게 없어도 다시 등록 (예: 권한을 방금 허용).
//   'ran' = 끝까지 감, 'failed' = 읽기 · 등록 실패, 'skipped' = 일 안 하는 조건 (안드로이드 아님 · 가짜 모드 · 로그인 없음 · 스위치 끔 · 권한 없음)
//   syncLocation은 'ran'일 때만 5분 제한을 검 — 권한을 방금 허용하고 앱으로 돌아와도 바로 등록되게
export type RefreshResult = 'ran' | 'skipped' | 'failed';

export async function refreshGeofences(options: { force?: boolean } = {}): Promise<RefreshResult> {
  if (Platform.OS !== 'android' || isMock()) return 'skipped';
  const epoch = currentEpoch();
  try {
    const userId = await currentUserId();
    if (!userId) return 'skipped';
    if (!(await getLocationAuto()) || !(await hasLocationPermissions())) {
      await stopGeofences(); // 스위치를 껐거나 권한이 빠졌는데 등록이 남아 있으면 같이 끔
      return 'skipped';
    }
    const nowMs = now().getTime();
    const source = await readPlanSource(userId, nowMs);
    const plan = planRegions({ ...source, now: nowMs, aheadMinutes: PLAN_AHEAD_MINUTES });
    announce(await withLock(() => applyPlan(plan, options.force === true, epoch)));
  } catch (e) {
    if (__DEV__) console.warn('[location] 지오펜스 등록 실패 — 다음에 다시', errorText(e));
    return 'failed';
  }
  await flushActions(); // 대기 중이던 출발 확정 같은 새 기록을 바로 씀
  return 'ran';
}

// 앱을 열 때 · 앞에 올 때 부르는 한 묶음 — 못 쓴 기록 쓰기 → 감시 목록 등록. SYNC_INTERVAL_MINUTES 안에 또 부르면 건너뜀 (ignoreThrottle로 건너뛰지 않기)
//   5분 제한은 등록이 끝까지 간 때('ran')만 검 — 실패 · 일 안 한 때는 다음에 앞에 올 때 바로 다시
//   부르는 곳: useLocationSync. L1의 알람 맞추기 끝 훅(onAlarmsSynced, L1 PR 3b)이 생기면 그것도 여기를 부름 (약속이 바뀐 직후 감시 목록을 새로 짜려고)
let lastSyncAt = 0;
let inFlight: Promise<void> | null = null;
let rerun = false; // 돌고 있는 중에 ignoreThrottle로 또 불렀음 — 끝난 뒤 한 번 더 돎 (몇 번을 겹쳐 불러도 한 번만)

async function syncOnce(): Promise<void> {
  const startedAt = now().getTime();
  await flushActions();
  if ((await refreshGeofences()) === 'ran') lastSyncAt = startedAt;
}

export function syncLocation(options: { ignoreThrottle?: boolean } = {}): Promise<void> {
  if (inFlight) {
    // 돌고 있는 일은 이미 읽기 시작한 값으로 가는 중 — 그 뒤에 바뀐 것(예: 로그인 직후)을 반영하려면 끝난 뒤 한 번 더
    if (options.ignoreThrottle) rerun = true;
    return inFlight;
  }
  if (!options.ignoreThrottle && now().getTime() - lastSyncAt < minutesMs(SYNC_INTERVAL_MINUTES)) return Promise.resolve();
  inFlight = (async () => {
    try {
      do {
        rerun = false;
        await syncOnce();
      } while (rerun);
    } finally {
      rerun = false;
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

// 로그아웃 정리 — 등록한 지오펜스를 끄고 폰에 둔 위치 기억을 지움 (앞 계정의 집 · 약속 위치가 남거나 다음 계정에 섞이지 않게). 던지지 않음
//   lib/session onSignOut에 useLocationSync가 등록. 줄 안에서 하므로 돌고 있던 등록 · 신호 해석이 끝난 뒤에 지움
//   기기 확인 항목 (코드로 못 막음):
//     · 아직 서버에 못 쓴 기록(오프라인 보관함)은 로그아웃에서 마지막 쓰기 시도 없이 지워짐 — 로그아웃 콜백이 동기라 기다릴 수 없음
//     · 신호 시각은 폰 OS가 알려 준 때 — JobScheduler 작업이라 Doze · 배터리 최적화에서는 최대 6분보다 늦을 수 있음
export async function clearOnSignOut(): Promise<void> {
  bumpEpoch();
  try {
    await withLock(async () => {
      if (Platform.OS === 'android') {
        try {
          await stopNative();
        } catch (e) {
          if (__DEV__) console.warn('[location] 로그아웃 때 지오펜스 끄기 실패', errorText(e));
        }
      }
      await clearLocationStore();
    });
  } catch (e) {
    if (__DEV__) console.warn('[location] 로그아웃 때 위치 기억 지우기 실패', errorText(e));
  }
}
