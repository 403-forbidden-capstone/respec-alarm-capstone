import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, radius, space } from '@/theme';

import { Text } from './Text';
import { Toggle } from './Toggle';

type Props = {
  dateLabel: string; // 5월 22일 목 · 캡스톤팀 공유
  time: { ampm: string; hm: string }; // 첫 알람 (큰 글자)
  kindLabel: string; // 기상
  chain: string[]; // 오른쪽 세로 줄 (오전 8:00 기상 …)
  meta: string[]; // 알람 강도 · 중 / 준비 60분 · 이동 50분 · 여유 10분
  foot: string; // 팀 주간회의 · 세종대학교 · 오전 10:00
  enabled?: boolean; // 끄면 흐리게
  onToggle?: (next: boolean) => void; // 있으면 오른쪽 위에 스위치
  toggleLabel?: string; // 화면 읽기용 (팀 주간회의 알람)
  onPress?: () => void; // 시각 부분을 누르면 (알람 설정으로)
  pressLabel?: string;
  children?: ReactNode; // 카드 아래 덧붙임 (5분 앞당기기 버튼 등)
};

// 알람 카드 (.acard) — 홈 · 알람 목록 · 친구가 공유한 알람에서 같이 씀
export function AlarmCard({
  dateLabel,
  time,
  kindLabel,
  chain,
  meta,
  foot,
  enabled = true,
  onToggle,
  toggleLabel,
  onPress,
  pressLabel,
  children,
}: Props) {
  const body = (
    <>
      <View style={styles.big}>
        <Text variant="ampm" tone="sub">
          {time.ampm}
        </Text>
        <Text variant="number">{time.hm}</Text>
        <Text variant="small" tone="sub">
          {kindLabel}
        </Text>
      </View>
      <View style={styles.chain}>
        {chain.map((line, i) => (
          <View key={line} style={styles.chainItem}>
            {i > 0 ? (
              <Text variant="label" tone="faint" style={styles.dash}>
                -
              </Text>
            ) : null}
            <Text variant="label" weight={600}>
              {line}
            </Text>
          </View>
        ))}
      </View>
    </>
  );

  return (
    <View style={[styles.card, !enabled && styles.off]}>
      <View style={styles.head}>
        <Text variant="small" tone="sub">
          {dateLabel}
        </Text>
        {onToggle ? <Toggle value={enabled} onChange={onToggle} label={toggleLabel ?? `${foot} 알람`} /> : null}
      </View>
      {onPress ? (
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={pressLabel}
          style={({ pressed }) => [styles.body, pressed && styles.pressed]}
        >
          {body}
        </Pressable>
      ) : (
        <View style={styles.body}>{body}</View>
      )}
      <View style={styles.meta}>
        {meta.map((line) => (
          <Text key={line} variant="caption" tone="faint">
            {line}
          </Text>
        ))}
      </View>
      <Text variant="small" tone="sub" align="right" style={styles.foot}>
        {foot}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.card,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: space.cardBelow,
  },
  off: { opacity: 0.45 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 28 },
  body: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 2 },
  pressed: { opacity: 0.7 },
  big: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  chain: { alignItems: 'flex-end' },
  chainItem: { alignItems: 'flex-end' },
  dash: { lineHeight: 12 },
  meta: { marginTop: 2 },
  foot: { marginTop: 6 },
});
