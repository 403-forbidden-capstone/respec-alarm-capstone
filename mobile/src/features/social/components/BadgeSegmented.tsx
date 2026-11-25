import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { useAccent } from '@/lib/skyTone';
import { colors, radius, size } from '@/theme';

type Props<T extends string> = {
  options: readonly (readonly [T, string])[]; // [값, 보이는 글자]
  value: T;
  onChange: (next: T) => void;
  badges?: Partial<Record<T, number>>; // 칸 이름 옆 숫자 — 0이면 안 그림
};

// 친구 / 그룹 칸 고르기 — 공용 Segmented와 같은 모양에 칸 이름 옆 숫자 배지(받은 친구 요청 · 그룹 초대 수)만 더함
export function BadgeSegmented<T extends string>({ options, value, onChange, badges }: Props<T>) {
  const accent = useAccent();
  return (
    <View style={styles.wrap} accessibilityRole="tablist">
      {options.map(([v, label]) => {
        const on = v === value;
        const count = badges?.[v] ?? 0;
        return (
          <Pressable
            key={v}
            onPress={() => onChange(v)}
            hitSlop={{ top: 3, bottom: 3 }}
            accessibilityRole="tab"
            accessibilityLabel={count ? `${label}, 새 소식 ${count}개` : label}
            accessibilityState={{ selected: on }}
            style={[styles.item, on && styles.on]}
          >
            <Text variant="body" tone={on ? 'ink' : 'sub'} weight={on ? 600 : 400}>
              {label}
            </Text>
            {count ? (
              <View style={[styles.badge, { backgroundColor: accent }]}>
                <Text variant="caption" tone="inverse" weight={700} style={styles.badgeText}>
                  {count > 9 ? '9+' : count}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', backgroundColor: colors.chip, borderRadius: radius.segment, padding: 4, marginBottom: 6 },
  item: { flex: 1, height: size.segment, borderRadius: radius.segmentItem, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  on: {
    backgroundColor: colors.card,
    shadowColor: colors.shadow,
    shadowOpacity: 0.06,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  badge: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  badgeText: { lineHeight: 14 },
});
