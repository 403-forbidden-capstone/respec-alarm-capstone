import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

import { Text } from './Text';

// 아래 탭 막대 (.tabs) — 번호 배지(01~04) + 이름, 고른 탭은 검게
export function TabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 16) }]} accessibilityRole="tablist">
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        const label = typeof options.title === 'string' ? options.title : route.name;
        const focused = state.index === index;
        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
        };
        return (
          <Pressable
            key={route.key}
            onPress={onPress}
            style={styles.item}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={label}
          >
            <View style={[styles.badge, focused && styles.badgeOn]}>
              <Text variant="caption" tone={focused ? 'inverse' : 'faint'} style={styles.badgeText}>
                {String(index + 1).padStart(2, '0')}
              </Text>
            </View>
            <Text variant="caption" tone={focused ? 'ink' : 'faint'} weight={focused ? 600 : 400}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: 8,
    paddingHorizontal: 6,
  },
  item: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 4 },
  badge: { minWidth: 26, height: 16, borderRadius: 8, backgroundColor: colors.chip, alignItems: 'center', justifyContent: 'center' },
  badgeOn: { backgroundColor: colors.ink },
  badgeText: { fontSize: 10, lineHeight: 14, fontVariant: ['tabular-nums'] },
});
