import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, Chip, LoadError, Loading, Screen, SectionHeader, Text, toast, TopBar } from '@/components/ui';
import { IMPORTANCE_LABEL } from '@/features/alarm/types';
import { TextLink } from '@/features/alarm/components/TextLink';
import { getGroup } from '@/features/social/api';
import { AppointmentJoinersSheet } from '@/features/social/components/AppointmentJoinersSheet';
import { GroupCodeSheet } from '@/features/social/components/GroupCodeSheet';
import { GroupJoinSheet } from '@/features/social/components/GroupJoinSheet';
import { appointmentStateText, CREATOR_UNKNOWN, joinedCountText } from '@/features/social/groupTexts';
import { useGroupAppointments } from '@/features/social/hooks/useGroupAppointments';
import { GroupInviteSheet } from '@/features/social/components/GroupInviteSheet';
import { GroupMenuSheet } from '@/features/social/components/GroupMenuSheet';
import { PersonMenuSheet } from '@/features/social/components/PersonMenuSheet';
import { useGroupMenu } from '@/features/social/hooks/useGroupMenu';
import { useWakeLoad } from '@/features/social/hooks/useGroupWake';
import { usePersonMenu } from '@/features/social/hooks/usePersonMenu';
import { MiniButton } from '@/features/social/components/MiniButton';
import { PersonRow } from '@/features/social/components/PersonRow';
import { permissionNames } from '@/features/social/permissions';
import type { GroupDetail, GroupMember, Person } from '@/features/social/types';
import { WAKE_STALE_TEXT } from '@/features/social/wakeTexts';
import { formatDateShort, formatTime } from '@/lib/format';
import { backOrHome, openTab } from '@/lib/nav';
import { colors } from '@/theme';

// G02 그룹 상세 — 내가 이 그룹에 준 공유 범위 · 연결 일정 · 멤버 기상 상태
// 멤버 기상 상태는 그 사람의 이 그룹 기상 공유 동의로만(서버 get_group_wake, 친구 7장) — 줄이 없으면 '공유 안 함'. 알람 보기(G04)는 받은 알람 조회 권한
export default function GroupDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, reload, stale } = useWakeLoad((date) => getGroup(id, date), (g) => [g.id]); // 그룹 기상 신호 · 다시 연결 · 앱이 앞에 올 때 멤버 상태를 다시 읽음

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
  return <Detail group={data} stale={stale} onBack={backOrHome} onChanged={() => void reload()} />;
}

function Detail({ group: g, stale, onBack, onChanged }: { group: GroupDetail; stale: boolean; onBack?: () => void; onChanged: () => void }) {
  // 멤버 줄 [···] 기상 숨기기 · 신고 · 차단 — 바꾸면 다시 읽음 (친구 4장 · 7장)
  const menu = usePersonMenu(onChanged, (personId) => g.members.some((m) => m.person.id === personId && m.wakeHidden));
  const grants = permissionNames(g.grants);
  const groupMenu = useGroupMenu(g, onChanged, () => onBack?.()); // [···] 그룹 메뉴 · [+ 초대] — 그룹장 없음, 멤버 누구나 (친구 5장)
  const appts = useGroupAppointments(onChanged); // 연결 일정 [내 알람 만들기] · 참여자 · [나는 빠지기] (친구 9장)

  // 연결 일정이 여러 개일 수 있어 "내 알람"은 늘 알람 목록으로 (작성자 판단 — 목업은 연결 일정 고정)
  // 알람 목록은 2번 탭 (D110) — 그룹 상세를 걷어 내고 알람 탭으로 (lib/nav openTab)
  const openMyAlarms = () => openTab('/alarms');

  return (
    <Screen>
      <PersonMenuSheet {...menu.sheetProps} />
      <GroupMenuSheet {...groupMenu.menuProps} />
      <GroupCodeSheet {...groupMenu.codeProps} />
      <GroupInviteSheet {...groupMenu.inviteProps} />
      <GroupJoinSheet {...appts.joinProps} />
      <AppointmentJoinersSheet {...appts.joinersProps} />
      <TopBar
        onBack={onBack}
        screenId="G02"
        right={<TextLink label="···" accessibilityLabel="그룹 메뉴" onPress={groupMenu.openMenu} />}
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
            내가 공유 중
          </Text>
          <TextLink
            label="공유 권한 설정 ›"
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
            <View key={a.id} style={[styles.linked, i > 0 && styles.divider]}>
              {/* 줄 위쪽만 누르면 참여자 시트 — [내 알람 만들기] · 내 알람 보기는 줄 밖(버튼 안에 버튼을 넣지 않음) */}
              <Pressable
                onPress={() => void appts.openJoiners(a)}
                accessibilityRole="button"
                accessibilityLabel={`${a.title} 참여자 보기`}
                style={({ pressed }) => pressed && styles.pressed}
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
                {/* 참여 / 알람 없음 두 가지 + 인원수, 지난 약속은 그 한 줄만 (친구 9장 9-42 · 9-32) */}
                <Text variant="small" tone={a.iJoined && !a.past ? undefined : 'sub'} style={styles.sub}>
                  {[a.past ? null : joinedCountText(a.joinedCount), appointmentStateText(a), a.creatorUnknown ? CREATOR_UNKNOWN : null].filter(Boolean).join(' · ')}
                </Text>
              </Pressable>
              {a.past ? null : a.iJoined ? (
                <View style={styles.joinButton}>
                  <TextLink label="내 알람 보기 ›" onPress={() => router.push({ pathname: '/alarm/[id]', params: { id: a.id } })} />
                </View>
              ) : (
                <View style={styles.joinButton}>
                  <Button label="내 알람 만들기" small onPress={() => void appts.openJoin(a)} />
                </View>
              )}
            </View>
          ))}
        </Card>
      ) : null}

      <SectionHeader title="멤버 · 기상 상태" right={<TextLink label="+ 초대" onPress={groupMenu.openInvite} strong />} />
      {stale ? (
        <Text variant="small" tone="warn" style={styles.stale} accessibilityLiveRegion="polite">
          {WAKE_STALE_TEXT}
        </Text>
      ) : null}
      <Card>
        {g.members.map((m, i) => (
          <MemberRow key={m.person.id} member={m} groupId={g.id} first={i === 0} onMyAlarm={openMyAlarms} onMenu={menu.open} />
        ))}
      </Card>

      {/* 안내 카드는 실선 — 점선은 비어 있을 때 쓰는 모양 (피그마 G02) */}
      <Card>
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

