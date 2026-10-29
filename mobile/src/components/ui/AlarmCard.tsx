import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, radius, size, space } from '@/theme';

import { Text } from './Text';
import { Toggle } from './Toggle';

type Props = {
  dateLabel: string; // 5월 22일 (목) · 캡스톤팀 공유 — 섹션 제목에 날짜가 있는 목록(H02)에서는 '캡스톤팀 공유'만, 없으면 빈 줄
  time: { ampm: string; hm: string }; // 첫 알람 (큰 글자)
  kindLabel: string; // 기상
  chain: string[]; // 오른쪽 세로 줄 (오전 8:00 기상 …)
  meta: string[]; // 알람 강도 · 중 / 준비 60분 · 이동 50분 · 여유 10분
  foot: string; // 팀 주간회의 · 세종대학교 · 오전 10:00
  enabled?: boolean; // 끄면 시각 · 글자만 흐리게 (스위치 · children은 그대로)
  onToggle?: (next: boolean) => void; // 있으면 오른쪽 위에 스위치
  toggleLabel?: string; // 화면 읽기용 (팀 주간회의 알람)
  onPress?: () => void; // 카드를 누르면 (알람 설정으로). 스위치 · children의 버튼은 따로 눌림
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
      {/* 오른쪽 줄은 남은 폭을 다 받고 오른쪽 정렬 · 한 줄 — 글자 폭으로 칸을 재면 Android에서 "기 / 상"처럼 끝 글자가 넘어감 (#222) */}
      <View style={styles.chain}>
        {chain.map((line, i) => (
          <View key={line}>
            {i > 0 ? (
              <Text variant="label" tone="faint" align="right" style={styles.dash}>
                -
              </Text>
            ) : null}
            <Text variant="label" weight={600} align="right" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
              {line}
            </Text>
          </View>
        ))}
      </View>
    </>
  );

  const dim = enabled ? null : styles.dim;
  const main = (
    <>
      <View style={[styles.head, onToggle && styles.headGap]}>
        <Text variant="small" tone="sub" style={dim}>
          {dateLabel}
        </Text>
      </View>
      <View style={[styles.body, dim]}>{body}</View>
      <View style={[styles.meta, dim]}>
        {meta.map((line) => (
          <Text key={line} variant="caption" tone="faint">
            {line}
          </Text>
        ))}
      </View>
      {/* 누를 수 있는 카드만 약속 줄 끝에 › (눌리지 않는 공유 알람 카드에는 없음) */}
      <View style={[styles.foot, dim]}>
        <Text variant="small" tone="sub" align="right" style={styles.footText}>
          {foot}
        </Text>
        {onPress ? (
          <Text variant="small" tone="faint">
            ›
          </Text>
        ) : null}
      </View>
    </>
  );
  const mainStyle = [styles.main, children ? styles.mainOpen : null];

  // 카드 전체가 누르는 칸이고, 스위치 · 아래 덧붙임(children)은 그 위에 따로 얹어 서로 영향을 주지 않음
  // (스위치를 누르는 칸 안에 넣으면 화면 읽기 도구가 스위치를 따로 읽지 못함)
  return (
    <View style={styles.card}>
      {onPress ? (
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={pressLabel}
          style={({ pressed }) => [mainStyle, pressed && styles.pressed]}
        >
          {main}
        </Pressable>
      ) : (
        <View style={mainStyle}>{main}</View>
      )}
      {onToggle ? (
        <View style={styles.toggle}>
          <Toggle value={enabled} onChange={onToggle} label={toggleLabel ?? `${foot} 알람`} />
        </View>
      ) : null}
      {children ? <View style={styles.extra}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.card,
    marginBottom: space.cardBelow,
  },
  // 안쪽 여백은 누르는 칸(main)이 가져서 카드 가장자리까지 눌림
  main: { paddingTop: 14, paddingBottom: 14, paddingHorizontal: 16 },
  mainOpen: { paddingBottom: 0 }, // 아래 덧붙임이 있으면 그 밑에 여백
  extra: { paddingHorizontal: 16, paddingBottom: 14 },
  dim: { opacity: 0.45 }, // 끈 알람은 시각 · 글자만 흐리게
  toggle: { position: 'absolute', top: 14, right: 16 },
  head: { justifyContent: 'center', minHeight: 28 },
  headGap: { paddingRight: size.switchW + 12 }, // 스위치가 얹힐 자리
  body: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 2 },
  pressed: { opacity: 0.7 },
  big: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  chain: { flex: 1, marginLeft: 12 },
  dash: { lineHeight: 12 },
  meta: { marginTop: 2 },
  foot: { marginTop: 6, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 4 },
  footText: { flexShrink: 1 },
});
