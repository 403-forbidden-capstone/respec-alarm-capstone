// 그룹 기상 신호 구독 — 그룹원의 기상 기록이 들어오면 DB가 그룹 채널에 "새로 고침" 신호만 보내고, 받은 앱이 기상 상태 함수(get_group_wake_status)를 다시 부름
//   채널 group:<group_id>:wake (비공개 채널 — 그 그룹에 참여 중인 사람만 받음, realtime.messages 정책), 이벤트 refresh, 내용 { date } (누구의 기록인지는 안 담음)
//   근거: 개발환경_v1.md 10/15 "기상 상태 실시간", supabase/README.md "그룹 기상 신호 (Realtime)"
//   화면에 붙이는 것은 P6-4 (G01 · G02 · G03): useEffect(() => subscribeGroupWake(groupId, ({ date }) => reload()), [groupId])
//
//   · 신호에 date가 있으면 그날 상태를 다시 읽음 — p_date로 그대로 넘김 (D57: 그 그룹 약속이 있는 날만, 기상까지만)
//   · 신호를 놓칠 수 있음(앱이 뒤에 있는 동안 · 연결이 끊긴 동안). 화면이 앞에 올 때는 신호와 상관없이 한 번 읽을 것 (useLoad가 포커스마다 읽음)
//   · 같은 그룹을 여러 화면이 구독해도 채널은 하나 — 마지막 구독자가 풀면 채널을 닫음
//   · 로그아웃 정리(lib/session)가 unsubscribeAll()로 전부 끊음
import type { RealtimeChannel } from '@supabase/supabase-js';

import { supabase } from './supabase';

export type WakeSignal = { date: string | null }; // 신호가 가리키는 날 (YYYY-MM-DD, 사용자 시간대). 모양이 다르면 null — 오늘 것을 다시 읽으면 됨
export type SubscribeStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR';

export const wakeChannelName = (groupId: string) => `group:${groupId}:wake`;

// 실제 Realtime은 payload에 id(uuid)를 덧붙이므로 전체를 비교하지 않고 date만 읽음
export function readWakeSignal(payload: unknown): WakeSignal {
  const date = typeof payload === 'object' && payload !== null ? (payload as { date?: unknown }).date : undefined;
  return { date: typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null };
}

type Entry = {
  channel: RealtimeChannel;
  listeners: Set<(signal: WakeSignal) => void>;
  statusListeners: Set<(status: SubscribeStatus) => void>;
  closed: boolean;
};
const entries = new Map<string, Entry>(); // groupId별 채널

function close(groupId: string, entry: Entry) {
  entry.closed = true;
  entry.listeners.clear();
  entry.statusListeners.clear();
  entries.delete(groupId);
  void supabase.removeChannel(entry.channel);
}

// 비공개 채널은 로그인 토큰이 Realtime에 있어야 받을 수 있음 → 구독 전에 지금 토큰을 넘김 (이후 토큰 갱신은 supabase-js가 알아서 넘김)
async function open(entry: Entry) {
  const { data } = await supabase.auth.getSession();
  if (data.session) await supabase.realtime.setAuth(data.session.access_token);
  if (entry.closed) return; // 토큰을 기다리는 동안 구독을 풀었음
  entry.channel.subscribe((status) => entry.statusListeners.forEach((listener) => listener(status as SubscribeStatus)));
}

// 그룹 기상 신호를 받기 시작 — 돌려주는 함수로 끊음 (useEffect 정리에 그대로 씀)
export function subscribeGroupWake(groupId: string, onRefresh: (signal: WakeSignal) => void, onStatus?: (status: SubscribeStatus) => void): () => void {
  let entry = entries.get(groupId);
  if (!entry) {
    const channel = supabase.channel(wakeChannelName(groupId), { config: { private: true } });
    const created: Entry = { channel, listeners: new Set(), statusListeners: new Set(), closed: false };
    channel.on('broadcast', { event: 'refresh' }, ({ payload }) => {
      const signal = readWakeSignal(payload);
      created.listeners.forEach((listener) => listener(signal));
    });
    entries.set(groupId, created);
    entry = created;
    open(created).catch(() => created.statusListeners.forEach((listener) => listener('CHANNEL_ERROR')));
  }
  const current = entry;
  current.listeners.add(onRefresh);
  if (onStatus) current.statusListeners.add(onStatus);
  return () => {
    current.listeners.delete(onRefresh);
    if (onStatus) current.statusListeners.delete(onStatus);
    if (!current.listeners.size && entries.get(groupId) === current) close(groupId, current);
  };
}

// 구독 전부 끊음 — 로그아웃 정리
export function unsubscribeAll() {
  for (const [groupId, entry] of [...entries]) close(groupId, entry);
}
