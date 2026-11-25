import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card, Chip, confirm, LoadError, Loading, Screen, SectionHeader, Text, toast, Toggle, TopBar, TopBarIconButton } from '@/components/ui';
import { getFriendGrant, getReceived, getShareSettings, removeFriend, saveShareSettings } from '@/features/social/api';
import { TextLink } from '@/features/alarm/components/TextLink';
import { permissionNames, togglePermission } from '@/features/social/permissions';
import { permissionsFor, type GrantRow, type Permission, type PermissionSet } from '@/features/social/types';
import { PersonMenuSheet } from '@/features/social/components/PersonMenuSheet';
import { usePersonMenu } from '@/features/social/hooks/usePersonMenu';
import { UserError } from '@/lib/errors';
import { useAction } from '@/lib/useAction';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';
import { backOrHome } from '@/lib/nav';

// 권한 출처 칩이 여는 F03 관계 — 친구 관계면 friend:사람, 그룹이면 group:그룹
const relationOf = (r: GrantRow) => `${r.sourceType === 'FRIEND' ? 'friend' : 'group'}:${r.sourceId}` as const;

const NONE: PermissionSet = { viewAlarm: false, editAlarm: false, viewWake: false };

// 한 번에 읽기 — 최종 권한(출처 포함) · 친구 관계로 내가 준 값(스위치) · 친구에게서 받은 권한(보기만)
async function loadFriend(id: string) {
  const grant = await getFriendGrant(id);
  if (!grant) return null;
  const [mine, received] = await Promise.all([getShareSettings(`friend:${id}`), getReceived(`friend:${id}`)]);
  return { ...grant, mine, received: received[0]?.permissions ?? NONE };
}

