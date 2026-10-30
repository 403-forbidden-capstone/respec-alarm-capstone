import { StyleSheet, View } from 'react-native';

import { Button, Chip, Text } from '@/components/ui';
import { colors } from '@/theme';

import type { Allowed } from '../types';

type Props = {
  name: string;
  reason: string; // 한 줄 이유
  state?: Allowed; // 있으면 이름 옆에 허용 / 꺼짐 / 모름 칩 (글만 있는 줄은 생략)
  actionLabel?: string; // 있으면 아래에 버튼
  onAction?: () => void;
  busy?: boolean; // 버튼이 일하는 중
  first?: boolean; // 카드 안 첫 줄이면 위 구분선을 뺌
};

const STATE_LABEL: Record<Allowed, string> = { on: '허용', off: '꺼짐', unknown: '모름' };
// Chip에 경고색이 없어 꺼짐은 검은 칩으로 눈에 띄게
const STATE_VARIANT: Record<Allowed, 'fill' | 'ink' | 'outline'> = { on: 'fill', off: 'ink', unknown: 'outline' };

// 점검표(L04) 한 줄 — 이름 · 상태 칩 · 이유 · 설정 버튼
export function CheckRow({ name, reason, state, actionLabel, onAction, busy, first }: Props) {
  return (
    <View style={[styles.row, !first && styles.divider]}>
      <View style={styles.head}>
        <Text variant="bodyStrong" style={styles.name}>
          {name}
        </Text>
        {state ? <Chip label={STATE_LABEL[state]} variant={STATE_VARIANT[state]} /> : null}
      </View>
      <Text variant="small" tone="sub" style={styles.reason}>
        {reason}
      </Text>
      {actionLabel && onAction ? (
        <View style={styles.action}>
          <Button small variant="ghost" label={actionLabel} onPress={onAction} loading={busy} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 11 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  name: { flex: 1 },
  reason: { marginTop: 2 },
  action: { marginTop: 8 },
});
