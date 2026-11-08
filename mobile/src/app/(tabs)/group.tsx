import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, Chip, confirm, EmptyState, LoadError, Loading, Screen, SectionHeader, Segmented, Text, toast, TopBar, TopBarButton } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { ChangeHandleSheet } from '@/features/profile/components/ChangeHandleSheet';
import { handleHint } from '@/features/profile/handle';
import {
  acceptFriend,
  cancelFriendRequest,
  declineFriend,
  listFriendRequests,
  listFriends,
  listGroups,
  listSentRequests,
  myFriendLink,
  searchPeople,
  sendFriendRequest,
} from '@/features/social/api';
import { ActionTile } from '@/features/social/components/ActionTile';
import { GroupIcon } from '@/features/social/components/GroupIcon';
import { MiniButton } from '@/features/social/components/MiniButton';
import { MyHandleCard } from '@/features/social/components/MyHandleCard';
import { Note } from '@/features/social/components/Note';
import { PeopleSearchResults } from '@/features/social/components/PeopleSearchResults';
import { PersonMenuSheet } from '@/features/social/components/PersonMenuSheet';
import { PersonRow } from '@/features/social/components/PersonRow';
import { relationFromLists } from '@/features/social/searchView';
import { SearchBox } from '@/features/social/components/SearchBox';
import { useWakeLoad } from '@/features/social/hooks/useGroupWake';
import { usePersonMenu } from '@/features/social/hooks/usePersonMenu';
import { shareFriendInvite } from '@/features/social/invite';
import { friendLinkUrl } from '@/features/social/inviteLink';
import { permissionNames } from '@/features/social/permissions';
import type { FriendItem, GroupItem, PeopleSearch, Person } from '@/features/social/types';
import { now } from '@/lib/clock';
import { josa } from '@/lib/format';
import { useAction } from '@/lib/useAction';

type Tab = 'friend' | 'group';

const TABS = [
  ['friend', '친구'],
  ['group', '그룹'],
] as const;

// date = 그룹 기상 신호가 알려 준 날 (오늘 기상 수만 씀, 없으면 오늘)
async function loadSocial(date: string | null) {
  const [friends, requests, sent, groups] = await Promise.all([listFriends(), listFriendRequests(), listSentRequests(), listGroups(date)]);
  return { friends, requests, sent, groups };
}