// F02 친구 한 명 — 내가 준 권한은 스위치로 바로 바꾸고(바뀌면 바로 저장 + 토스트, 저장은 공유 권한 설정(F03)과 같은 함수), 받은 권한은 보기만
// 같은 그룹에서 준 권한은 그 그룹 칩으로 보이고 눌러서 그 그룹의 공유 권한 설정을 엶 (끄려면 그 그룹에서)
export default function FriendPermissionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, reload } = useLoad(() => loadFriend(id));
  const { busy, run } = useAction();
  // 스위치를 누른 뒤 저장 · 다시 읽기가 끝날 때까지 보이는 값 — 스위치가 예전 값으로 깜빡이지 않게
  const [draft, setDraft] = useState<PermissionSet | null>(null);
  // [···] 메뉴의 신고 · 차단 — 차단하면 친구가 끊기므로 이전 화면(친구 탭)으로 돌아감 (4-30)
  const menu = usePersonMenu(() => backOrHome());

  // 친구 끊기 — 확인 한 번. 행이 지워지고 양쪽 친구 출처 권한도 사라짐(같은 그룹의 권한 · 기상은 그대로). 상대에게 알림 없음 (3-14 · 3-15)
  const disconnect = async (name: string) => {
    const ok = await confirm({
      title: `${name}님과 친구를 끊을까요?`,
      message: '서로 친구로 준 권한이 모두 사라져요. 같은 그룹이면 그룹 안에서는 그대로 보여요. 상대에게 알림은 가지 않아요.',
      okLabel: '친구 끊기',
      destructive: true,
    });
    if (!ok) return; // 확인 창이 떠 있는 동안에는 버튼이 돌지 않음 — 확인한 뒤에만 busy
    await run(async () => {
      // 끊었거나 이미 끊긴 경우(GONE, UserError)만 목록으로 — 통신 오류면 이 화면에 남아 다시 할 수 있게
      let leave = false;
      try {
        await removeFriend(id);
        toast('친구를 끊었어요');
        leave = true;
      } catch (e) {
        leave = e instanceof UserError;
        throw e;
      } finally {
        if (leave) backOrHome();
      }
    }, '친구를 끊지 못했어요. 다시 해 주세요');
  };

  if (data === undefined) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} screenId="F02" />
        {error ? <LoadError onRetry={reload} /> : <Loading />}
      </Screen>
    );
  }
  if (data === null) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} screenId="F02" />
        <Text variant="body" tone="sub">
          친구를 찾을 수 없어요.
        </Text>
      </Screen>
    );
  }

  const { person: p, final, firstGroupId, mine, received } = data;
  const current = draft ?? mine;
  const groupSources = (key: Permission) => final.rows.filter((r) => r.sourceType === 'GROUP' && r[key]);

  // 스위치 하나 — 바로 저장하고 토스트. 저장에 실패하면 스위치를 원래대로
  const change = (key: Permission, next: boolean) =>
    run(async () => {
      const set = togglePermission(current, key, next);
      setDraft(set);
      try {
        await saveShareSettings(`friend:${id}`, set);
      } catch (e) {
        setDraft(null);
        throw e;
      }
      toast(`${p.name}님과의 공유 권한을 저장했어요`);
      if (await reload()) setDraft(null); // 다시 읽기에 실패하면 고른 값을 남겨 화면이 어긋나지 않게
    }, '공유 권한을 저장하지 못했어요');

  const receivedNames = permissionNames(received);
  return (
    <Screen>
      <TopBar
        onBack={backOrHome}
        screenId="F02"
        right={<TopBarIconButton icon={{ ios: 'ellipsis', android: 'more_horiz', web: 'more_horiz' }} accessibilityLabel={`${p.name}님 메뉴`} glass onPress={() => menu.open(p)} />}
      />
      <PersonMenuSheet {...menu.sheetProps} />
      <Text variant="title" style={styles.title}>
        {p.name}님
      </Text>

      <SectionHeader title="내가 준 권한" right={<Chip label={`${final.count}개 허용`} variant="fill" />} />
      <Card>
        {permissionsFor('friend').map(({ key, name }, i) => {
          const groups = groupSources(key);
          return (
            <View key={key} style={[styles.perm, i > 0 && styles.divider]}>
              <View style={styles.between}>
                <Text variant="bodyStrong">{name}</Text>
                <Toggle value={!!current[key]} onChange={(next) => change(key, next)} label={`${name} 허용`} disabled={busy} />
              </View>
              {groups.length ? (
                <View style={styles.chips}>
                  <Text variant="caption" tone="faint">
                    그룹에서도 허용
                  </Text>
                  {groups.map((row) => (
                    <Pressable
                      key={row.source}
                      onPress={() => router.push({ pathname: '/permissions', params: { relation: relationOf(row) } })}
                      hitSlop={{ top: 9, bottom: 9, left: 4, right: 4 }}
                      accessibilityRole="button"
                      accessibilityLabel={`${row.source} 권한 설정 열기`}
                      style={({ pressed }) => pressed && styles.pressed}
                    >
                      <Chip label={`${row.source} ›`} />
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}
      </Card>

      <SectionHeader title="받은 권한" />
      <Card>
        {receivedNames.length ? (
          <View style={styles.chipsPlain}>
            {receivedNames.map((name) => (
              <Chip key={name} label={name} />
            ))}
          </View>
        ) : (
          <Text variant="small" tone="sub">
            받은 권한 없음
          </Text>
        )}
      </Card>

      {/* 알람 · 기상 입구 (친구 10장 10-d5) — 알람 보기 = G04, 기상 확인 = 같이 있는 그룹의 G03 */}
      <View style={styles.tiles}>
        <TextLink label="알람 보기 ›" onPress={() => router.push({ pathname: '/friends/[id]/alarms', params: { id: p.id } })} />
        {firstGroupId ? (
          <TextLink label="기상 확인 ›" onPress={() => router.push({ pathname: '/groups/[id]/members/[userId]', params: { id: firstGroupId, userId: p.id } })} />
        ) : null}
      </View>

      <View style={styles.disconnect}>
        <View style={styles.grow}>
          <Text variant="bodyStrong">친구 끊기</Text>
          <Text variant="small" tone="sub">
            끊어도 상대에게 알림은 가지 않아요.
          </Text>
        </View>
        <Pressable
          onPress={() => void disconnect(p.name)}
          disabled={busy}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`${p.name}님과 친구 끊기`}
          style={({ pressed }) => [styles.dangerHit, (pressed || busy) && styles.pressed]}
        >
          <Text variant="rowLabel" weight={600} style={styles.danger}>
            끊기
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 44 },
  grow: { flex: 1, minWidth: 0 },
  perm: { paddingVertical: 4 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 8 },
  chipsPlain: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tiles: { flexDirection: 'row', gap: 20, paddingHorizontal: 4, marginBottom: 16 },
  pressed: { opacity: 0.6 },
  disconnect: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4, marginTop: 4 },
  dangerHit: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' },
  danger: { color: colors.danger },
});
