import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, Share, StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, Chip, LoadError, Loading, Screen, SectionHeader, Sheet, Text, toast, TopBar } from '@/components/ui';
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
import { colors } from '@/theme';

// G02 그룹 상세 — 내가 이 그룹에 준 공유 범위 · 연결 일정 · 멤버 기상 상태
// 멤버의 기상 상태(G03) · 알람 보기(G04)는 그 사람에게 받은 권한(친구 · 그룹 합집합)이 있을 때만 열림 — 없으면 이유를 알림
export default function GroupDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, reload } = useLoad(() => getGroup(id));

  if (data === undefined) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} screenId="G02" />
        {error ? <LoadError onRetry={reload} /> : <Loading />}
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
  const [inviting, setInviting] = useState(false);

  // 연결 일정이 여러 개일 수 있어 "내 알람"은 늘 알람 목록으로 (작성자 판단 — 목업은 연결 일정 고정)
  const openMyAlarms = () => router.push('/alarms');

  // 코드를 다른 앱으로 보냄. 웹처럼 공유창이 없으면 코드를 길게 눌러 복사하도록 안내 (사용자가 창을 닫은 것은 오류가 아님)
  async function shareInvite() {
    try {
      await Share.share({ message: `Re:Spec 알람 '${g.name}' 그룹에 초대해요. 초대 코드: ${g.inviteCode}` });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
      toast('코드를 길게 눌러 복사해 주세요');
    }
  }

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
          {(grants.length ? grants : ['공유 없음']).map((name) => (
            <Chip key={name} label={name} />
          ))}
        </View>
      </Card>

      {g.appointments.length ? (
        <Card>
          <Text variant="label" tone="sub" style={styles.label}>
            연결 일정
          </Text>
          {g.appointments.map((a, i) => (
            <Pressable
              key={a.id}
              onPress={() => router.push({ pathname: '/alarm/[id]', params: { id: a.id } })}
              accessibilityRole="button"
              accessibilityLabel={`${a.title} 내 알람 보기`}
              style={({ pressed }) => [styles.linked, i > 0 && styles.divider, pressed && styles.pressed]}
            >
              <View style={styles.between}>
                <Text variant="big" style={styles.grow}>
                  {a.title}
                </Text>
                <Chip label={IMPORTANCE_LABEL[a.importance]} variant="fill" />
              </View>
              <Text variant="small" tone="sub" style={styles.sub}>
                {formatDateShort(a.at)} · {formatTime(a.at)} · {a.place}
              </Text>
              <Text variant="label" tone="sub" weight={600} style={styles.linkText}>
                내 알람 보기 ›
              </Text>
            </Pressable>
          ))}
        </Card>
      ) : null}

      <SectionHeader title="멤버 · 기상 상태" right={<TextLink label="+ 초대" onPress={() => setInviting(true)} strong />} />
      <Card>
        {g.members.map((m, i) => (
          <MemberRow key={m.person.id} member={m} groupId={g.id} first={i === 0} onMyAlarm={openMyAlarms} />
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

      <Sheet visible={inviting} onClose={() => setInviting(false)} title="그룹 초대">
        <Text variant="small" tone="sub">
          이 코드를 친구에게 보내면 {g.name}에 참여할 수 있어요.
        </Text>
        <View style={styles.codeBox}>
          <Text variant="stat" selectable accessibilityLabel={`초대 코드 ${g.inviteCode}`}>
            {g.inviteCode}
          </Text>
        </View>
        <Button label="공유하기" onPress={shareInvite} />
      </Sheet>
    </Screen>
  );
}

// 멤버 한 줄 — 기상 상태 조회 권한이 없으면 상태 글자 · 점을 숨김 (get_group_wake_status는 권한 있는 멤버만 돌려줌)
// 줄을 누르면 기상 상태(G03). 권한이 없으면 이유를 알림
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
  const name = m.person.short;
  const wakeReason = `${name}님이 기상 상태 공유를 허용하지 않았어요`;
  const alarmReason = `${name}님이 알람 공유를 허용하지 않았어요`;
  const openWake = () =>
    router.push({ pathname: '/groups/[id]/members/[userId]', params: { id: groupId, userId: m.person.id } });

  return (
    <PersonRow
      first={first}
      icon={<Avatar initial={m.person.initial} dot={canSee ? m.state.dot : undefined} />}
      title={m.person.name}
      sub={canSee ? m.state.text : '기상 상태를 볼 수 없어요'}
      onPress={m.isMe ? undefined : m.received.viewWake ? openWake : () => toast(wakeReason)}
      rightIsButtons
      right={
        m.isMe ? (
          <MiniButton label="내 알람" onPress={onMyAlarm} />
        ) : (
          <View style={styles.minis}>
            <MiniButton label="기상 상태" disabledReason={m.received.viewWake ? undefined : wakeReason} onPress={openWake} />
            <MiniButton
              label="알람 보기"
              disabledReason={m.received.viewAlarm ? undefined : alarmReason}
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
  grow: { flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  linked: { paddingVertical: 6 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line, marginTop: 6, paddingTop: 12 },
  pressed: { opacity: 0.6 },
  sub: { marginTop: 4 },
  linkText: { marginTop: 6 },
  minis: { flexDirection: 'row', gap: 8 },
  paragraph: { lineHeight: 20 },
  codeBox: {
    alignItems: 'center',
    marginVertical: 16,
    paddingVertical: 18,
    borderRadius: 16,
    backgroundColor: colors.chip,
  },
});
