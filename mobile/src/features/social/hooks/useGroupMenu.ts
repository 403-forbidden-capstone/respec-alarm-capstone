import { useState } from 'react';

import { confirm, toast } from '@/components/ui';
import { userMessage } from '@/lib/errors';
import { useAction } from '@/lib/useAction';

import { getGroupCode, inviteToGroup, leaveGroup, listInvitableFriends, regenerateInviteCode, removeGroupMember, renameGroup, setGroupNotificationsOff } from '../api';
import { expiresLabel, LEFT_TOAST, leaveText, MEMBER_REMOVED_TOAST, removeMemberText, RENAMED_TOAST } from '../groupTexts';
import { shareInvite } from '../invite';
import type { GroupCode, GroupDetail, InvitableFriend, Person } from '../types';

// G02의 그룹 메뉴 · 새 코드 시트 · + 초대 시트 — 확인 창 · api 호출 · 토스트를 맡고, 시트들은 값 · 콜백만 받음 (친구 5장)
//   onChanged = 이름 · 멤버 · 알림 설정이 바뀐 뒤 화면이 상세를 다시 읽음, onLeft = 그룹에서 나온 뒤 화면을 떠남
export function useGroupMenu(group: GroupDetail, onChanged: () => void, onLeft: () => void) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState<GroupCode | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [friends, setFriends] = useState<InvitableFriend[] | null>(null);
  const [invitingId, setInvitingId] = useState<string | null>(null);
  const { busy, run } = useAction();

  const closeAll = () => {
    setMenuOpen(false);
    setCodeOpen(false);
    setInviteOpen(false);
  };

  // 시트 열 때의 읽기는 쓰기 버튼의 한 번에 하나 가드(run)와 따로 — 가드에 막혀 버려지면 시트가 로딩에 머묾
  const loadCode = async () => {
    try {
      setCode(await getGroupCode(group.id));
    } catch (e) {
      setCodeOpen(false); // 못 읽으면 빈 시트를 열어 두지 않음
      toast(userMessage(e, '코드를 불러오지 못했어요'));
    }
  };

  const openCode = () => {
    setMenuOpen(false);
    setInviteOpen(false);
    setCode(null);
    setCodeOpen(true);
    void loadCode();
  };

  const loadFriends = async () => {
    try {
      setFriends(await listInvitableFriends(group.id));
    } catch (e) {
      setInviteOpen(false);
      toast(userMessage(e, '친구 목록을 불러오지 못했어요'));
    }
  };

  const openInvite = () => {
    setFriends(null);
    setInviteOpen(true);
    void loadFriends();
  };

  const invite = async (f: InvitableFriend) => {
    setInvitingId(f.person.id);
    try {
      await run(async () => {
        await inviteToGroup(group.id, f.person.id);
        toast(`${f.person.name}님을 초대했어요`);
        await listInvitableFriends(group.id).then(setFriends, () => undefined); // 초대는 됐으니 목록 갱신이 실패해도 오류로 안 보임
      }, '초대하지 못했어요. 다시 해 주세요');
    } finally {
      setInvitingId(null);
    }
  };

  const newCode = () =>
    run(async () => {
      try {
        setCode(await regenerateInviteCode(group.id));
        toast('새 코드를 만들었어요');
      } catch (e) {
        setCode(null); // 새 코드는 만들어졌는데 읽기만 실패했을 수 있음 — 무효가 된 옛 코드를 그대로 두지 않고 다시 읽음
        void loadCode();
        throw e;
      }
    }, '새 코드를 만들지 못했어요. 다시 해 주세요');

  const share = () => {
    if (code) void shareInvite(group.name, code.code, expiresLabel(code.expiresAt));
  };

  const rename = (name: string) =>
    run(async () => {
      await renameGroup(group.id, name);
      setMenuOpen(false);
      toast(RENAMED_TOAST);
      onChanged();
    }, '이름을 바꾸지 못했어요. 다시 해 주세요');

  const notifications = (off: boolean) =>
    run(async () => {
      await setGroupNotificationsOff(group.id, off);
      setMenuOpen(false);
      toast(off ? '이 그룹 알림을 껐어요' : '이 그룹 알림을 켰어요');
      onChanged();
    }, '알림 설정을 바꾸지 못했어요. 다시 해 주세요');

  // 확인 창은 한 번에 하나 가드(run) 밖에서 — 확인 대기 중에는 busy가 켜지지 않음
  const remove = async (p: Person) => {
    setMenuOpen(false);
    const t = removeMemberText(p.name);
    if (!(await confirm({ title: t.title, message: t.body, okLabel: t.ok, destructive: true }))) return;
    await run(async () => {
      await removeGroupMember(group.id, p.id);
      toast(MEMBER_REMOVED_TOAST);
      onChanged();
    }, '내보내지 못했어요. 다시 해 주세요');
  };

  const leave = async () => {
    setMenuOpen(false);
    // n = 앞으로 약속 중 내가 참여한 것 — 나가면 그 알람만 지워지고 지난 약속 기록은 남음 (9-29 · 11/9 헤드 결정)
    const t = leaveText(group.name, group.appointments.filter((a) => a.iJoined && !a.past).length, group.members.length <= 1);
    if (!(await confirm({ title: t.title, message: t.body, okLabel: t.ok, destructive: true }))) return;
    await run(async () => {
      await leaveGroup(group.id);
      toast(LEFT_TOAST);
      onLeft();
    }, '나가지 못했어요. 다시 해 주세요');
  };

  const others = group.members.filter((m) => !m.isMe).map((m) => m.person);

  return {
    busy,
    openMenu: () => setMenuOpen(true),
    openInvite,
    menuProps: {
      group: menuOpen ? { id: group.id, name: group.name, notificationsOff: group.notificationsOff, others } : null,
      onClose: closeAll,
      onRename: rename,
      onCode: openCode,
      onRemove: remove,
      onLeave: leave,
      onNotifications: notifications,
    },
    codeProps: { visible: codeOpen, groupName: group.name, code, expiresLabel: code ? expiresLabel(code.expiresAt) : null, busy, onShare: share, onNewCode: newCode, onClose: closeAll },
    inviteProps: { visible: inviteOpen, groupName: group.name, friends, invitingId, onInvite: invite, onCode: openCode, onClose: closeAll },
  };
}
