// 푸시 종류 표 (친구 논리설계 11장) — 종류마다 문구 · 안드로이드 채널 · 누르면 갈 화면을 서버가 고정함 (Q10, 11-08)
//   앱이 보낸 제목 · 본문은 쓰지 않음(남이 쓴 문구가 알림이 되지 않게). 문구에 들어가는 건 이름뿐:
//     깨우기 · 알람 바뀜 → 보낸 사람 이름 / 그룹 알림 → 그룹 이름 · 약속 제목만(사람 이름 없음) / 요청 · 수락 · 미확인 → 고정 문구 / 친구 미확인 · 후속 → 안 일어난 사람 이름
//   채널 id는 `_v1` — 안드로이드 채널은 만든 뒤 설정을 못 바꿔서 바꿀 일이 생기면 `_v2`를 새로 만듦. 알람 코어 채널(detect_v1 등)과 겹치지 않음
//   path는 알림을 눌렀을 때 앱이 갈 화면(받는 사람 id가 지금 로그인한 계정과 맞을 때만, 아니면 홈 — 11-차). 화면 이름은 앱(S2)이 맞춤
// 순수 TS — 시험은 push-copy.test.ts
export const CLIENT_KINDS = ['WAKE_PING', 'ALARM_CHANGED', 'FRIEND_REQUEST', 'FRIEND_ACCEPTED', 'GROUP_MEMBER_JOINED', 'GROUP_APPT_CHANGED'] as const;
export const SERVER_ONLY_KINDS = ['WAKE_MISSED', 'WAKE_NUDGE', 'WAKE_NUDGE_UP'] as const; // 앱이 부를 수 없고 5분 배치(wake-check)가 보냄: 본인 미확인 · 친구 '깨워 볼까요?' · 후속 '일어났어요'
export const GROUP_KINDS = ['GROUP_MEMBER_JOINED', 'GROUP_APPT_CHANGED'] as const;

export type ClientKind = (typeof CLIENT_KINDS)[number];
export type PushKind = ClientKind | (typeof SERVER_ONLY_KINDS)[number];
export type GroupKind = (typeof GROUP_KINDS)[number];
// 공동 약속 알림의 두 가지: 바뀜(시각 · 장소) / 취소됨(만든 사람이 지움). 서버 함수가 정해 알림 데이터 `change`에 싣고, 받은 폰이 알람을 맞추거나 지움 (9장)
export type GroupChange = 'CHANGED' | 'CANCELED';

export const isGroupKind = (kind: string): kind is GroupKind => (GROUP_KINDS as readonly string[]).includes(kind);

export const CHANNEL_IDS: Record<PushKind, string> = {
  WAKE_PING: 'friend_v1',
  ALARM_CHANGED: 'alarm_change_v1',
  FRIEND_REQUEST: 'request_v1',
  FRIEND_ACCEPTED: 'request_v1',
  GROUP_MEMBER_JOINED: 'group_v1',
  GROUP_APPT_CHANGED: 'group_v1',
  WAKE_MISSED: 'missed_v1',
  WAKE_NUDGE: 'friend_v1',
  WAKE_NUDGE_UP: 'friend_v1',
};

// 누르면: 깨우기 · 본인 미확인 → 내 기상 확인(H08), 알람 바뀜 → 받은 알람(G04), 요청 · 수락 → 친구(F01), 그룹 → 그룹(G02), 친구 미확인 · 후속 → 그 사람의 기상 확인(G03, 그룹 id + 사람 id가 알림 데이터에)
export const PATHS: Record<PushKind, string> = {
  WAKE_PING: '/wake',
  ALARM_CHANGED: '/alarms',
  FRIEND_REQUEST: '/friends',
  FRIEND_ACCEPTED: '/friends',
  GROUP_MEMBER_JOINED: '/group',
  GROUP_APPT_CHANGED: '/group',
  WAKE_MISSED: '/wake',
  WAKE_NUDGE: '/group',
  WAKE_NUDGE_UP: '/group',
};

