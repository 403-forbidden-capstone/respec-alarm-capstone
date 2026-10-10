import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { colors } from '@/theme';

import type { FinalGrant, Permission } from '../types';

// 표 머리 — 칸이 좁아서 기상 상태 조회는 줄여 씀 (목업 .ptab 그대로)
const COLUMNS: readonly [Permission, string][] = [
  ['viewAlarm', '알람 조회'],
  ['editAlarm', '알람 설정'],
  ['viewWake', '기상 조회'],
];

// 관계별 권한 표 (.ptab) — 관계마다 한 줄, 맨 아래 최종(항목별 OR)
export function PermissionTable({ final }: { final: FinalGrant }) {
  const rows = [...final.rows.map((r) => ({ name: r.source, set: r, fin: false })), { name: '최종', set: final, fin: true }];

  return (
    <View accessibilityRole="summary">
      <View style={[styles.row, styles.line]}>
        <Text variant="caption" tone="sub" weight={500} style={styles.name}>
          관계
        </Text>
        {COLUMNS.map(([key, label]) => (
          <Text key={key} variant="caption" tone="sub" weight={500} align="center" style={styles.cell}>
            {label}
          </Text>
        ))}
      </View>
      {rows.map(({ name, set, fin }, i) => (
        <View key={`${name}-${i}`} style={[styles.row, !fin && styles.line]}>
          <Text variant="small" tone="ink" weight={fin ? 700 : 400} style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          {COLUMNS.map(([key, label]) => (
            <Text
              key={key}
              variant="small"
              tone={set[key] ? 'ink' : 'faint'}
              weight={set[key] ? 700 : 400}
              align="center"
              style={styles.cell}
              accessibilityLabel={`${name} ${label} ${set[key] ? '허용' : '허용 안 함'}`}
            >
              {set[key] ? '✓' : '·'}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  line: { borderBottomWidth: 1, borderBottomColor: colors.line },
  name: { flex: 1.3, paddingHorizontal: 4 },
  cell: { flex: 1, paddingHorizontal: 4 },
});
