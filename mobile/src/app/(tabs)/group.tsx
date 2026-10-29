import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, Chip, EmptyState, LoadError, Loading, Screen, SectionHeader, Segmented, Sheet, Text, toast, TopBar } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { useAuth } from '@/features/auth/AuthProvider';
import { HandleChangeSheet } from '@/features/profile/components/HandleChangeSheet';
import {
  acceptFriend,
  createGroup,
  joinGroupByCode,
  listFriendRequests,
  listFriends,
  listGroups,
  searchByHandle,
  sendFriendRequest,
} from '@/features/social/api';
import { ActionTile } from '@/features/social/components/ActionTile';
import { CreateGroupSheet } from '@/features/social/components/CreateGroupSheet';
import { GroupIcon } from '@/features/social/components/GroupIcon';
import { HandleSearchResult } from '@/features/social/components/HandleSearchResult';
import { JoinGroupSheet } from '@/features/social/components/JoinGroupSheet';
import { MyHandleRow } from '@/features/social/components/MyHandleRow';
import { Note } from '@/features/social/components/Note';
import { PersonRow } from '@/features/social/components/PersonRow';
import { SearchBox } from '@/features/social/components/SearchBox';
import { cleanHandle, HANDLE_RULE, isValidHandle } from '@/features/social/draft';
import { useWakeLoad } from '@/features/social/hooks/useGroupWake';
import { permissionNames } from '@/features/social/permissions';
import type { FriendItem, GroupItem, HandleSearchResult as SearchHit, Person } from '@/features/social/types';
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
  const { profile } = useAuth();

  // 받은 요청 목록 · 친구 추가 시트의 [수락]이 같이 씀 (실패는 부른 쪽의 useAction이 토스트로)
  const acceptRequest = async (p: Person) => {
    await acceptFriend(p.id);
    // 공유는 아직 없으므로 바로 범위를 정할 수 있게
    toast(`${p.name}님과 친구가 됐어요`, {
      actionLabel: '공유 범위 정하기',
      onAction: () => router.push({ pathname: '/permissions', params: { relation: `friend:${p.id}` } }),
    });
    await reload();
  };

  return (
    <Screen onRefresh={reload}>
      <TopBar
        screenId={tab === 'friend' ? 'F01' : 'G01'}
        right={<TextLink label="권한 관리" onPress={() => router.push('/permissions')} />}
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
        <FriendTab friends={data.friends} requests={data.requests} handle={profile?.handle ?? null} onAcceptRequest={acceptRequest} />
      ) : null}
      {data && tab === 'group' ? <GroupTab groups={data.groups} onChanged={reload} /> : null}
    </Screen>
  );
}

type FriendTabProps = {
  friends: FriendItem[];
  requests: Person[];
  handle: string | null; // 내 아이디 (@ 없이)
  onAcceptRequest: (p: Person) => Promise<void>;
};

