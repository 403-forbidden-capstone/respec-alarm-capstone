// 기기 전용 키 (#515) — 폰 네이티브가 앱 없이 새벽에 본인 기상 브리핑을 받고(alarm-briefing-device), 알림 버튼 기록 · 자동 기상 판정을 올릴 때(alarm-events-device) 쓰는 키
//   발급 · 폐기: briefing-device (앱 로그인 토큰). 확인: alarm-briefing-device · alarm-events-device (이 키, Authorization: Bearer bdk_…)
//   서버에는 SHA-256 해시만 (briefing_devices.token_hash). 원문은 발급 응답에 한 번만 실리고 폰 Keystore 저장소에만 남음
//   한 사용자 · 한 기기에 한 줄 — 다시 발급하면 해시가 바뀌어 예전 키는 바로 못 씀. 로그아웃 = 줄 삭제, 계정 삭제 = profiles cascade
//   앱 로그인 토큰(JWT)을 Kotlin이 갱신하지 않으려고 따로 둠 (refresh token은 한 번 쓰면 바뀌어 JS 세션과 부딪침)
// 이 파일은 Deno API를 안 써서 node --test로 돈다 (briefing-device.test.ts)
import { must } from './db.ts';
import { HttpError } from './errors.ts';
import type { Db } from './supabase.ts';

// 키 수명 — 앱을 열 때 남은 기간이 7일 밑이면 앱이 새로 받음 (mobile lib/alarmSync/briefingDevice.ts). 그동안 앱을 안 열면 갱신만 멈추고 알람은 그대로 — 작성자 판단
export const DEVICE_KEY_TTL_MS = 30 * 86_400_000;
const PREFIX = 'bdk_';
const TOKEN = /^bdk_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** 새 키 원문 — 32바이트 난수 base64url (43자) */
export function newDeviceToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function deviceTokenHash(token: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
}

export function validDeviceId(deviceId: unknown): deviceId is string {
  return typeof deviceId === 'string' && UUID.test(deviceId);
}

/** 이 기기의 키 발급 · 다시 발급 — 같은 (사용자, 기기) 줄의 해시를 바꿈. 이 사용자의 만료된 줄은 같이 치움 */
export async function issueDeviceKey(service: Db, userId: string, deviceId: string, nowMs: number): Promise<{ token: string; expires_at: string }> {
  if (!validDeviceId(deviceId)) throw new HttpError('VALIDATION_FAILED', 'device_id가 필요해요');
  must('expired device keys', await service.from('briefing_devices').delete().eq('user_id', userId).lt('expires_at', new Date(nowMs).toISOString()));
  const token = newDeviceToken();
  const expires_at = new Date(nowMs + DEVICE_KEY_TTL_MS).toISOString();
  must(
    'device key',
    await service
      .from('briefing_devices')
      .upsert({ user_id: userId, device_id: deviceId, token_hash: await deviceTokenHash(token), expires_at, last_used_at: null }, { onConflict: 'user_id,device_id' }),
  );
  return { token, expires_at };
}

/** 로그아웃 — 이 사용자의 그 기기 줄만 지움 (남의 줄은 못 지움) */
export async function revokeDeviceKey(service: Db, userId: string, deviceId: string): Promise<void> {
  if (!validDeviceId(deviceId)) throw new HttpError('VALIDATION_FAILED', 'device_id가 필요해요');
  must('revoke device key', await service.from('briefing_devices').delete().eq('user_id', userId).eq('device_id', deviceId));
}

/** 요청의 기기 키 → 사용자 id. 없거나 · 모양이 틀리거나 · 폐기됐거나 · 만료면 AUTH_REQUIRED (폰은 갱신만 멈추고 저장된 브리핑으로 울림) */
export async function deviceUser(service: Db, req: Request, nowMs: number): Promise<string> {
  const match = /^Bearer\s+(\S+)$/i.exec((req.headers.get('authorization') ?? '').trim());
  if (!match || !TOKEN.test(match[1])) throw new HttpError('AUTH_REQUIRED', '기기 키가 필요해요');
  const hash = await deviceTokenHash(match[1]);
  const row = must<{ user_id: string; device_id: string; expires_at: string } | null>(
    'device key',
    await service.from('briefing_devices').select('user_id, device_id, expires_at').eq('token_hash', hash).maybeSingle(),
  );
  if (!row || Date.parse(row.expires_at) <= nowMs) throw new HttpError('AUTH_REQUIRED', '기기 키가 만료됐어요');
  // 마지막 사용 시각은 기록용 — 못 써도 브리핑은 줌
  await Promise.resolve(service.from('briefing_devices').update({ last_used_at: new Date(nowMs).toISOString() }).eq('token_hash', hash)).catch(() => undefined);
  return row.user_id;
}
