// 친구 링크 주소 · 초대 메시지 — 순수 함수 (시험: __tests__/search.test.ts)
//   링크는 /invite?t=토큰. 폰은 앱 주소(respecalarm://invite?t=…), 웹은 배포 주소가 같은 화면(app/invite.tsx)을 엶
//   메시지에는 닉네임 + 아이디를 넣음 — 앱이 없는 사람도 아이디를 보고 찾을 수 있게 (2-머)
import { Platform } from 'react-native';

// 공유하는 주소의 origin — 웹이면 지금 열린 주소, 아니면 운영 주소 (features/alarm/mapPicker와 같은 규칙)
const PRODUCTION_ORIGIN = 'https://respec-alarm-capstone.vmgfh878.workers.dev';

export function inviteOrigin(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return PRODUCTION_ORIGIN;
}

export function friendLinkUrl(token: string, origin: string = inviteOrigin()): string {
  return `${origin}/invite?t=${encodeURIComponent(token)}`;
}

// 주소의 ?t= 값 — 같은 이름이 여러 번 오면 첫 값, 앞뒤 공백은 떼고 대문자로(서버도 대소문자를 구분하지 않음). 없으면 빈 글자
export function linkTokenOf(param: string | string[] | undefined): string {
  const raw = Array.isArray(param) ? param[0] : param;
  return (raw ?? '').trim().toUpperCase();
}

export function friendInviteMessage({ nickname, handle, url }: { nickname: string; handle?: string | null; url?: string }): string {
  const lines = [`${nickname}님이 Re:Spec 알람에서 친구가 되고 싶어 해요.`];
  if (handle) lines.push(`아이디: @${handle}`);
  if (url) lines.push(url);
  return lines.join('\n');
}
