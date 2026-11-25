import { StyleSheet, View } from 'react-native';

import { Button, Card, Text } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { colors } from '@/theme';

type Props = {
  handle: string | null;
  highlight: boolean; // 자동 아이디 그대로 — '바꿔 보세요'로 강조 (2-50)
  onChange?: () => void; // [바꾸기] — 없으면(가짜 모드 · 프로필 없음) 줄만 보임
  onShare: () => void; // 내 친구 링크 공유
  onRenew: () => void; // 링크 다시 만들기 — 옛 링크는 바로 무효
};

// 친구 탭 맨 위 '내 아이디 [바꾸기]' 줄 + 친구 링크 (친구 2장) — 아이디 줄은 늘 보이고, 자동 아이디일 때만 강조
export function MyHandleCard({ handle, highlight, onChange, onShare, onRenew }: Props) {
  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <View style={styles.grow}>
          <Text variant="caption" tone="sub">
            내 아이디
          </Text>
          <Text variant="bodyStrong">{handle ? `@${handle}` : '-'}</Text>
          {highlight ? (
            <Text variant="label" tone="sub" style={styles.nudge}>
              바꿔 보세요
            </Text>
          ) : null}
        </View>
        {onChange ? <Button small variant="ghost" label="바꾸기" onPress={onChange} /> : null}
      </View>
      <View style={[styles.row, styles.link]}>
        <View style={styles.grow}>
          <Text variant="caption" tone="sub">
            내 친구 링크
          </Text>
          <Text variant="small">만든 날부터 7일 동안 쓸 수 있어요</Text>
        </View>
        <View style={styles.actions}>
          <TextLink label="새로 만들기" onPress={onRenew} />
          <Button small variant="ghost" label="공유" onPress={onShare} />
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, minWidth: 0 },
  nudge: { marginTop: 2 },
  link: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.line },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
});
