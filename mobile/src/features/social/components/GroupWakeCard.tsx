import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar, Card, Text } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import type { GroupSummary } from '@/features/social/types';
import { groupWakeLine } from '@/features/social/wakeTexts';
import { colors } from '@/theme';

const GROUP_ROWS = 3; // 보이는 그룹 줄 수 — 넘으면 "외 N개"

// 오늘 그룹 기상 카드 — 그룹마다 멤버 얼굴(기상 점) · 오늘 기상 수(출발 · 도착이 보이면 '도착 1 · 이동 중 2 · 기상 완료 1', 그 그룹 약속이 없는 날은 숨김, 7-사). 누르면 그룹 상세(G02)
// 홈 아래에 있던 카드를 그룹 탭 위로 옮김 (D110). 그룹이 없으면 아무것도 안 그림
//   onMore = "외 N개 그룹 보기" — 그룹 탭에서는 '그룹' 칸으로 바꿈. 없으면 링크를 안 그림
export function GroupWakeCard({ groups, onOpen, onMore }: { groups: GroupSummary[]; onOpen: (id: string) => void; onMore?: () => void }) {
  if (!groups.length) return null;
  const shown = groups.slice(0, GROUP_ROWS);
  const more = groups.length - shown.length;

  return (
    <Card>
      {shown.map((group, i) => (
        <Pressable
          key={group.id}
          onPress={() => onOpen(group.id)}
          accessibilityRole="button"
          accessibilityLabel={[group.name, groupWakeLine(group.wokeCount, group.trip)].filter(Boolean).join(', ')}
          style={({ pressed }) => [styles.group, i > 0 && styles.groupDivider, pressed && styles.pressed]}
        >
          <View style={styles.avatars}>
            {group.members.map(({ person, state }, j) => (
              <View key={person.id} style={[styles.avatarRing, j > 0 && styles.avatarOverlap]}>
                <Avatar initial={person.initial} small dot={state.dot ?? undefined} />
              </View>
            ))}
          </View>
          <View style={styles.text}>
            <Text variant="bodyStrong">{group.name}</Text>
            {group.wokeCount != null ? (
              <Text variant="small" tone="sub">
                {groupWakeLine(group.wokeCount, group.trip)}
              </Text>
            ) : null}
          </View>
        </Pressable>
      ))}
      {more > 0 && onMore ? (
        <View style={styles.moreGroups}>
          <TextLink label={`외 ${more}개 그룹 보기`} onPress={onMore} />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  text: { flex: 1 },
  group: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, paddingVertical: 6 },
  groupDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  pressed: { opacity: 0.7 },
  moreGroups: { alignSelf: 'flex-start', paddingTop: 8 },
  avatars: { flexDirection: 'row' },
  avatarRing: { borderRadius: 18, borderWidth: 2, borderColor: colors.card },
  avatarOverlap: { marginLeft: -8 },
});
