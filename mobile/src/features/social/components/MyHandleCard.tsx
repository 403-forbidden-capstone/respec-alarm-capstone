import { StyleSheet, View } from 'react-native';

import { Button, Card, Text } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { colors } from '@/theme';

type Props = {
  handle: string | null;
  highlight: boolean; // 자동 아이디 그대로 — 같은 줄 끝에 '바꿔 보세요' (2-50)
  onChange?: () => void; // [바꾸기] — 없으면(가짜 모드 · 프로필 없음) 줄만 보임
  onShare: () => void; // 내 친구 링크 공유
  onRenew: () => void; // 링크 다시 만들기 — 옛 링크는 바로 무효
};

// 친구 탭 맨 아래 '내 아이디 [바꾸기]' 줄 + 친구 링크 (친구 2장) — 아이디 줄은 늘 보이고, 자동 아이디일 때만 같은 줄에 안내. 아이디가 없으면(가짜 모드 · 프로필 없음) 안내 한 줄
export function MyHandleCard({ handle, highlight, onChange, onShare, onRenew }: Props) {
  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <View style={styles.grow}>
          <Text variant="caption" tone="sub">
            내 아이디
          </Text>
          {handle ? (
            <View style={styles.handleLine}>
              <Text variant="bodyStrong">{`@${handle}`}</Text>
              {highlight ? (
                <Text variant="label" tone="sub">
                  · 바꿔 보세요
                </Text>
              ) : null}
            </View>
          ) : (
            <Text variant="small" tone="sub">
              로그인하면 내 아이디가 생겨요
            </Text>
          )}
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
  card: { marginTop: 4 },
  handleLine: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, minWidth: 0 },
  link: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.line },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
});
