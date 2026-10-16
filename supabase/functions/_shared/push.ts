// Expo Push 보내기 — https://exp.host/--/api/v2/push/send (2.2 푸시 결정: FCM 키는 EAS credentials, 이 함수는 Expo 서버만 부름)
//   · 요청: 메시지 배열(최대 100개), Authorization: Bearer EXPO_ACCESS_TOKEN은 선택 (Expo의 "강화된 푸시 보안"을 켰을 때)
//   · 응답: { data: [{ status: 'ok', id } | { status: 'error', message, details: { error } }] } — 요청 순서 그대로
//       details.error: DeviceNotRegistered(토큰 만료 → 지움, 8장 8.2.3) · MessageTooBig · MessageRateExceeded · InvalidCredentials(FCM 키 없음 → 설정 안 됨)
//   · HTTP 401 · 403: EXPO_ACCESS_TOKEN이 틀렸거나 Expo에서 "강화된 푸시 보안"을 켰는데 토큰이 없음 → 이것도 설정 문제(PUSH_NOT_CONFIGURED). 장애(PUSH_UNAVAILABLE)로 보이지 않게
// fetch를 바꿔 끼워 시험함 (push.test.ts). 순수 TS
export type PushMessage = { title: string; body: string; data?: Record<string, unknown> };

export type PushResult = {
  sent: number;
  failed: number;
  reason?: 'PUSH_NOT_CONFIGURED' | 'PUSH_UNAVAILABLE'; // 하나도 못 보냈을 때 이유
  invalidTokens: string[]; // 더 이상 못 쓰는 토큰 — 부른 쪽이 push_tokens에서 지움
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH = 100;
const EXPO_TOKEN = /^Expo(nent)?PushToken\[[^\]]+\]$/;

export async function sendExpoPush(
  tokens: readonly string[],
  message: PushMessage,
  options: { accessToken?: string; fetchImpl?: FetchLike } = {},
): Promise<PushResult> {
  const result: PushResult = { sent: 0, failed: 0, invalidTokens: [] };
  const valid = tokens.filter((t) => EXPO_TOKEN.test(t));
  result.failed += tokens.length - valid.length; // Expo 토큰 모양이 아닌 것은 보내지 않음
  const doFetch = options.fetchImpl ?? fetch;
  let notConfigured = 0;
  let unavailable = 0;

  for (let i = 0; i < valid.length; i += BATCH) {
    const chunk = valid.slice(i, i + BATCH);
    const body = chunk.map((to) => ({ to, title: message.title, body: message.body, data: message.data ?? {}, sound: 'default', priority: 'high' }));
    let tickets: unknown[] | null = null;
    let rejectedByAuth = false;
    try {
      const res = await doFetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const json: unknown = await res.json().catch(() => null);
      const data = json && typeof json === 'object' ? (json as { data?: unknown }).data : undefined;
      if (res.ok && Array.isArray(data)) tickets = data;
      else if (res.status === 401 || res.status === 403) rejectedByAuth = true;
    } catch {
      // 네트워크 오류 — 아래에서 이 묶음을 실패로 셈
    }
    if (!tickets) {
      result.failed += chunk.length;
      if (rejectedByAuth) notConfigured += chunk.length;
      else unavailable += chunk.length;
      continue;
    }
    chunk.forEach((token, j) => {
      const t = tickets?.[j] as { status?: string; details?: { error?: string } } | undefined;
      if (t?.status === 'ok') {
        result.sent += 1;
        return;
      }
      result.failed += 1;
      const error = t?.details?.error;
      if (error === 'DeviceNotRegistered') result.invalidTokens.push(token);
      if (error === 'InvalidCredentials' || error === 'MismatchSenderId') notConfigured += 1;
    });
  }

  if (result.sent === 0 && result.failed > 0) {
    if (notConfigured > 0) result.reason = 'PUSH_NOT_CONFIGURED';
    else if (unavailable > 0) result.reason = 'PUSH_UNAVAILABLE';
  }
  return result;
}
