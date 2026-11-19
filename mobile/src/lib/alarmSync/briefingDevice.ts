// 백그라운드 기상 브리핑 갱신(#515)용 기기 키 — 로그인한 앱이 서버(briefing-device)에서 받아 네이티브 Keystore 저장소에 넘김
//   폰 네이티브는 이 키로 새벽에 alarm-briefing-device(BriefingRefreshWorker)를 불러 본인 기상 알람 브리핑을 받고, 알림 버튼 · 기상 해제 · 자동 기상 확정 기록을 alarm-events-device(DeviceUpload)로 올림 — 앱 로그인 토큰은 안 씀(Kotlin이 세션을 갱신하지 않게)
//   언제: 폰 예약을 맞춘 뒤마다(useAlarmSync) — 키가 없거나 · 다른 계정 키거나 · 만료 7일 전이면 새로 받음. 아니면 서버를 안 부름
//   로그아웃: 서버 줄 지우기 + 폰 키 지우기 (lib/session). 계정 삭제: 서버 줄은 계정과 같이 지워짐 → 폰 키만 지움
//   실패해도 알람 · 브리핑에는 영향 없음 — 백그라운드 갱신만 빠지고 앱을 열 때 받는 길은 그대로
import * as AlarmCore from '@capstone/alarm-core';

import { callEdge } from '../edge';
import { supabasePublicKey, supabaseUrl } from '../supabase';

export const DEVICE_RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

export type BriefingDeviceDeps = {
  supported: boolean;
  url: string;
  apikey: string;
  get: typeof AlarmCore.getBriefingDevice;
  set: typeof AlarmCore.setBriefingDevice;
  clear: typeof AlarmCore.clearBriefingDevice;
  issue: (deviceId: string) => Promise<{ token: string; expires_at: string }>;
  revoke: (deviceId: string) => Promise<unknown>;
  newId: () => string;
};

const defaultDeps: BriefingDeviceDeps = {
  supported: AlarmCore.canRefreshBriefingInBackground,
  url: supabaseUrl,
  apikey: supabasePublicKey,
  get: AlarmCore.getBriefingDevice,
  set: AlarmCore.setBriefingDevice,
  clear: AlarmCore.clearBriefingDevice,
  issue: (deviceId) => callEdge<{ token: string; expires_at: string }>('briefing-device', { action: 'issue', device_id: deviceId }),
  revoke: (deviceId) => callEdge('briefing-device', { action: 'revoke', device_id: deviceId }),
  newId: AlarmCore.makeUuid,
};

export type DeviceResult = 'KEPT' | 'ISSUED' | 'SKIPPED';

let inFlight: { userId: string; run: Promise<DeviceResult> } | null = null;

/** 이 계정의 기기 키가 폰에 있게 함. 같은 계정으로 이미 도는 중이면 그 결과를 같이 기다리고, 다른 계정(계정 전환 직후)이면 앞 것이 끝난 뒤 이 계정으로 한 번 더 */
export function ensureBriefingDevice(userId: string, nowMs: number = Date.now(), deps: BriefingDeviceDeps = defaultDeps): Promise<DeviceResult> {
  if (inFlight?.userId === userId) return inFlight.run;
  const before = inFlight?.run.catch(() => undefined) ?? Promise.resolve();
  const run = before.then(() => ensureOnce(userId, nowMs, deps)).finally(() => {
    if (inFlight?.run === run) inFlight = null;
  });
  inFlight = { userId, run };
  return run;
}

async function ensureOnce(userId: string, nowMs: number, deps: BriefingDeviceDeps): Promise<DeviceResult> {
  // 예전 APK(네이티브 함수 없음) · 서버 주소 없음(웹 미리보기)이면 키를 받아도 쓸 곳이 없음
  if (!deps.supported || !deps.url || !deps.apikey) return 'SKIPPED';
  const info = await deps.get();
  const mine = info?.userId === userId ? info : null;
  if (mine && mine.expiresAt - nowMs > DEVICE_RENEW_BEFORE_MS) return 'KEPT';
  // 앞 계정 키가 남았으면(로그아웃 정리가 중간에 멈춤 등) 먼저 지움 — 다른 계정 브리핑을 받지 않게
  if (info && !mine) await deps.clear();
  const deviceId = mine?.deviceId ?? deps.newId();
  const out = await deps.issue(deviceId);
  const expiresAt = Date.parse(out.expires_at);
  if (!/^bdk_/.test(out.token) || !Number.isFinite(expiresAt)) throw new Error('기기 키 응답이 이상해요');
  await deps.set({ url: `${deps.url.replace(/\/+$/, '')}/functions/v1/alarm-briefing-device`, apikey: deps.apikey, token: out.token, userId, deviceId, expiresAt });
  return 'ISSUED';
}

/**
 * 이 기기의 키를 지움 — revoke면 서버 줄도 (로그아웃: 세션이 남아 있는 지금이어야 함). 서버를 못 불러도 폰 키는 지움
 * 서버 줄이 남으면 30일 뒤 만료 · 다음 발급 때 치움 — 폰에 원문이 없으니 쓸 수 없음
 */
export async function forgetBriefingDevice(opts: { revoke: boolean }, deps: BriefingDeviceDeps = defaultDeps): Promise<void> {
  if (!deps.supported) return;
  const info = await deps.get().catch(() => null);
  if (opts.revoke && info) await deps.revoke(info.deviceId).catch(() => undefined);
  await deps.clear();
}