// G01 친구와 그룹 — 친구 탭(목업 F01: 요청 수락 · 친구별 권한 수) · 그룹 탭(목업 G01: 참여 중인 그룹 · 오늘 기상 수)
// 홈 · 기상 확인에서 그룹 상세를 열 때 이 탭이 '그룹' 칸으로 밑에 깔림 (lib/nav openGroupDetail, ?seg=group&open=… — 목업 A.openGroup)
export default function GroupScreen() {
  const { seg, open } = useLocalSearchParams<{ seg?: string; open?: string }>();
  // 직접 고른 칸은 같은 열기 요청일 때만 유지 — 다른 화면이 새로 열면(open 값이 바뀜) 그 칸(seg)으로 (목업 A.openGroup)
  const request = `${seg ?? ''}:${open ?? ''}`;
  const [picked, setPicked] = useState<{ request: string; tab: Tab } | null>(null);
  const tab: Tab = picked && picked.request === request ? picked.tab : seg === 'group' ? 'group' : 'friend';
  const setTab = (next: Tab) => setPicked({ request, tab: next });
  const { data, error, reload } = useWakeLoad(loadSocial, (d) => d.groups.map((g) => g.id)); // 그룹 기상 신호가 오면 오늘 기상 수를 다시 읽음
  const { run } = useAction();
  const [workingId, setWorkingId] = useState<string | null>(null); // 수락 · 거절 · 취소 처리 중인 사람 — 그 줄 버튼에만 돌아가는 표시

  // 요청 수락 · 거절 · 취소 한 번 — 끝나면(실패해도) 목록을 새로 읽음. 상대가 그 사이 취소했으면 "이미 처리됐을 수 있어요"(3-28)
  const act = (p: Person, task: () => Promise<void>, fallback: string) =>
    run(async () => {
      setWorkingId(p.id);
      try {
        await task();
      } finally {
        setWorkingId(null);
        await reload();
      }
    }, fallback);

  const accept = (p: Person) =>
    act(
      p,
      async () => {
        await acceptFriend(p.id);
        // 공유는 아직 없으므로 바로 범위를 정하러 갈 수 있게
        toast(`${p.name}님과 친구가 됐어요`, {
          actionLabel: '공유 범위 정하기',
          onAction: () => router.push({ pathname: '/permissions', params: { relation: `friend:${p.id}` } }),
        });
      },
      '수락하지 못했어요. 다시 해 주세요',
    );
  const decline = (p: Person) => act(p, () => declineFriend(p.id), '거절하지 못했어요. 다시 해 주세요');
  const cancel = (p: Person) => act(p, () => cancelFriendRequest(p.id), '취소하지 못했어요. 다시 해 주세요');

  return (
    <Screen onRefresh={reload}>
      <TopBar
        screenId={tab === 'friend' ? 'F01' : 'G01'}
        right={<TopBarButton label="권한 관리" onPress={() => router.push('/permissions')} />}
      />
      <Text variant="title" style={styles.title}>
        친구와 그룹
      </Text>
      <Text variant="lead" style={styles.lead}>
        {tab === 'friend' ? '관계를 만들고 서로 공유할 정보를 관리해요.' : '목적에 맞는 그룹을 만들고 공유 범위를 정해요.'}
      </Text>
      <Segmented options={TABS} value={tab} onChange={setTab} />

      {!data ? error ? <LoadError onRetry={reload} /> : <Loading /> : null}
      {data && tab === 'friend' ? (
        <FriendTab
          friends={data.friends}
          requests={data.requests}
          sent={data.sent}
          onAccept={accept}
          onDecline={decline}
          onCancel={cancel}
          onSent={async () => {
            await reload();
          }}
          workingId={workingId}
        />
      ) : null}
      {data && tab === 'group' ? <GroupTab groups={data.groups} /> : null}
    </Screen>
  );
}

