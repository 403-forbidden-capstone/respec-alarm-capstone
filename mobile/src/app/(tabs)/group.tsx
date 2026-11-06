import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, Chip, EmptyState, LoadError, Loading, Screen, SectionHeader, Segmented, Text, toast, TopBar, TopBarButton } from '@/components/ui';
import { acceptFriend, listFriendRequests, listFriends, listGroups } from '@/features/social/api';
import { ActionTile } from '@/features/social/components/ActionTile';
import { GroupIcon } from '@/features/social/components/GroupIcon';
import { Note } from '@/features/social/components/Note';
import { PersonRow } from '@/features/social/components/PersonRow';
import { SearchBox } from '@/features/social/components/SearchBox';
import { useWakeLoad } from '@/features/social/hooks/useGroupWake';
import { permissionNames } from '@/features/social/permissions';
import type { FriendItem, GroupItem, Person } from '@/features/social/types';
import { josa } from '@/lib/format';
import { useAction } from '@/lib/useAction';

type Tab = 'friend' | 'group';

const TABS = [
  ['friend', '친구'],
  ['group', '그룹'],
] as const;

// date = 그룹 기상 신호가 알려 준 날 (오늘 기상 수만 씀, 없으면 오늘)
async function loadSocial(date: string | null) {
  const [friends, requests, groups] = await Promise.all([listFriends(), listFriendRequests(), listGroups(date)]);
  return { friends, requests, groups };
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
  const [acceptingId, setAcceptingId] = useState<string | null>(null); // 수락 처리 중인 요청 — 그 버튼에만 돌아가는 표시

  const accept = (p: Person) =>
    run(async () => {
      setAcceptingId(p.id);
      try {
        await acceptFriend(p.id);
        // 공유는 아직 없으므로 바로 범위를 정하러 갈 수 있게
        toast(`${p.name}님과 친구가 됐어요`, {
          actionLabel: '공유 범위 정하기',
          onAction: () => router.push({ pathname: '/permissions', params: { relation: `friend:${p.id}` } }),
        });
        await reload();
      } finally {
        setAcceptingId(null);
      }
    });

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
      {data && tab === 'friend' ? <FriendTab friends={data.friends} requests={data.requests} onAccept={accept} acceptingId={acceptingId} /> : null}
      {data && tab === 'group' ? <GroupTab groups={data.groups} /> : null}
    </Screen>
  );
}

// 친구 탭 — 검색 · 받은 요청 · 내 친구(내가 준 권한 수)
function FriendTab({
  friends,
  requests,
  onAccept,
  acceptingId,
}: {
  friends: FriendItem[];
  requests: Person[];
  onAccept: (p: Person) => void;
  acceptingId: string | null;
}) {
  return (
    <>
      <SearchBox
        placeholder="이름 또는 사용자 ID 검색"
        actionLabel="추가"
        onAction={() => toast('친구 검색은 곧 열려요')}
      />

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
            <Button label="수락" small loading={acceptingId === p.id} disabled={acceptingId !== null && acceptingId !== p.id} onPress={() => onAccept(p)} />
          </View>
        </Card>
      ))}

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
        <EmptyState title="아직 친구가 없어요" body="이름이나 사용자 ID로 검색해 친구를 추가해 보세요." />
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
  between: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  trailing: { alignItems: 'flex-end' },
  tiles: { flexDirection: 'row', gap: 10, marginTop: 14 },
  groupNameTop: { marginTop: 10 },
  groupSub: { marginTop: 2, marginBottom: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
