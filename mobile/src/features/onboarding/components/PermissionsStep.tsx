import { StyleSheet, View } from 'react-native';

import { Button, Card, Chip, Text } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { keepWords } from '@/lib/format';
import { colors } from '@/theme';

import { permissionsSummary, permissionStateLabel, type PermissionState } from '../permissionsSummary';

export type { PermissionState };

export type PermissionRow = {
  key: string;
  label: string; // 알림
  why: string; // 한 줄 이유
  state: PermissionState;
  actionLabel?: string; // 버튼 글자 (꺼짐이면 기본 "켜기", 확인 전은 글자를 줄 때만 버튼 — 예: 배터리 "설정 열기")
};

type Props = {
  rows: PermissionRow[];
  onAction: (key: string) => void; // "켜기" — 설정 열기 · 시스템 창은 부르는 화면이 함. 이 부품은 자동으로 띄우지 않음
  onOpenChecklist?: () => void; // 있으면 아래에 점검표 링크
};

// 권한 안내 단계 내용 — 안내만. 줄마다 이름 · 이유 · 상태(글자) · 꺼짐일 때만 켜기
export function PermissionsStep({ rows, onAction, onOpenChecklist }: Props) {
  const summary = permissionsSummary(rows);
  return (
    <View>
      {summary ? (
        <Text variant="bodyStrong" accessibilityLiveRegion="polite" style={styles.summary}>
          {summary}
        </Text>
      ) : null}
      {rows.length > 0 ? (
        <Card>
          {rows.map((row, i) => (
            <View key={row.key} style={[styles.row, i > 0 && styles.divider]}>
              <View style={styles.text}>
                <Text variant="bodyStrong">{row.label}</Text>
                <Text variant="small" style={styles.why}>
                  {keepWords(row.why)}
                </Text>
              </View>
              <View style={styles.side}>
                <Chip label={permissionStateLabel(row.state)} variant={row.state === 'ok' ? 'fill' : 'outline'} />
                {row.state === 'off' || (row.state === 'unknown' && row.actionLabel) ? (
                  <Button small variant="ghost" label={row.actionLabel ?? '켜기'} onPress={() => onAction(row.key)} />
                ) : null}
              </View>
            </View>
          ))}
        </Card>
      ) : null}
      {onOpenChecklist ? (
        <View style={styles.link}>
          <TextLink label="알람이 안 울릴 때 점검표 보기" onPress={onOpenChecklist} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, paddingVertical: 12, minHeight: 52 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  text: { flex: 1 },
  why: { marginTop: 2 },
  side: { alignItems: 'flex-end', gap: 8 },
  link: { alignItems: 'center', marginTop: 8 },
});
