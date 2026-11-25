import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Text } from '@/components/ui';
import { useAccent } from '@/lib/skyTone';
import { colors, size } from '@/theme';

import type { Allowed } from '../types';

type Props = {
  name: string;
  reason: string; // 이유 — 한 줄만 보이고 눌러서 펼침
  state?: Allowed; // 있으면 줄 앞에 됨(체크) / 안 됨(느낌표) 아이콘, 모름 · 글만 있는 줄은 빈 동그라미
  actionLabel?: string; // 있으면 아래에 버튼
  onAction?: () => void;
  busy?: boolean; // 버튼이 일하는 중
  first?: boolean; // 카드 안 첫 줄이면 위 구분선을 뺌
};

const STATE_LABEL: Record<Allowed, string> = { on: '허용', off: '꺼짐', unknown: '모름' };

// 점검표(L04) 한 줄 — 상태 아이콘 · 이름 · 이유 한 줄(눌러 펼침) · 설정 버튼
export function CheckRow({ name, reason, state, actionLabel, onAction, busy, first }: Props) {
  const accent = useAccent();
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.row, !first && styles.divider]}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${name}${state ? `, ${STATE_LABEL[state]}` : ''}`}
        style={styles.head}
      >
        <View
          style={[
            styles.icon,
            state === 'on' && { backgroundColor: accent, borderColor: accent },
            state === 'off' && styles.iconOff,
          ]}
        >
          {state === 'on' ? (
            <Text variant="label" tone="inverse" weight={700}>
              ✓
            </Text>
          ) : state === 'off' ? (
            <Text variant="label" weight={700} style={styles.bang}>
              !
            </Text>
          ) : null}
        </View>
        <View style={styles.text}>
          <Text variant="bodyStrong">{name}</Text>
          <Text variant="small" tone="sub" numberOfLines={open ? undefined : 1}>
            {reason}
          </Text>
        </View>
        <Text variant="small" tone="faint">
          {open ? '˄' : '˅'}
        </Text>
      </Pressable>
      {actionLabel && onAction ? (
        <View style={styles.action}>
          <Button small variant="ghost" label={actionLabel} onPress={onAction} loading={busy} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 4 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  head: { minHeight: size.touch, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  text: { flex: 1, minWidth: 0 },
  icon: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: colors.faintDecor, alignItems: 'center', justifyContent: 'center' },
  iconOff: { borderColor: colors.warn },
  bang: { color: colors.warn }, // 경고는 글자에만 빨강 — 채움 없음
  action: { paddingLeft: 34, paddingBottom: 8 },
});