// 친구 탭 — 내 아이디 · 친구 링크 · 검색 · 받은 요청 · 내 친구(내가 준 권한 수)
function FriendTab({
  friends,
  requests,
  sent,
  onAccept,
  onDecline,
  onCancel,
  onSent,
  workingId,
}: {
  friends: FriendItem[];
  requests: Person[];
  sent: Person[];
  onAccept: (p: Person) => void;
  onDecline: (p: Person) => void;
  onCancel: (p: Person) => void;
  onSent: () => Promise<void>; // 검색 결과에서 요청을 보낸 뒤 목록을 새로 읽음
  workingId: string | null;
}) {
  const { session, profile, enabled } = useAuth();
  const { run, busy } = useAction();
  const [search, setSearch] = useState<PeopleSearch | null>(null);
  const [requestingId, setRequestingId] = useState<string | null>(null); // 친구 요청 보내는 중인 사람
  const [handleOpen, setHandleOpen] = useState(false);
  // 사람 줄 메뉴 [차단] [신고] — 차단하면 받은 요청 · 친구 · 검색 결과에서 빠지므로 결과를 비우고 목록을 새로 읽음 (4-06 · 4-32)
  const menu = usePersonMenu(() => {
    setSearch(null);
    onSent();
  });
  const [focusSearch, setFocusSearch] = useState(0); // [친구 찾기]를 누르면 검색칸으로 (값이 바뀔 때마다)
  const canEditHandle = enabled && session != null && profile != null;
  const hint = profile ? handleHint({ changedAt: profile.handle_changed_at, nextChangeAt: profile.handle_next_change_at }, now()) : null;

  // 검색 결과의 관계 — 친구 · 받은 요청 · 보낸 요청 목록에서 매번 계산 (요청 · 수락 · 거절 · 취소 · 끊기 뒤 목록을 새로 읽으면 결과 줄도 맞게 바뀜)
  const shown = useMemo<PeopleSearch | null>(() => {
    if (!search) return null;
    const lists = { friends: friends.map((f) => f.person.id), requests: requests.map((p) => p.id), sent: sent.map((p) => p.id) };
    return { ...search, rows: search.rows.map((row) => ({ ...row, relation: relationFromLists(row.person.id, lists) })) };
  }, [search, friends, requests, sent]);

  const runSearch = (text: string) =>
    run(async () => {
      if (!text.trim()) {
        setSearch(null);
        return;
      }
      setSearch(await searchPeople(text));
    }, '검색하지 못했어요. 다시 해 주세요');

  const request = (p: Person) =>
    run(async () => {
      setRequestingId(p.id);
      try {
        const relation = await sendFriendRequest(p.id);
        toast(relation === 'FRIEND' ? `${p.name}님과 친구가 됐어요` : `${p.name}님에게 친구 요청을 보냈어요`);
        await onSent(); // 목록을 새로 읽으면 결과 줄이 [요청 보냄] · 친구로 바뀜
      } finally {
        setRequestingId(null);
      }
    }, '친구 요청을 보내지 못했어요');

  const shareLink = () =>
    run(async () => {
      const link = await myFriendLink();
      await shareFriendInvite({ nickname: profile?.nickname ?? '', handle: profile?.handle, url: friendLinkUrl(link.token) });
    }, '링크를 만들지 못했어요');

  const renewLink = () =>
    run(async () => {
      const ok = await confirm({ title: '친구 링크를 새로 만들까요?', message: '지금 링크는 바로 쓸 수 없게 돼요.', okLabel: '새로 만들기' });
      if (!ok) return;
      await myFriendLink(true);
      toast('새 링크를 만들었어요. [공유]로 보내 보세요');
    }, '링크를 만들지 못했어요');

  const inviteByMessage = () => void shareFriendInvite({ nickname: profile?.nickname ?? '', handle: profile?.handle });

  return (
    <>
      <MyHandleCard
        handle={profile?.handle ?? null}
        highlight={hint?.highlight ?? false}
        onChange={canEditHandle ? () => setHandleOpen(true) : undefined}
        onShare={shareLink}
        onRenew={renewLink}
      />
      <ChangeHandleSheet visible={handleOpen} onClose={() => setHandleOpen(false)} />
      <PersonMenuSheet {...menu.sheetProps} />

      <SearchBox
        placeholder="이름 또는 사용자 ID 검색"
        actionLabel="검색"
        onAction={runSearch}
        onChangeText={(text) => {
          if (!text.trim()) setSearch(null);
        }}
        busy={busy}
        focusSignal={focusSearch}
      />
      {shown ? (
        <PeopleSearchResults
          search={shown}
          busyId={requestingId ?? workingId}
          onRequest={request}
          onAccept={onAccept}
          onInvite={inviteByMessage}
          onMenu={menu.open}
        />
      ) : null}

      {requests.map((p) => (
        <Card key={p.id}>
          <View style={styles.row}>
            <Avatar initial={p.initial} />
            <View style={styles.grow}>
              <Text variant="bodyStrong">{p.name}</Text>
              <Text variant="small" tone="sub">
                {p.handle ?? p.name}의 친구 요청
              </Text>
            </View>
          </View>
          <View style={styles.requestActions}>
            <Button variant="plain" label="거절" small disabled={workingId !== null} onPress={() => onDecline(p)} />
            <Button label="수락" small loading={workingId === p.id} disabled={workingId !== null && workingId !== p.id} onPress={() => onAccept(p)} />
            <MiniButton label="···" accessibilityLabel={`${p.name}님 메뉴`} onPress={() => menu.open(p)} />
          </View>
        </Card>
      ))}

      {sent.length ? (
        <>
          <SectionHeader title="보낸 요청" right={`${sent.length}명`} />
          <Card>
            {sent.map((p, i) => (
              <PersonRow
                key={p.id}
                first={i === 0}
                icon={<Avatar initial={p.initial} />}
                title={p.name}
                sub={p.handle ?? undefined}
                right={<Button variant="ghost" label="취소" small loading={workingId === p.id} disabled={workingId !== null && workingId !== p.id} onPress={() => onCancel(p)} />}
              />
            ))}
          </Card>
        </>
      ) : null}

      <SectionHeader title="내 친구" right={`${friends.length}명`} />
      {friends.length ? (
        <Card>
          {friends.map(({ person: p, grantCount }, i) => (
            <PersonRow
              key={p.id}
              first={i === 0}
              icon={<Avatar initial={p.initial} />}
              title={p.name}
              sub={p.handle ?? undefined}
              right={<Trailing label={grantCount ? `권한 ${grantCount}개` : '공유 없음'} />}
              onPress={() => router.push({ pathname: '/friends/[id]', params: { id: p.id } })}
            />
          ))}
        </Card>
      ) : (
        <EmptyState
          title="아직 친구가 없어요"
          body="이름이나 사용자 ID로 검색해 친구를 추가해 보세요."
          action={requests.length || sent.length ? undefined : { label: '친구 찾기', onPress: () => setFocusSearch((n) => n + 1) }} // 친구 0 · 요청 0일 때만 (3-21)
        />
      )}
      <Note>친구는 역할이 아닌 관계예요. 친구가 되어도 알람과 기상 상태는 권한을 허용한 뒤에만 볼 수 있어요.</Note>
    </>
  );
}

