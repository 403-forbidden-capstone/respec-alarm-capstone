import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { space } from '@/theme';

import { Text } from './Text';

type Props = {
  title: string;
  right?: ReactNode; // 글자면 작은 회색 글자, 요소면 그대로(작은 버튼 등)
};

// 화면 안 섹션 제목 (.h2) — 예: "오늘 일정"  "+ 새 일정"
export function SectionHeader({ title, right }: Props) {
  return (
    <View style={styles.row}>
      <Text variant="section">{title}</Text>
      {typeof right === 'string' ? <Text variant="small">{right}</Text> : right}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.section,
    marginBottom: space.sectionBelow,
  },
});