// 멤버 한 줄 — 기상 단계 글자 + 색 (14-파). '공유 안 함'(동의 안 함 · 숨김 · 차단)은 색 점 없이 글자만
// 줄을 누르면 기상 상태(G03). 공유 안 함이면 이유 없이 볼 수 없다고만 알림 (상대가 왜 안 보이는지 드러내지 않음)
function MemberRow({
  member: m,
  groupId,
  first,
  onMyAlarm,
  onMenu,
}: {
  member: GroupMember;
  groupId: string;
  first: boolean;
  onMyAlarm: () => void;
  onMenu: (p: Person) => void; // [···] 기상 숨기기 · 신고 · 차단
}) {
  const shared = m.state.stage !== 'NOT_SHARED';
  const name = m.person.short;
  const wakeReason = `${name}님의 기상 상태는 볼 수 없어요`;
  const alarmReason = `${name}님이 알람 공유를 허용하지 않았어요`;
  const openWake = () =>
    router.push({ pathname: '/groups/[id]/members/[userId]', params: { id: groupId, userId: m.person.id } });
  const sub = [m.person.handle, m.state.text, m.wakeHidden ? '내 기상 숨김' : null].filter(Boolean).join(' · '); // 멤버 줄 @아이디 — 차단 쌍은 서버가 아이디를 비워 이름만

  return (
    <PersonRow
      first={first}
      icon={<Avatar initial={m.person.initial} dot={m.state.dot ?? undefined} />}
      title={m.person.name}
      sub={sub}
      onPress={m.isMe ? undefined : shared ? openWake : () => toast(wakeReason)}
      rightIsButtons={m.isMe}
      right={m.isMe ? <MiniButton label="내 알람" onPress={onMyAlarm} /> : undefined}
      // 남의 줄은 버튼 3개(기상 상태 · 알람 보기 · ···)가 오른쪽에 있으면 이름 칸이 좁아져 아래 줄로 내림 (360폭)
      actions={
        m.isMe ? undefined : (
          <>
            <MiniButton label="기상 상태" disabledReason={shared ? undefined : wakeReason} onPress={openWake} />
            <MiniButton
              label="알람 보기"
              disabledReason={m.received.viewAlarm ? undefined : alarmReason}
              onPress={() => router.push({ pathname: '/friends/[id]/alarms', params: { id: m.person.id } })}
            />
            <MiniButton label="···" accessibilityLabel={`${m.person.name}님 메뉴`} onPress={() => onMenu(m.person)} />
          </>
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
  joinButton: { marginTop: 8, alignItems: 'flex-start' },
  paragraph: { lineHeight: 20 },
  stale: { marginBottom: 8 },
});
