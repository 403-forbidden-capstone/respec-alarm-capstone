import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

import { Text } from './Text';

// 탭 그림 — 화면 파일 이름 기준. iOS는 SF Symbols, Android · 웹은 Material Symbols (expo-symbols가 글꼴로 그림)
const ICONS: Record<string, SymbolViewProps['name']> = {
  index: { ios: 'house', android: 'home', web: 'home' },
  alarms: { ios: 'alarm', android: 'alarm', web: 'alarm' },
  group: { ios: 'person.2', android: 'group', web: 'group' },
  ai: { ios: 'sparkles', android: 'auto_awesome', web: 'auto_awesome' },
};
const ICON_SIZE = 24;

// 아래 탭 막대 (.tabs) — 그림 + 이름, 고른 탭은 검게
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
            {ICONS[route.name] ? (
              <SymbolView name={ICONS[route.name]} size={ICON_SIZE} tintColor={focused ? colors.ink : colors.faint} fallback={<View style={styles.icon} />} />
            ) : (
              <View style={styles.icon} />
            )}
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
  item: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 4 },
  icon: { width: ICON_SIZE, height: ICON_SIZE },
});
