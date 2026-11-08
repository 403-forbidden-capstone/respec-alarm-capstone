import { useState } from 'react';

import { confirm, toast } from '@/components/ui';
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

  const loadCode = () =>
    run(async () => {
      try {
        setCode(await getGroupCode(group.id));
      } catch (e) {
        setCodeOpen(false); // 못 읽으면 빈 시트를 열어 두지 않음 — 이유는 useAction이 토스트로
        throw e;
      }
    }, '코드를 불러오지 못했어요');

  const openCode = () => {
    setMenuOpen(false);
    setInviteOpen(false);
    setCode(null);
    setCodeOpen(true);
    void loadCode();
  };

  const loadFriends = () =>
    run(async () => {
      try {
        setFriends(await listInvitableFriends(group.id));
      } catch (e) {
        setInviteOpen(false);
        throw e;
      }
    }, '친구 목록을 불러오지 못했어요');

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
        setFriends(await listInvitableFriends(group.id));
      }, '초대하지 못했어요. 다시 해 주세요');
    } finally {
      setInvitingId(null);
    }
  };

  const newCode = () =>
    run(async () => {
      setCode(await regenerateInviteCode(group.id));
      toast('새 코드를 만들었어요');
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

  const remove = (p: Person) =>
    run(async () => {
      setMenuOpen(false);
      const t = removeMemberText(p.name);
      if (!(await confirm({ title: t.title, message: t.body, okLabel: t.ok, destructive: true }))) return;
      await removeGroupMember(group.id, p.id);
      toast(MEMBER_REMOVED_TOAST);
      onChanged();
    }, '내보내지 못했어요. 다시 해 주세요');

  const leave = () =>
    run(async () => {
      setMenuOpen(false);
      const t = leaveText(group.name, group.appointments.length, group.members.length <= 1);
      if (!(await confirm({ title: t.title, message: t.body, okLabel: t.ok, destructive: true }))) return;
      await leaveGroup(group.id);
      toast(LEFT_TOAST);
      onLeft();
    }, '나가지 못했어요. 다시 해 주세요');

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
