import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, space } from '@/theme';

type Props = {
  children: ReactNode;
  scroll?: boolean; // 기본은 스크롤. 채팅처럼 직접 스크롤을 다룰 때만 끔
  footer?: ReactNode; // 화면 아래 고정 버튼 자리
  contentStyle?: ViewStyle;
};

// 화면 바탕 · 좌우 여백 · 안전 영역을 맞춘 화면 틀
// 아래 고정 버튼(footer)이 있으면 시스템 내비게이션 막대에 가리지 않게 아래 안전 영역도 잡음
export function Screen({ children, scroll = true, footer, contentStyle }: Props) {
  return (
    <SafeAreaView style={styles.safe} edges={footer ? ['top', 'bottom'] : ['top']}>
      {scroll ? (
        <ScrollView
          style={styles.fill}
          contentContainerStyle={[styles.content, contentStyle]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.fill, styles.content, contentStyle]}>{children}</View>
      )}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  fill: { flex: 1 },
  content: { paddingHorizontal: space.screenX, paddingBottom: 28 },
  footer: { paddingHorizontal: space.screenX, paddingTop: 8, paddingBottom: 12, backgroundColor: colors.bg },
});
