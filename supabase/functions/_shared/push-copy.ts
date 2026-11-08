// 푸시 종류 표 (친구 논리설계 11장) — 종류마다 문구 · 안드로이드 채널 · 누르면 갈 화면을 서버가 고정함 (Q10, 11-08)
//   앱이 보낸 제목 · 본문은 쓰지 않음(남이 쓴 문구가 알림이 되지 않게). 문구에 들어가는 건 이름뿐:
//     깨우기 · 알람 바뀜 → 보낸 사람 이름 / 그룹 알림 → 그룹 이름 · 약속 제목만(사람 이름 없음) / 요청 · 수락 · 미확인 → 고정 문구
//   채널 id는 `_v1` — 안드로이드 채널은 만든 뒤 설정을 못 바꿔서 바꿀 일이 생기면 `_v2`를 새로 만듦. 알람 코어 채널(detect_v1 등)과 겹치지 않음
//   path는 알림을 눌렀을 때 앱이 갈 화면(받는 사람 id가 지금 로그인한 계정과 맞을 때만, 아니면 홈 — 11-차). 화면 이름은 앱(S2)이 맞춤
// 순수 TS — 시험은 push-copy.test.ts
export const CLIENT_KINDS = ['WAKE_PING', 'ALARM_CHANGED', 'FRIEND_REQUEST', 'FRIEND_ACCEPTED', 'GROUP_MEMBER_JOINED', 'GROUP_APPT_CHANGED'] as const;
export const SERVER_ONLY_KINDS = ['WAKE_MISSED'] as const; // 앱이 부를 수 없고 5분 배치(wake-check)가 보냄
export const GROUP_KINDS = ['GROUP_MEMBER_JOINED', 'GROUP_APPT_CHANGED'] as const;

export type ClientKind = (typeof CLIENT_KINDS)[number];
export type PushKind = ClientKind | (typeof SERVER_ONLY_KINDS)[number];
export type GroupKind = (typeof GROUP_KINDS)[number];

export const isGroupKind = (kind: string): kind is GroupKind => (GROUP_KINDS as readonly string[]).includes(kind);

export const CHANNEL_IDS: Record<PushKind, string> = {
  WAKE_PING: 'friend_v1',
  ALARM_CHANGED: 'alarm_change_v1',
  FRIEND_REQUEST: 'request_v1',
  FRIEND_ACCEPTED: 'request_v1',
  GROUP_MEMBER_JOINED: 'group_v1',
  GROUP_APPT_CHANGED: 'group_v1',
  WAKE_MISSED: 'missed_v1',
};

// 누르면: 깨우기 · 미확인 → 내 기상 확인(H08), 알람 바뀜 → 받은 알람(G04), 요청 · 수락 → 친구(F01), 그룹 → 그룹(G02)
export const PATHS: Record<PushKind, string> = {
  WAKE_PING: '/wake',
  ALARM_CHANGED: '/alarms',
  FRIEND_REQUEST: '/friends',
  FRIEND_ACCEPTED: '/friends',
  GROUP_MEMBER_JOINED: '/group',
  GROUP_APPT_CHANGED: '/group',
  WAKE_MISSED: '/wake',
};

export type CopyContext = {
  senderName?: string | null;
  groupName?: string | null;
  appointmentTitle?: string | null;
  previousAt?: string | null; // 알람 바뀜: 이전 → 새 시각 (둘 다 있을 때만 문구에 넣음)
  newAt?: string | null;
  timeZone?: string | null; // 받는 사람 시간대 (기본 Asia/Seoul)
};

const NAME_MAX = 40;
const clip = (text: string, max = NAME_MAX): string => (text.length > max ? `${text.slice(0, max)}…` : text);
const nameOr = (value: string | null | undefined, fallback: string): string => {
  const t = (value ?? '').trim();
  return t ? clip(t) : fallback;
};

// "HH:mm" (받는 사람 시간대). 시각이 이상하면 null
function clock(iso: string | null | undefined, timeZone: string | null | undefined): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const format = (tz: string) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(at));
  try {
    return format(timeZone || 'Asia/Seoul');
  } catch {
    return format('Asia/Seoul'); // 모르는 시간대
  }
}

export function composeCopy(kind: PushKind, ctx: CopyContext): { title: string; body: string } {
  switch (kind) {
    case 'WAKE_PING':
      return { title: '깨우기', body: `${nameOr(ctx.senderName, '친구')}님이 깨워요` };
    case 'ALARM_CHANGED': {
      const who = `${nameOr(ctx.senderName, '친구')}님이 알람을 바꿨어요`;
      const from = clock(ctx.previousAt, ctx.timeZone);
      const to = clock(ctx.newAt, ctx.timeZone);
      return { title: '알람이 바뀌었어요', body: from && to ? `${who} · ${from} → ${to}` : who };
    }
    case 'FRIEND_REQUEST':
      return { title: '친구 요청', body: '새 친구 요청이 도착했어요' };
    case 'FRIEND_ACCEPTED':
      return { title: '친구 요청', body: '친구 요청이 수락됐어요' };
    case 'GROUP_MEMBER_JOINED':
      return { title: nameOr(ctx.groupName, '그룹'), body: '새 멤버가 들어왔어요' };
    case 'GROUP_APPT_CHANGED': {
      const title = (ctx.appointmentTitle ?? '').trim();
      return { title: nameOr(ctx.groupName, '그룹'), body: title ? `‘${clip(title)}’ 약속이 바뀌었어요` : '약속이 바뀌었어요' };
    }
    case 'WAKE_MISSED':
      return { title: '기상 확인', body: '기상 확인이 안 됐어요' };
  }
}
