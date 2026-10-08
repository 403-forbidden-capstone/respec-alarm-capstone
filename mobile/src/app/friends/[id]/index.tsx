import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Card, Chip, Screen, SectionHeader, Text, TopBar, TopBarButton } from '@/components/ui';
import { getFriendGrant } from '@/features/social/api';
import { PermissionTable } from '@/features/social/components/PermissionTable';
import { PERMISSIONS } from '@/features/social/types';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

// F02 친구 권한 — 이 친구가 내 정보에 대해 가진 최종 권한(친구 · 그룹 관계별 권한을 항목별 OR)과 출처
// 권한을 바꾸려면 공유 권한 설정(F03)에서 친구 관계를 고른 채로 엶
export default function FriendPermissionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data } = useLoad(() => getFriendGrant(id));
  const back = router.canGoBack() ? router.back : undefined;

  if (data === undefined) {
    return (
      <Screen>
        <TopBar onBack={back} screenId="F02" />
      </Screen>
    );
  }
  if (data === null) {
    return (
      <Screen>
        <TopBar onBack={back} screenId="F02" />
        <Text variant="body" tone="sub">
          친구를 찾을 수 없어요.
        </Text>
      </Screen>
    );
  }

  const { person: p, final, groupCount } = data;
  return (
    <Screen>
      <TopBar onBack={back} screenId="F02" />
      <Text variant="title" style={styles.title}>
        {p.name}님의 권한
      </Text>
      <Text variant="lead" style={styles.lead}>
        여러 관계에서 받은 권한을 합친 최종 결과예요.
      </Text>

      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          관계별 권한을 합치면
        </Text>
        <PermissionTable final={final} />
        <Text variant="small" tone="sub" style={styles.tableNote}>
          친구 · 함께하는 그룹 {groupCount}개 · 하나라도 허용하면 허용
        </Text>
      </Card>

      <SectionHeader title={`${p.short}님이 가진 최종 권한`} right={<Chip label={`${final.count}개 허용`} variant="ink" />} />
      <Card>
        {PERMISSIONS.map(({ key, name }, i) => {
          const sources = final.rows.filter((r) => r[key]).map((r) => r.source);
          return (
            <View key={key} style={[styles.perm, i > 0 && styles.divider]}>
              <View style={styles.between}>
                <Text variant="bodyStrong">{name}</Text>
                <Text variant="small" tone={final[key] ? 'ink' : 'sub'}>
                  {final[key] ? '허용됨' : '허용 안 됨'}
                </Text>
              </View>
              {sources.length ? (
                <>
                  <Text variant="caption" tone="faint" style={styles.sourceLabel}>
                    권한 출처
                  </Text>
                  <View style={styles.chips}>
                    {sources.map((source) => (
                      <Chip key={source} label={source} />
                    ))}
                  </View>
                </>
              ) : null}
            </View>
          );
        })}
      </Card>

      <Card>
        <View style={styles.between}>
          <View style={styles.grow}>
            <Text variant="bodyStrong">관계별 권한 수정</Text>
            <Text variant="small" tone="sub">
              출처를 골라 권한을 회수할 수 있어요.
            </Text>
          </View>
          <TopBarButton
            label="설정"
            onPress={() => router.push({ pathname: '/permissions', params: { relation: `friend:${p.id}` } })}
          />
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  label: { marginBottom: 8 },
  tableNote: { marginTop: 10 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  grow: { flex: 1, minWidth: 0 },
  perm: { paddingVertical: 12 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  sourceLabel: { marginTop: 8, marginBottom: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