// 그룹 탭 — 만들기 · 참여(아직 없음 — 누르면 "곧 열려요") · 참여 중인 그룹
// 기상 상태를 볼 수 있는 그룹(받은 권한)만 그룹 상세로 들어가고, 아니면 안내만 (목업 G01 우리 가족)
function GroupTab({ groups }: { groups: GroupItem[] }) {
  return (
    <>
      <View style={styles.tiles}>
        <ActionTile
          dark
          icon="+"
          title="새 그룹 만들기"
          sub="이름과 멤버 설정"
          onPress={() => router.push('/groups/new')}
        />
        <ActionTile
          icon="↳"
          title="그룹 참여하기"
          sub="초대 코드 입력"
          onPress={() => router.push('/groups/join')}
        />
      </View>

      <SectionHeader title="참여 중인 그룹" right={`${groups.length}개`} />
      {groups.length ? null : <EmptyState title="아직 참여한 그룹이 없어요" body="새 그룹을 만들거나 초대 코드로 참여해 보세요." />}
      {groups.map((g) => {
        if (!g.canSeeWake) {
          return (
            <Card key={g.id} onPress={() => toast(`${josa(g.name, '은', '는')} 공유 권한이 없어 기상 상태를 볼 수 없어요`)}>
              <View style={styles.row}>
                <GroupIcon label={g.initial} light />
                <View style={styles.grow}>
                  <Text variant="big">
                    {g.name}
                  </Text>
                  <Text variant="small" tone="sub">
                    {g.memberCount}명 · 공유 없음
                  </Text>
                </View>
                <Text variant="body" tone="faint">
                  →
                </Text>
              </View>
            </Card>
          );
        }
        const names = permissionNames(g.grants);
        return (
          <Card key={g.id} onPress={() => router.push({ pathname: '/groups/[id]', params: { id: g.id } })}>
            <View style={styles.between}>
              <GroupIcon label={g.initial} />
              <Text variant="body" tone="faint">
                →
              </Text>
            </View>
            <Text variant="big" style={styles.groupNameTop}>
              {g.name}
            </Text>
            <Text variant="small" tone="sub" style={styles.groupSub}>
              {g.memberCount}명 · 오늘 {g.wokeCount}명 기상 완료
            </Text>
            <View style={styles.chips}>
              {(names.length ? names : ['공유 없음']).map((name) => (
                <Chip key={name} label={name} />
              ))}
            </View>
          </Card>
        );
      })}
    </>
  );
}

// 줄 오른쪽 — 권한 수와 화살표 (피그마 F01)
function Trailing({ label }: { label: string }) {
  return (
    <View style={styles.trailing}>
      <Text variant="label" tone="sub" weight={600}>
        {label}
      </Text>
      <Text variant="body" tone="faint">
        →
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, minWidth: 0 },
  requestActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 10 },
  between: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  trailing: { alignItems: 'flex-end' },
  tiles: { flexDirection: 'row', gap: 10, marginTop: 14 },
  groupNameTop: { marginTop: 10 },
  groupSub: { marginTop: 2, marginBottom: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
