// Expo Push 보내기 · 영수증 가져오기 — https://exp.host/--/api/v2/push/send · getReceipts (2.2 푸시 결정: FCM 키는 EAS credentials, 이 함수는 Expo 서버만 부름)
//   · 요청: 메시지 배열(최대 100개), Authorization: Bearer EXPO_ACCESS_TOKEN은 선택 (Expo의 "강화된 푸시 보안"을 켰을 때)
//   · 응답: { data: [{ status: 'ok', id } | { status: 'error', message, details: { error } }] } — 요청 순서 그대로
//       details.error: DeviceNotRegistered(토큰 만료 → 지움, 8장 8.2.3) · MessageTooBig · MessageRateExceeded · InvalidCredentials(FCM 키 없음 → 설정 안 됨)
//   · HTTP 401 · 403: EXPO_ACCESS_TOKEN이 틀렸거나 Expo에서 "강화된 푸시 보안"을 켰는데 토큰이 없음 → 이것도 설정 문제(PUSH_NOT_CONFIGURED). 장애(PUSH_UNAVAILABLE)
//   · 접수(ticket) 번호: 접수가 됐다는 뜻일 뿐 기기에 닿았다는 뜻이 아님 → 15분쯤 뒤 getReceipts로 확인 (push-receipts.ts, 친구 11장)
//   · 네트워크 오류 · 5xx는 한 번 더 보내 봄 (11-20). 401 · 403은 다시 보내도 같아서 안 함
// fetch를 바꿔 끼워 시험함 (push.test.ts · push-send.test.ts). 순수 TS
export type PushMessage = { title: string; body: string; data?: Record<string, unknown> };

// 메시지마다 받는 토큰 · 문구 · 데이터 · 안드로이드 채널이 다름 (11장: 받는 사람마다 데이터에 받는 사람 id가 다르게 실림)
//   silent = 조용한 데이터 푸시 — 문구 · 소리 · 채널 없이 data만 보냄(앱이 열려 있지 않아도 알람을 다시 맞추게 깨움). 알림을 끈 멤버 · 차단 쌍에게 가는 공동 약속 변경이 이 모양 (title · body는 안 쓰임)
export type OutgoingMessage = PushMessage & { to: string; channelId?: string; silent?: boolean };

export type PushResult = {
  sent: number;
  failed: number;
  reason?: 'PUSH_NOT_CONFIGURED' | 'PUSH_UNAVAILABLE'; // 하나도 못 보냈을 때 이유
  invalidTokens: string[]; // 더 이상 못 쓰는 토큰 — 부른 쪽이 push_tokens에서 지움
};

export type PushTicket = { token: string; ticketId: string };
export type SendResult = PushResult & { tickets: PushTicket[] }; // tickets = 접수된 것만 (영수증 표에 기록)

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type SendOptions = {
  accessToken?: string;
  fetchImpl?: FetchLike;
  retries?: number; // 실패한 묶음을 다시 보내 보는 횟수 (기본 1)
  sleep?: (ms: number) => Promise<void>; // 다시 보내기 전 쉬는 시간 (시험이 바꿔 끼움)
  timeoutMs?: number; // 한 번 보내는 데 기다리는 최대 시간 (기본 10초) — Expo가 응답을 안 줘도 깨우기 요청 · 5분 배치가 매달리지 않게
};

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const BATCH = 100;
const RECEIPT_BATCH = 300;
const RETRY_WAIT_MS = 500;
const REQUEST_TIMEOUT_MS = 10_000;
const EXPO_TOKEN = /^Expo(nent)?PushToken\[[^\]]+\]$/;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const headersOf = (accessToken?: string): Record<string, string> => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
});

