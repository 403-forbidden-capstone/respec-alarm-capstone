// 푸시 영수증 확인 (친구 논리설계 11장, 11-06 · 11-07) — wake-check 5분 배치가 함께 돌림
//   Expo가 접수한 알림은 push_tickets에 접수 번호로 남음(notify.ts). 15분쯤 뒤 영수증을 받아서
//     · DeviceNotRegistered(앱을 지웠거나 기기가 바뀜) → 그 토큰을 push_tokens에서 지움. 받는 사람이 앱을 열면 "알림이 꺼져 있어요 [켜기]" (11-아)
//     · 확인한 줄은 표에서 지움 (표가 불어나지 않게)
//   영수증이 아직 없으면(Expo가 준비 전) 줄을 남겨 다음 배치에 다시, 24시간이 지나도 없으면 포기하고 지움
//   Expo 요청이나 DB가 실패해도 던지지 않고 로그만 — 같은 배치의 MISSED 기록을 막지 않음
// 본문은 모듈로 빼서 가짜 DB · 가짜 Expo로 시험함 (push-receipts.test.ts). 연결은 wake-check/index.ts
import { type FetchLike, fetchExpoReceipts } from './push.ts';
import type { Db } from './supabase.ts';

export const RECEIPT_DELAY_MS = 15 * 60_000;
export const TICKET_MAX_AGE_MS = 24 * 3_600_000;
const MAX_PER_RUN = 1000;

export type ReceiptCheckResult = { checked: number; tokensRemoved: number; expired: number };
type TicketRow = { ticket_id: string; token: string; created_at: string };

export async function runReceiptCheck(service: Db, now: Date, options: { accessToken?: string; fetchImpl?: FetchLike } = {}): Promise<ReceiptCheckResult> {
  const nothing: ReceiptCheckResult = { checked: 0, tokensRemoved: 0, expired: 0 };
  try {
    const due = await service
      .from('push_tickets')
      .select('ticket_id, token, created_at')
      .lte('created_at', new Date(now.getTime() - RECEIPT_DELAY_MS).toISOString())
      .order('created_at', { ascending: true })
      .limit(MAX_PER_RUN);
    if (due.error) {
      console.error('[wake-check] push_tickets 조회 실패', due.error.message);
      return nothing;
    }
    const rows = (due.data ?? []) as TicketRow[];
    if (!rows.length) return nothing;

    // 영수증 요청이 일부 실패해도 받은 것은 씀. 못 받은 번호는 영수증이 아직 없는 것과 같이 다음 배치로
    const { ok, receipts } = await fetchExpoReceipts(rows.map((r) => r.ticket_id), { accessToken: options.accessToken, fetchImpl: options.fetchImpl });
    const resolved = rows.filter((r) => r.ticket_id in receipts);
    const gone = new Set<string>();
    for (const r of resolved) {
      const receipt = receipts[r.ticket_id];
      if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') gone.add(r.token);
    }
    const expired = rows.filter((r) => !(r.ticket_id in receipts) && now.getTime() - Date.parse(r.created_at) > TICKET_MAX_AGE_MS);

    if (gone.size) {
      const del = await service.from('push_tokens').delete().in('token', [...gone]);
      if (del.error) console.error('[wake-check] 만료 토큰 삭제 실패', del.error.message);
    }
    const finished = [...resolved, ...expired].map((r) => r.ticket_id);
    if (finished.length) {
      const del = await service.from('push_tickets').delete().in('ticket_id', finished);
      if (del.error) console.error('[wake-check] 영수증 표 정리 실패', del.error.message);
    }
    return { checked: ok ? rows.length : resolved.length, tokensRemoved: gone.size, expired: expired.length };
  } catch (e) {
    console.error('[wake-check] 영수증 확인 실패', e instanceof Error ? e.message : String(e));
    return nothing;
  }
}
