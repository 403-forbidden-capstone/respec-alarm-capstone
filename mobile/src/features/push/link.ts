// 푸시 알림을 눌렀을 때 갈 화면 · 받았을 때 할 일 — 순수 함수 (친구 논리설계 11장 · 세션약속 1절 '푸시 종류 표')
//   서버가 알림 data에 kind · recipientUserId · path(+ groupId · appointmentId · subjectUserId · change · needsConfirm)를 실음
//   path는 서버 이름(/wake · /alarms · /friends · /group, 8장 깨우기는 /groups/<그룹 id>/members/<사람 id>)이라 앱 화면 주소로 옮김
//   누르는 사람이 지금 로그인한 계정이 아니면(같은 폰의 다른 계정, 11-24) 홈 — 남의 알림 내용 화면을 열지 않음
import type { Href } from 'expo-router';

import { groupChangeAction } from '@/features/alarm/groupChange';
import { isPushData } from '@/lib/push/kinds';

export const HOME: Href = '/';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const GROUP_PATH = new RegExp(`^/groups/(${UUID})(?:/members/(${UUID}))?$`, 'i');

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

const groupHref = (groupId: string, userId?: string | null): Href =>
  userId
    ? { pathname: '/groups/[id]/members/[userId]', params: { id: groupId, userId } }
    : { pathname: '/groups/[id]', params: { id: groupId } };

// 누르면 갈 곳 — 푸시가 아니면(감지 안내 같은 로컬 알림) null (다른 처리가 맡음)
export function pushHref(data: unknown, me: string | null): Href | null {
  if (!isPushData(data)) return null;
  if (!me || data.recipientUserId !== me) return HOME;

  // 공동 약속 변경: 확인이 필요하면 확인 화면, 아니면(바뀜 · 취소) 그 그룹
  const change = groupChangeAction(data);
  const groupId = text(data.groupId);
  if (change?.type === 'CONFIRM') return { pathname: '/alarm/changed', params: { id: change.appointmentId } };
  if (change) return groupId ? groupHref(groupId) : { pathname: '/group' };

  const path = text(data.path);
  const direct = path ? GROUP_PATH.exec(path) : null;
  if (direct) return groupHref(direct[1], direct[2]); // 8장이 정확한 화면 주소를 줌 (깨우기 → 그 사람의 기상 확인)
  switch (path) {
    case '/wake':
      return '/wake';
    case '/alarms':
      return '/alarms';
    case '/friends':
      return { pathname: '/group' }; // 친구 목록 · 받은 요청은 그룹 탭 안
    case '/group': {
      if (!groupId) return { pathname: '/group' };
      return groupHref(groupId, text(data.subjectUserId)); // 미확인 알림(안 일어난 사람)은 그 사람의 기상 확인(G03)
    }
    default:
      return HOME;
  }
}

// 받았을 때(앞에 떠 있는 동안) · 눌러서 열었을 때 폰 알람을 서버와 다시 맞춰야 하는 알림인지
//   내 알람이 친구에게 바뀜 · 공동 약속 바뀜 / 취소 — 서버가 이미 DB를 고쳤으므로 받아 와서 폰에 걺 (확인이 필요한 것은 확인 화면이 저장)
export function needsAlarmSync(data: unknown, me: string | null): boolean {
  if (!isPushData(data) || !me || data.recipientUserId !== me) return false;
  if (data.kind === 'ALARM_CHANGED') return true;
  const change = groupChangeAction(data);
  return change != null && change.type !== 'CONFIRM';
}