// 한 묶음을 한 번 보냄. tickets가 null이면 실패(이유: 인증이 거절됐는지 아니면 장애인지)
async function postChunk(doFetch: FetchLike, accessToken: string | undefined, body: unknown[], timeoutMs: number): Promise<{ tickets: unknown[] | null; rejectedByAuth: boolean }> {
  try {
    const res = await doFetch(EXPO_PUSH_URL, { method: 'POST', headers: headersOf(accessToken), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const json: unknown = await res.json().catch(() => null);
    const data = json && typeof json === 'object' ? (json as { data?: unknown }).data : undefined;
    if (res.ok && Array.isArray(data)) return { tickets: data, rejectedByAuth: false };
    return { tickets: null, rejectedByAuth: res.status === 401 || res.status === 403 };
  } catch {
    return { tickets: null, rejectedByAuth: false }; // 네트워크 오류 · 시간 초과 — 호출한 쪽이 이 묶음을 실패로 셈
  }
}

export async function sendExpoMessages(messages: readonly OutgoingMessage[], options: SendOptions = {}): Promise<SendResult> {
  const result: SendResult = { sent: 0, failed: 0, invalidTokens: [], tickets: [] };
  const valid = messages.filter((m) => EXPO_TOKEN.test(m.to));
  result.failed += messages.length - valid.length; // Expo 토큰 모양이 아닌 것은 보내지 않음
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.retries ?? 1;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let notConfigured = 0;
  let unavailable = 0;

  for (let i = 0; i < valid.length; i += BATCH) {
    const chunk = valid.slice(i, i + BATCH);
    const body = chunk.map((m) =>
      m.silent
        ? { to: m.to, data: m.data ?? {}, priority: 'high', _contentAvailable: true }
        : {
            to: m.to,
            title: m.title,
            body: m.body,
            data: m.data ?? {},
            sound: 'default',
            priority: 'high',
            ...(m.channelId ? { channelId: m.channelId } : {}),
          },
    );
    let outcome = await postChunk(doFetch, options.accessToken, body, timeoutMs);
    for (let attempt = 1; !outcome.tickets && !outcome.rejectedByAuth && attempt <= retries; attempt += 1) {
      await sleep(RETRY_WAIT_MS * attempt);
      outcome = await postChunk(doFetch, options.accessToken, body, timeoutMs);
    }
    if (!outcome.tickets) {
      result.failed += chunk.length;
      if (outcome.rejectedByAuth) notConfigured += chunk.length;
      else unavailable += chunk.length;
      continue;
    }
    const tickets = outcome.tickets;
    chunk.forEach((m, j) => {
      const t = tickets[j] as { status?: string; id?: unknown; details?: { error?: string } } | undefined;
      if (t?.status === 'ok') {
        result.sent += 1;
        if (typeof t.id === 'string') result.tickets.push({ token: m.to, ticketId: t.id });
        return;
      }
      result.failed += 1;
      const error = t?.details?.error;
      if (error === 'DeviceNotRegistered') result.invalidTokens.push(m.to);
      if (error === 'InvalidCredentials' || error === 'MismatchSenderId') notConfigured += 1;
    });
  }

  if (result.sent === 0 && result.failed > 0) {
    if (notConfigured > 0) result.reason = 'PUSH_NOT_CONFIGURED';
    else if (unavailable > 0) result.reason = 'PUSH_UNAVAILABLE';
  }
  return result;
}

// 같은 문구를 여러 토큰에 (옛 모양 — 다시 보내지 않고 접수 번호도 안 돌려줌). 새 코드는 sendExpoMessages
export async function sendExpoPush(tokens: readonly string[], message: PushMessage, options: SendOptions = {}): Promise<PushResult> {
  const { tickets: _tickets, ...result } = await sendExpoMessages(tokens.map((to) => ({ ...message, to })), { retries: 0, ...options });
  return result;
}

// ---- 영수증 -----------------------------------------------------------------------------------

export type ExpoReceipt = { status: 'ok' } | { status: 'error'; message?: string; details?: { error?: string } };

// 접수 번호들의 영수증. 응답에 없는 번호는 아직 준비되지 않은 것. 요청이 하나라도 실패하면 ok:false (받은 것까지는 돌려줌)
export async function fetchExpoReceipts(
  ids: readonly string[],
  options: { accessToken?: string; fetchImpl?: FetchLike } = {},
): Promise<{ ok: boolean; receipts: Record<string, ExpoReceipt> }> {
  const out: { ok: boolean; receipts: Record<string, ExpoReceipt> } = { ok: true, receipts: {} };
  const doFetch = options.fetchImpl ?? fetch;
  for (let i = 0; i < ids.length; i += RECEIPT_BATCH) {
    try {
      const res = await doFetch(EXPO_RECEIPTS_URL, { method: 'POST', headers: headersOf(options.accessToken), body: JSON.stringify({ ids: ids.slice(i, i + RECEIPT_BATCH) }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const json: unknown = await res.json().catch(() => null);
      const data = json && typeof json === 'object' ? (json as { data?: unknown }).data : undefined;
      if (res.ok && data && typeof data === 'object' && !Array.isArray(data)) Object.assign(out.receipts, data);
      else out.ok = false;
    } catch {
      out.ok = false;
    }
  }
  return out;
}
