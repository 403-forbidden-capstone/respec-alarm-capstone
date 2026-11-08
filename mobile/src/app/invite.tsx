import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, LoadError, Loading, Screen, Text, toast, TopBar, TopBarButton } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { acceptFriend, openFriendLink, sendFriendRequest } from '@/features/social/api';
import { Note } from '@/features/social/components/Note';
import { linkTokenOf } from '@/features/social/inviteLink';
import type { FriendRelation, OpenedLink, Person } from '@/features/social/types';
import { backOrHome } from '@/lib/nav';
import { setPendingInvite } from '@/lib/pendingInvite';
import { useAction } from '@/lib/useAction';
import { useLoad } from '@/lib/useLoad';

// 초대 · 친구 링크 착지 (새 화면) — 링크 / 카톡 메시지로 열림. /invite?t=토큰
//   친구 링크는 여기서 [친구 요청]을 눌러야 요청이 감 (열기만 해서는 안 감). 없는 · 옛 · 만료 · 탈퇴 · 차단 쌍은 모두 같은 "찾을 수 없어요" (2-라 · 4-가)
//   로그인 전이면 토큰을 적어 두고 로그인으로 보냄 — 로그인 뒤 루트 레이아웃이 같은 화면을 다시 엶 (lib/pendingInvite, 2-20)
//   그룹 초대 링크도 같은 화면을 쓸 예정 — 그룹 초대 링크가 생기면(5장) 가운데 내용만 바뀜
export default function InviteScreen() {
  const { t } = useLocalSearchParams<{ t?: string | string[] }>();
  const token = linkTokenOf(t);
  const { session, enabled, needsOnboarding, loading } = useAuth();
  const needsLogin = enabled && !session;
  const blocked = needsLogin || (enabled && needsOnboarding);

  // 로그인(또는 온보딩)이 먼저 — 토큰을 적어 두고 그쪽으로 보냄
  useEffect(() => {
    if (loading || !blocked) return;
    setPendingInvite(token);
    router.replace(needsLogin ? '/login' : '/onboarding');
  }, [loading, blocked, needsLogin, token]);

  if (loading || blocked) return <Loading />;
  return <Landing token={token} />;
}

function Landing({ token }: { token: string }) {
  const { data, error, reload } = useLoad(() => openFriendLink(token));
  const { busy, run } = useAction();
  const [done, setDone] = useState<FriendRelation | null>(null); // 이 화면에서 요청을 보냈거나 수락함

  const header = (
    <TopBar
      left={<TopBarButton label="닫기" onPress={backOrHome} />}
      right={
        <Text variant="label" tone="sub">
          초대
        </Text>
      }
    />
  );

  if (!data) {
    return (
      <Screen>
        {header}
        {error ? <LoadError onRetry={reload} /> : <Loading />}
      </Screen>
    );
  }
  if (data.status === 'EXPIRED') return <Expired header={header} />;

  const mine = data.status === 'SELF';
  const relation: FriendRelation = done ?? (data.status === 'OK' ? data.relation : 'NONE');

  const request = (p: Person) =>
    run(async () => {
      await sendFriendRequest(p.id);
      setDone('SENT');
    }, '친구 요청을 보내지 못했어요');

  const accept = (p: Person) =>
    run(async () => {
      await acceptFriend(p.id);
      setDone('FRIEND');
      toast(`${p.name}님과 친구가 됐어요`);
    }, '수락하지 못했어요');

  return (
    <Screen>
      {header}
      <View style={styles.center}>
        <Avatar initial={data.person.initial} />
        <Text variant="title" align="center" style={styles.title}>
          {data.status === 'SELF' ? '내 링크예요' : relationTitle(data, relation)}
        </Text>
        {data.person.handle ? (
          <Text variant="big" tone="sub">
            {data.person.handle}
          </Text>
        ) : null}
      </View>

      {mine ? (
        <Card variant="dash">
          <Text variant="note" tone="sub">
            이 링크를 받은 사람이 열면 내 아이디가 보이고 친구 요청을 보낼 수 있어요. 링크는 만든 날부터 7일 동안 쓸 수 있어요.
          </Text>
        </Card>
      ) : (
        <View style={styles.actions}>
          {relation === 'NONE' ? <Button label="친구 요청" onPress={() => request(data.person)} loading={busy} /> : null}
          {relation === 'RECEIVED' ? <Button label="수락" onPress={() => accept(data.person)} loading={busy} /> : null}
          {relation === 'SENT' || relation === 'FRIEND' ? (
            <Button label="친구 탭 열기" onPress={() => router.replace({ pathname: '/group', params: { seg: 'friend' } })} />
          ) : null}
          {relation === 'NONE' || relation === 'RECEIVED' ? <Button variant="plain" label="나중에" onPress={backOrHome} disabled={busy} /> : null}
        </View>
      )}
      {mine ? null : <Note>친구가 되어도 알람과 기상 상태는 권한을 허용한 뒤에만 볼 수 있어요.</Note>}
      {mine ? null : <Note>링크는 만든 날부터 7일 동안 쓸 수 있어요.</Note>}
    </Screen>
  );
}

function relationTitle(data: Extract<OpenedLink, { status: 'OK' }>, relation: FriendRelation): string {
  const name = data.person.name;
  switch (relation) {
    case 'SENT':
      return '요청을 보냈어요';
    case 'FRIEND':
      return '이미 친구예요';
    case 'RECEIVED':
      return `${name}님이 먼저 요청을 보냈어요`;
    default:
      return `${name}님이 친구가 되고 싶어 해요`;
  }
}

// 없는 링크 · 만료 · 차단 쌍 · 탈퇴한 사람이 모두 이 화면 하나 — 어느 경우인지 드러내지 않음
function Expired({ header }: { header: ReactNode }) {
  return (
    <Screen>
      {header}
      <View style={styles.center}>
        <Avatar initial="?" />
        <Text variant="title" align="center" style={styles.title}>
          찾을 수 없어요
        </Text>
        <Text variant="lead" align="center">
          링크가 만료됐거나 없는 링크예요. 보낸 사람에게 새 링크를 부탁해 보세요.
        </Text>
      </View>
      <View style={styles.actions}>
        <Button label="아이디로 친구 찾기" onPress={() => router.replace({ pathname: '/group', params: { seg: 'friend' } })} />
        <Button variant="plain" label="닫기" onPress={backOrHome} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: 8, marginTop: 24, marginBottom: 24 },
  title: { marginTop: 8 },
  actions: { gap: 4, marginBottom: 12 },
});
