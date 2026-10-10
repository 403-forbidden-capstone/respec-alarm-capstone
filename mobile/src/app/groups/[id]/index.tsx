import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Avatar, Card, Chip, LoadError, Screen, SectionHeader, Text, toast, TopBar } from '@/components/ui';
import { IMPORTANCE_LABEL } from '@/features/alarm/types';
import { TextLink } from '@/features/alarm/components/TextLink';
import { getGroup } from '@/features/social/api';
import { MiniButton } from '@/features/social/components/MiniButton';
import { PersonRow } from '@/features/social/components/PersonRow';
import { permissionNames } from '@/features/social/permissions';
import type { GroupDetail, GroupMember } from '@/features/social/types';
import { formatDateShort, formatTime } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { backOrHome } from '@/lib/nav';

// G02 그룹 상세 — 내가 이 그룹에 준 공유 범위 · 연결 일정 · 멤버 기상 상태
// 멤버의 기상 확인(G03) · 알람 보기(G04)는 그 사람에게 받은 권한(친구 · 그룹 합집합)이 있을 때만 누름
export default function GroupDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, reload } = useLoad(() => getGroup(id));

  if (data === undefined) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} screenId="G02" />
        {error ? <LoadError onRetry={reload} /> : null}
      </Screen>
    );
  }
  if (data === null) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} screenId="G02" />
        <Text variant="body" tone="sub">
          그룹을 찾을 수 없어요.
        </Text>
      </Screen>
    );
  }
  return <Detail group={data} onBack={backOrHome} />;
}

function Detail({ group: g, onBack }: { group: GroupDetail; onBack?: () => void }) {
  const grants = permissionNames(g.grants);
  const a = g.appointment;

  // 연결 일정이 있으면 그 알람 설정(H03), 없으면 알람 목록 (작성자 판단 — 목업은 연결 일정 고정)
  const openMyAlarm = () =>
    a ? router.push({ pathname: '/alarm/[id]', params: { id: a.id } }) : router.push('/alarms');

  return (
    <Screen>
      <TopBar
        onBack={onBack}
        screenId="G02"
        right={<TextLink label="···" accessibilityLabel="그룹 메뉴" onPress={() => toast('그룹 메뉴는 이번 목업 범위 밖이에요')} />}
      />
      <Text variant="title" style={styles.title}>
        {g.name}
      </Text>
      <Text variant="lead" style={styles.lead}>
        {g.members.length}명 · {g.since}
      </Text>

      <Card>
        <View style={[styles.between, styles.label]}>
          <Text variant="label" tone="sub">
            그룹 공유 범위
          </Text>
          <TextLink
            label="+ 설정"
            onPress={() => router.push({ pathname: '/permissions', params: { relation: `group:${g.id}` } })}
          />
        </View>
        <View style={styles.chips}>
          {(grants.length ? grants : ['없음']).map((name) => (
            <Chip key={name} label={name} />
          ))}
        </View>
      </Card>

      {a ? (
        <Card onPress={openMyAlarm}>
          <Text variant="label" tone="sub" style={styles.label}>
            연결 일정
          </Text>
          <View style={styles.between}>
            <Text variant="big">{a.title}</Text>
            <Chip label={IMPORTANCE_LABEL[a.importance]} variant="fill" />
          </View>
          <Text variant="small" tone="sub" style={styles.sub}>
            {formatDateShort(a.at)} · {formatTime(a.at)} · {a.place}
          </Text>
        </Card>
      ) : null}

      <SectionHeader title="멤버 · 기상 상태" right={<TextLink label="+ 초대" onPress={() => toast('초대 링크를 복사했어요')} strong />} />
      <Card>
        {g.members.map((m, i) => (
          <MemberRow key={m.person.id} member={m} groupId={g.id} first={i === 0} onMyAlarm={openMyAlarm} />
        ))}
      </Card>

      <Card variant="dash">
        <Text variant="label" tone="sub" style={styles.label}>
          권한 안내
        </Text>
        <Text variant="small" tone="sub" style={styles.paragraph}>
          그룹에서 권한을 회수해도 친구 관계나 다른 그룹에서 같은 권한을 허용했다면 해당 사용자의 최종 권한은 유지돼요.
        </Text>
      </Card>
    </Screen>
  );
}

// 멤버 한 줄 — 기상 조회 권한이 없으면 상태 글자 · 점을 숨김 (get_group_wake_status는 권한 있는 멤버만 돌려줌)
function MemberRow({
  member: m,
  groupId,
  first,
  onMyAlarm,
}: {
  member: GroupMember;
  groupId: string;
  first: boolean;
  onMyAlarm: () => void;
}) {
  const canSee = m.isMe || m.received.viewWake;
  return (
    <PersonRow
      first={first}
      icon={<Avatar initial={m.person.initial} dot={canSee ? m.state.dot : undefined} />}
      title={m.person.name}
      sub={canSee ? m.state.text : '기상 상태를 볼 수 없어요'}
      right={
        m.isMe ? (
          <MiniButton label="내 알람" onPress={onMyAlarm} />
        ) : (
          <View style={styles.minis}>
            <MiniButton
              label="기상 확인"
              disabled={!m.received.viewWake}
              disabledHint="기상 상태 조회 권한이 없어요"
              onPress={() =>
                router.push({ pathname: '/groups/[id]/members/[userId]', params: { id: groupId, userId: m.person.id } })
              }
            />
            <MiniButton
              label="알람 보기"
              disabled={!m.received.viewAlarm}
              disabledHint="알람 조회 권한이 없어요"
              onPress={() => router.push({ pathname: '/friends/[id]/alarms', params: { id: m.person.id } })}
            />
          </View>
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  label: { marginBottom: 8 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  sub: { marginTop: 4 },
  minis: { flexDirection: 'row' },
  paragraph: { lineHeight: 20 },
});