export type CopyContext = {
  senderName?: string | null;
  subjectName?: string | null; // 친구 미확인 · 후속: 안 일어난(일어난) 사람 이름
  groupName?: string | null;
  appointmentTitle?: string | null;
  previousAt?: string | null; // 알람 바뀜(제안): 이전 → 새 시각 (둘 다 있을 때만 문구에 넣음)
  newAt?: string | null;
  alarmType?: string | null; // 알람 바뀜(제안): 기상 · 준비 · 출발 · 도착
  now?: Date; // 알람 바뀜(제안): '오늘 · 내일 · 모레'를 가를 기준 시각 (기본 지금)
  timeZone?: string | null; // 받는 사람 시간대 (기본 Asia/Seoul)
  change?: GroupChange; // GROUP_APPT_CHANGED: 취소됐으면 문구가 '취소됐어요'
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

// "H:mm" (받는 사람 시간대, 앞 0 없음 — '7:30 → 7:00'). 시각이 이상하면 null
function clockShort(iso: string | null | undefined, timeZone: string | null | undefined): string | null {
  const full = clock(iso, timeZone);
  return full ? full.replace(/^0/, '') : null;
}

// 시각 뒤 '으로 / 로' — 마지막 숫자를 읽었을 때 받침이 있으면(영 · 삼 · 육) '으로', 없으면(일 이 사 오 칠 팔 구) '로'. 7:00 → 으로, 7:55 → 로
const particleFor = (time: string): string => (/[036]$/.test(time) ? '으로' : '로');

const ALARM_LABELS: Record<string, string> = { WAKE: '기상', PREPARE: '준비', DEPARTURE: '출발', ARRIVE: '도착' };

// '오늘 · 내일 · 모레', 그 밖은 'M월 D일' (받는 사람 시간대의 날짜). 날짜를 못 읽으면 빈 글자
function dayWord(iso: string | null | undefined, now: Date | undefined, timeZone: string | null | undefined): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return '';
  const tz = (() => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'Asia/Seoul' });
      return timeZone || 'Asia/Seoul';
    } catch {
      return 'Asia/Seoul';
    }
  })();
  const ymd = (d: Date) => {
    const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }).formatToParts(d);
    const pick = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return { y: pick('year'), m: pick('month'), d: pick('day') };
  };
  const target = ymd(new Date(iso));
  const today = ymd(now ?? new Date());
  const days = Math.round((Date.UTC(target.y, target.m - 1, target.d) - Date.UTC(today.y, today.m - 1, today.d)) / 86_400_000);
  if (days === 0) return '오늘';
  if (days === 1) return '내일';
  if (days === 2) return '모레';
  return `${target.m}월 ${target.d}일`;
}

export function composeCopy(kind: PushKind, ctx: CopyContext): { title: string; body: string } {
  switch (kind) {
    case 'WAKE_PING':
      return { title: '깨우기', body: `${nameOr(ctx.senderName, '친구')}님이 깨워요` };
    case 'ALARM_CHANGED': {
      // 친구가 알람 시각을 '제안'했을 때 — 주인이 [적용]해야 바뀜 (친구 10장). 시각은 받는 사람 시간대의 H:mm
      const who = nameOr(ctx.senderName, '친구');
      const what = [dayWord(ctx.newAt, ctx.now, ctx.timeZone), ALARM_LABELS[ctx.alarmType ?? ''], '알람'].filter(Boolean).join(' ');
      const from = clockShort(ctx.previousAt, ctx.timeZone);
      const to = clockShort(ctx.newAt, ctx.timeZone);
      return { title: '알람 제안', body: from && to ? `${who}님이 ${what}을 ${from} → ${to}${particleFor(to)} 제안했어요` : `${who}님이 ${what}을 제안했어요` };
    }
    case 'FRIEND_REQUEST':
      return { title: '친구 요청', body: '새 친구 요청이 도착했어요' };
    case 'FRIEND_ACCEPTED':
      return { title: '친구 요청', body: '친구 요청이 수락됐어요' };
    case 'GROUP_MEMBER_JOINED':
      return { title: nameOr(ctx.groupName, '그룹'), body: '새 멤버가 들어왔어요' };
    case 'GROUP_APPT_CHANGED': {
      const title = (ctx.appointmentTitle ?? '').trim();
      const verb = ctx.change === 'CANCELED' ? '취소됐어요' : '바뀌었어요';
      return { title: nameOr(ctx.groupName, '그룹'), body: title ? `‘${clip(title)}’ 약속이 ${verb}` : `약속이 ${verb}` };
    }
    case 'WAKE_MISSED':
      return { title: '기상 확인', body: '기상 확인이 안 됐어요' };
    case 'WAKE_NUDGE':
      return { title: '깨워 볼까요?', body: `${nameOr(ctx.subjectName, '친구')}님이 아직 안 일어났어요` };
    case 'WAKE_NUDGE_UP':
      return { title: '일어났어요', body: `${nameOr(ctx.subjectName, '친구')}님이 일어났어요` };
  }
}
