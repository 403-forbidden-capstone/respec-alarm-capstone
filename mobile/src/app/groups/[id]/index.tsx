import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, Chip, LoadError, Loading, Screen, SectionHeader, Text, toast, TopBar } from '@/components/ui';
import { IMPORTANCE_LABEL } from '@/features/alarm/types';
import { TextLink } from '@/features/alarm/components/TextLink';
import { getGroup, sendWakePing } from '@/features/social/api';
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
import { permissionNames } from '@/features/social/permissions';
import type { GroupDetail, GroupMember, Person } from '@/features/social/types';
import { WAKE_PING_FAILED, WAKE_STALE_TEXT, wakePingNote, wakePingSent, wokeLine } from '@/features/social/wakeTexts';
import { now } from '@/lib/clock';
import { formatDateShort, formatTime, isSameDay } from '@/lib/format';
import { useAction } from '@/lib/useAction';
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

  // [깨우기] — 그룹원 기상 상태 화면(G03)과 같은 함수로 보냄. 서버가 판정 · 횟수를 세고 결과를 줌, 가짜 모드는 막힘(8-16)
  //   보낸 줄은 이 화면에서 '보냄'으로 바꿔 연달아 누르지 않게 (남은 횟수 · 다음 가능 시각은 기상 상태 화면에서)
  const { run } = useAction();
  const [pinged, setPinged] = useState<string[]>([]);
  const wake = (p: Person) =>
    run(async () => {
      const result = await sendWakePing(g.id, p.id);
      if (result.status === 'OK') {
        setPinged((ids) => [...ids, p.id]);
        toast(wakePingSent(p.short));
      } else {
        toast(wakePingNote(result));
        if (result.status === 'ALREADY_UP' || result.status === 'NOT_RINGING') onChanged(); // 판정이 바뀐 것 — 상태를 다시 읽음
      }
    }, WAKE_PING_FAILED);

  // 멤버 상태 요약 — 일어난 사람 · 알람이 울렸는데 아직인 사람(깨우기 대상). 둘 다 없으면 줄을 숨김
  const woke = g.members.filter((m) => m.state.woke).length;
  const waiting = g.members.filter((m) => m.state.stage === 'RANG').length;
  const faces = g.members.map((m) => m.person.initial);

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

      <SectionHeader
        title="연결 일정"
        right={<TextLink label="+ 새 공동 약속" onPress={() => router.push({ pathname: '/schedule/new', params: { groupId: g.id } })} strong />}
      />
      {g.appointments.length ? (
        <Card>
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
                {/* 같이 준비하는 사람 줄 — 홈 흐름 카드와 같은 얼굴 줄 + 그룹 · 오늘 기상 수(오늘 약속만) */}
                {a.past ? null : (
                  <View style={styles.together}>
                    <View style={styles.faces}>
                      {faces.map((n, j) => (
                        <View key={`${j}-${n}`} style={[styles.face, j > 0 && styles.faceNext]}>
                          <Text variant="caption" tone="ink" weight={600}>
                            {n}
                          </Text>
                        </View>
                      ))}
                    </View>
                    <Text variant="caption" tone="sub" style={styles.grow} numberOfLines={1}>
                      {isSameDay(a.at, now()) ? `${g.name} · ${wokeLine(woke)}` : g.name}
                    </Text>
                  </View>
                )}
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
      ) : (
        <Text variant="small" tone="sub" style={styles.stale}>
          아직 연결된 일정이 없어요
        </Text>
      )}

      <SectionHeader title="멤버 · 기상 상태" right={<TextLink label="+ 초대" onPress={groupMenu.openInvite} strong />} />
      {woke || waiting ? (
        <Text variant="small" tone="sub" style={styles.stale}>
          {`기상 ${woke} · 아직 ${waiting}`}
        </Text>
      ) : null}
      {stale ? (
        <Text variant="small" tone="warn" style={styles.stale} accessibilityLiveRegion="polite">
          {WAKE_STALE_TEXT}
        </Text>
      ) : null}
      <Card>
        {g.members.map((m, i) => (
          <MemberRow key={m.person.id} member={m} groupId={g.id} first={i === 0} onMyAlarm={openMyAlarms} onMenu={menu.open} onWake={wake} pinged={pinged.includes(m.person.id)} />
        ))}
      </Card>

      {/* 내가 공유 중 — 맨 아래로 (함께 보는 것이 먼저, 내 설정은 뒤) */}
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
    </Screen>
  );
}

// 멤버 한 줄 — 얼굴 · 이름 + 한 줄 상태, 오른쪽 끝은 [···] 하나
// 줄 전체를 누르면 기상 상태(G03). 공유 안 함이면 이유 없이 볼 수 없다고만 알림 (상대가 왜 안 보이는지 드러내지 않음)
// [알람 보기]는 기상 상태 화면에 있어 줄에서는 뺌

function MemberRow({
  member: m,
  groupId,
  first,
  onMyAlarm,
  onMenu,
  onWake,
  pinged,
}: {
  member: GroupMember;
  groupId: string;
  first: boolean;
  onMyAlarm: () => void;
  onMenu: (p: Person) => void; // [···] 기상 숨기기 · 신고 · 차단
  onWake: (p: Person) => void; // [깨우기] — 알람이 울렸는데 아직 안 일어난 줄에만
  pinged: boolean; // 이 화면에서 이미 보냄
}) {
  const shared = m.state.stage !== 'NOT_SHARED';
  const name = m.person.short;
  const wakeReason = `${name}님의 기상 상태는 볼 수 없어요`;
  const openWake = () =>
    router.push({ pathname: '/groups/[id]/members/[userId]', params: { id: groupId, userId: m.person.id } });
  const sub = [m.state.text, m.wakeHidden ? '내 기상 숨김' : null].filter(Boolean).join(' · ');
  const body = (
    <>
      <Avatar initial={m.person.initial} dot={m.state.dot ?? undefined} />
      <View style={styles.memberText}>
        <View style={styles.memberTop}>
          <Text variant="bodyStrong" numberOfLines={1} style={styles.grow}>
            {m.person.name}
          </Text>
        </View>
        <Text variant="small" tone="sub" numberOfLines={1}>
          {sub}
        </Text>
      </View>
    </>
  );

  return (
    <View style={[styles.memberRow, !first && styles.divider]}>
      {m.isMe ? (
        <View style={styles.memberMain}>{body}</View>
      ) : (
        <Pressable
          onPress={shared ? openWake : () => toast(wakeReason)}
          accessibilityRole="button"
          accessibilityLabel={`${m.person.name}님 기상 상태`}
          style={({ pressed }) => [styles.memberMain, pressed && styles.pressed]}
        >
          {body}
        </Pressable>
      )}
      {m.isMe ? (
        <MiniButton label="내 알람" onPress={onMyAlarm} />
      ) : (
        <>
          {m.state.stage === 'RANG' ? (
            <TextLink label={pinged ? '보냄' : '깨우기'} accessibilityLabel={`${m.person.name}님 깨우기`} disabled={pinged} onPress={() => onWake(m.person)} />
          ) : null}
          <MiniButton label="···" accessibilityLabel={`${m.person.name}님 메뉴`} onPress={() => onMenu(m.person)} />
        </>
      )}
    </View>
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
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  memberMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  memberText: { flex: 1, minWidth: 0 },
  memberTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stale: { marginBottom: 8 },
  together: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  faces: { flexDirection: 'row' },
  face: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  faceNext: { marginLeft: -6 },
});
