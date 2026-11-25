import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { dropRepeatedAmpm, keepWords } from '@/lib/format';
import { useAccent } from '@/lib/skyTone';
import { colors, radius, size, space } from '@/theme';

import { Text } from './Text';
import { Toggle } from './Toggle';

type Props = {
  dateLabel: string; // 5월 22일 (목) · 캡스톤팀 공유 — 섹션 제목에 날짜가 있는 목록(H02)에서는 '캡스톤팀 공유'만, 없으면 빈 줄
  time: { ampm: string; hm: string }; // 첫 알람 (큰 글자)
  kindLabel: string; // 기상
  chain: string[]; // 큰 시각 아래 한 줄 (오전 8:00 기상 · 8:30 준비 …) — 오전 · 오후는 바뀔 때만 보임, 한 줄이 넘으면 항목 단위로 아래 줄로
  meta: string[]; // 약속 줄 아래 작은 글자 — 알람 강도 · 중 / 준비 60분 · 이동 50분 · 여유 10분
  foot: string; // 약속 줄: 팀 주간회의 · 세종대학교 · 오전 10:00
  enabled?: boolean; // 끄면 시각 · 글자만 흐리게 (스위치 · children은 그대로)
  onToggle?: (next: boolean) => void; // 있으면 오른쪽 위에 스위치
  toggleLabel?: string; // 화면 읽기용 (팀 주간회의 알람)
  onPress?: () => void; // 카드를 누르면 (알람 설정으로). 스위치 · children의 버튼은 따로 눌림
  pressLabel?: string;
  children?: ReactNode; // 카드 아래 덧붙임 (5분 앞당기기 버튼 등)
  // 모양 — full: 날짜 · 큰 시각 · 체인 · 약속 줄 · 작은 글자 (친구가 공유한 알람)
  //        flow: 홈 "다음 알람". 하늘 위 유리 카드에 약속 이름 · 큰 시각 · 흐름 점 줄 · 같이 준비하는 사람 줄
  //        compact: 알람 목록. 시각 · 체인 · 약속 세 줄 (작은 글자는 부르는 쪽이 넘긴 것만 — 반복 줄)
  variant?: 'full' | 'flow' | 'compact';
  steps?: { label: string; time: string }[]; // flow — 기상 → 준비 → 출발 → 일정
  activeStep?: number; // flow — 다음에 울릴 단계 (포인트 색 점)
  together?: { faces: string[]; line: string } | null; // flow — 같이 준비하는 그룹: 멤버 이름 앞 글자 · "캡스톤팀 · 준비 중 1 · 기상 완료 1"
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
  variant = 'full',
  steps,
  activeStep = 0,
  together,
}: Props) {
  const accent = useAccent(); // 지금 단계 점 — 포인트 색 (lib/skyTone)
  const hero = variant === 'flow';
  const compact = variant === 'compact';
  const dim = enabled ? null : styles.dim;
  // 4단 왼쪽 정렬 — [날짜 · 스위치] / [큰 시각 + 종류] / [체인 한 줄] / [약속 줄] 그 아래 작은 글자(meta)
  const main = (
    <>
      {compact ? null : (
        <View style={[styles.head, onToggle && styles.headGap]}>
          <Text variant="small" tone={hero ? 'ink' : 'sub'} weight={hero ? 600 : 400} style={dim} numberOfLines={1}>
            {hero ? foot : dateLabel}
          </Text>
        </View>
      )}
      <View style={dim}>
        <View style={styles.big}>
          <Text variant="ampm" tone="sub">
            {time.ampm}
          </Text>
          <Text variant="number" style={compact ? styles.compactNum : null}>{time.hm}</Text>
          <Text variant="small" tone="sub">
            {kindLabel}
          </Text>
        </View>
        {/* 항목은 줄 안에서 쪼개지지 않고, 좁으면 항목 단위로 다음 줄로 내려감 — 글자 폭으로 칸을 재면 Android에서 "기 / 상"처럼 끝 글자가 넘어감 (#222) */}
        <View style={[styles.chain, hero && styles.hide]}>
          {dropRepeatedAmpm(chain).map((line, i) => (
            <Text key={`${i}-${line}`} variant="label" weight={600}>
              {keepWords(line)}
            </Text>
          ))}
        </View>
        {/* 누를 수 있는 카드만 약속 줄 끝에 › (눌리지 않는 공유 알람 카드에는 없음) */}
        {hero && steps ? (
          <View style={styles.steps}>
            {steps.map((st, i) => (
              <View key={st.label} style={styles.step}>
                <View style={styles.stepRail}>
                  <View style={[styles.stepDot, i === activeStep && { backgroundColor: accent, borderColor: accent }]} />
                  {i < steps.length - 1 ? <View style={styles.stepBar} /> : null}
                </View>
                <Text variant="label" tone="ink" weight={i === activeStep ? 700 : 400}>
                  {st.time}
                </Text>
                <Text variant="caption" tone="sub">
                  {st.label}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {hero && together ? (
          <View style={styles.together}>
            <View style={styles.faces}>
              {together.faces.map((n, i) => (
                <View key={`${i}-${n}`} style={[styles.face, i > 0 && styles.faceNext]}>
                  <Text variant="caption" tone="ink" weight={600}>
                    {n}
                  </Text>
                </View>
              ))}
            </View>
            <Text variant="caption" tone="sub" style={styles.footText} numberOfLines={1}>
              {together.line}
            </Text>
          </View>
        ) : null}
        <View style={[styles.foot, hero && styles.hide]}>
          <Text variant="small" tone="sub" style={styles.footText}>
            {foot}
          </Text>
          {onPress ? (
            <Text variant="small" tone="faint">
              ›
            </Text>
          ) : null}
        </View>
        {meta.length && !hero ? (
          <View style={styles.meta}>
            {meta.map((line) => (
              <Text key={line} variant="caption" tone="faint">
                {line}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
    </>
  );
  const mainStyle = [styles.main, children ? styles.mainOpen : null];

  // 카드 전체가 누르는 칸이고, 스위치 · 아래 덧붙임(children)은 그 위에 따로 얹어 서로 영향을 주지 않음
  // (스위치를 누르는 칸 안에 넣으면 화면 읽기 도구가 스위치를 따로 읽지 못함)
  return (
    <View style={[styles.card, hero && styles.hero]}>
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
  hero: { backgroundColor: colors.glassCard, borderColor: colors.glassLine, boxShadow: colors.glassShadow },
  compactNum: { fontSize: 32, lineHeight: 36, letterSpacing: -1 },
  steps: { flexDirection: 'row', marginTop: 12 },
  step: { flex: 1, gap: 1 },
  stepRail: { flexDirection: 'row', alignItems: 'center', height: 14, marginBottom: 4 },
  stepDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: colors.faint, backgroundColor: colors.card },
  stepBar: { flex: 1, height: 1.5, backgroundColor: colors.line, marginHorizontal: 4 },
  together: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.glassLine },
  faces: { flexDirection: 'row' },
  face: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  faceNext: { marginLeft: -6 },
  hide: { display: 'none' },
  dim: { opacity: 0.45 }, // 끈 알람은 시각 · 글자만 흐리게
  toggle: { position: 'absolute', top: 14, right: 16 },
  head: { justifyContent: 'center', minHeight: 28 },
  headGap: { paddingRight: size.switchW + 12 }, // 스위치가 얹힐 자리
  pressed: { opacity: 0.7 },
  big: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 6, rowGap: 2, paddingTop: 2 }, // 큰 글자에서 종류 글자가 아래 줄로 내려가도 줄이 붙지 않게 rowGap
  chain: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 2, marginTop: 2 },
  foot: { marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 4 },
  footText: { flex: 1 },
  meta: { marginTop: 2 },
});
