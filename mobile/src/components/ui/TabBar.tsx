import { Ionicons } from '@expo/vector-icons';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, size } from '@/theme';

import { Text } from './Text';

type IconName = ComponentProps<typeof Ionicons>['name'];

// 탭(라우트 이름)마다 아이콘 — 고른 탭은 채운 모양, 아니면 선 모양
const ICONS: Record<string, { on: IconName; off: IconName }> = {
  index: { on: 'home', off: 'home-outline' },
  group: { on: 'people', off: 'people-outline' },
  ai: { on: 'sparkles', off: 'sparkles-outline' },
  records: { on: 'calendar', off: 'calendar-outline' },
};
const FALLBACK_ICON = { on: 'ellipse', off: 'ellipse-outline' } as const;
const ICON_SIZE = 24;

// 아래 탭 막대 (.tabs) — 아이콘 + 이름, 고른 탭은 아이콘 · 이름 모두 검게(ink), 아니면 흐리게(faint)
export function TabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 16) }]} accessibilityRole="tablist">
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        const label = typeof options.title === 'string' ? options.title : route.name;
        const focused = state.index === index;
        const icon = ICONS[route.name] ?? FALLBACK_ICON;
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
            {/* 글꼴을 읽기 전에도 칸 크기가 같도록 고정 크기 상자에 담음 — 이름이 이미 라벨이라 아이콘은 읽지 않음 */}
            <View style={styles.icon}>
              <Ionicons
                name={focused ? icon.on : icon.off}
                size={ICON_SIZE}
                color={focused ? colors.ink : colors.faint}
                style={styles.glyph}
                accessible={false}
              />
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
  // 누르는 칸은 44 이상(size.touch) — 아이콘(24) + 간격 + 이름(줄 16)이 들어가고, 탭 막대 높이는 그대로
  item: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, minHeight: size.touch },
  icon: { width: ICON_SIZE, height: ICON_SIZE, alignItems: 'center', justifyContent: 'center' },
  glyph: { lineHeight: ICON_SIZE },
});