// 친구 탭 — 내 아이디 · 아이디로 찾기 (U01) · 받은 요청 · 내 친구(내가 준 권한 수)
// 찾은 사람은 "친구 추가" 시트에 칸으로 보임 — 나중에 초대 링크 칸 등을 이 시트 안에 더 붙일 수 있게 칸마다 부품으로 나눔
function FriendTab({ friends, requests, handle, onAcceptRequest }: FriendTabProps) {
  const [changingHandle, setChangingHandle] = useState(false);
  const [found, setFound] = useState<{ result: SearchHit | null } | null>(null); // null = 시트 닫힘, result null = 못 찾음
  const [hint, setHint] = useState<string | null>(null); // 아이디 모양이 틀렸을 때 검색칸 아래 안내
  const finder = useAction(); // 찾기 (읽기지만 두 번 누름 · 실패 토스트는 같이 막음)
  const writer = useAction(); // 받은 요청 수락 · 친구 요청 보내기

  const find = (text: string) => {
    const clean = cleanHandle(text);
    if (!isValidHandle(clean)) {
      setHint(HANDLE_RULE); // DB에 물을 필요가 없는 모양이면 부르지 않음
      return;
    }
    setHint(null);
    void finder.run(async () => {
      setFound({ result: await searchByHandle(clean) });
    }, '아이디를 찾지 못했어요. 다시 해 주세요');
  };

  // 보낸 요청으로 바꿔 보임 (가짜 모드는 앱을 다시 열면 사라짐)
  const request = (p: Person) =>
    writer.run(async () => {
      await sendFriendRequest(p.id);
      setFound((f) => (f?.result ? { result: { ...f.result, relation: 'SENT' } } : f));
    }, '친구 요청을 보내지 못했어요');

  const acceptFound = (p: Person) =>
    writer.run(async () => {
      await onAcceptRequest(p);
      setFound((f) => (f?.result ? { result: { ...f.result, relation: 'FRIEND' } } : f));
    });

  return (
    <>
      <MyHandleRow handle={handle} onChange={() => setChangingHandle(true)} />
      <SearchBox placeholder="아이디로 찾기" actionLabel="찾기" onAction={find} />
      {hint ? (
        <Text variant="caption" tone="warn" style={styles.hint}>
          {hint}
        </Text>
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
            <Button label="수락" small onPress={() => writer.run(() => onAcceptRequest(p))} />
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
        <EmptyState title="아직 친구가 없어요" body="친구의 아이디로 찾아 친구를 추가해 보세요." />
      )}
      <Note>친구는 역할이 아닌 관계예요. 친구가 되어도 알람과 기상 상태는 권한을 허용한 뒤에만 볼 수 있어요.</Note>

      <Sheet visible={found != null} onClose={() => setFound(null)} title="친구 추가">
        <View style={styles.sections}>
          <HandleSearchResult result={found?.result ?? null} busy={writer.busy} onRequest={request} onAccept={acceptFound} />
        </View>
      </Sheet>
      <HandleChangeSheet
        visible={changingHandle}
        onClose={() => setChangingHandle(false)}
        current={handle}
        onSubmit={async () => {
          // L3 changeHandle 머지 뒤 연결 — 지금은 아이디를 바꾸는 함수가 없어 안내만
          toast('아이디 바꾸기는 곧 열려요');
          setChangingHandle(false);
        }}
      />
    </>
  );
}

// 그룹 탭 — 새 그룹 만들기 (U06) · 코드로 참여 (U07) · 참여 중인 그룹
// D21 기본안 B: 그룹 카드는 늘 상세로 들어감. 기상 상태를 볼 수 없는 그룹(받은 권한 없음)은 상세에서 기상 칸만 숨기고 이유를 알림
function GroupTab({ groups, onChanged }: { groups: GroupItem[]; onChanged: () => Promise<boolean> }) {
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);

  // 만들거나 참여한 직후의 그룹은 상세가 기상 공유 동의를 바로 물음 (D89 기본안 A — ?consent=1)
  const openNewGroup = (id: string) => {
    setCreating(false);
    setJoining(false);
    router.push({ pathname: '/groups/[id]', params: { id, consent: '1' } });
  };

  const create = async (name: string) => {
    const created = await createGroup(name);
    void onChanged(); // 시트 뒤 목록에도 바로 보이게
    return created;
  };

  const join = async (code: string) => {
    const groupId = await joinGroupByCode(code);
    openNewGroup(groupId); // 목록은 돌아올 때 다시 읽음
  };

  return (
    <>
      <View style={styles.tiles}>
        <ActionTile dark icon="+" title="새 그룹 만들기" sub="이름과 멤버 설정" onPress={() => setCreating(true)} />
        <ActionTile icon="↳" title="그룹 참여하기" sub="초대 코드 입력" onPress={() => setJoining(true)} />
      </View>

      <SectionHeader title="참여 중인 그룹" right={`${groups.length}개`} />
      {groups.length ? null : <EmptyState title="아직 참여한 그룹이 없어요" body="새 그룹을 만들거나 초대 코드로 참여해 보세요." />}
      {groups.map((g) => {
        if (!g.canSeeWake) {
          return (
            <Card key={g.id} onPress={() => router.push({ pathname: '/groups/[id]', params: { id: g.id } })}>
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

      <CreateGroupSheet visible={creating} onClose={() => setCreating(false)} onCreate={create} onOpenGroup={openNewGroup} />
      <JoinGroupSheet visible={joining} onClose={() => setJoining(false)} onJoin={join} />
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
  hint: { marginTop: -4, marginBottom: 12, marginHorizontal: 4 },
  sections: { gap: 12 },
  tiles: { flexDirection: 'row', gap: 10, marginTop: 14 },
  groupNameTop: { marginTop: 10 },
  groupSub: { marginTop: 2, marginBottom: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
