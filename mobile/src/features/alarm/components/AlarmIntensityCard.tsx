import { LATE_COUNT_THRESHOLD } from '@shared/calc/intensity.ts';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { ALARM_AXES_PICKER } from '@/lib/flags';
import { colors } from '@/theme';

import { AXES, IMPORTANCE_LABEL, LEVELS, type Importance, type IntensityAxis, type Level } from '../types';
import { OptionGrid } from './OptionGrid';
import { TextLink } from './TextLink';

const LEVEL_OPTIONS = LEVELS.map((l, i) => [i as Level, l.name] as const);
export type AxisLevels = Record<IntensityAxis, Level | null>; // null = 자동
export const AUTO_LEVELS: AxisLevels = { sound: null, voice: null, vibration: null };

type Props = {
  auto: Level; // 중요도 · 최근 4주 늦잠 지각 · 잠귀로 정한 자동 단계
  voiceAuto: Level; // 말소리를 직접 안 골랐을 때 값 (설정의 기본 말소리, 없으면 auto)
  importance: Importance;
  lateCount: number; // 최근 4주 늦잠 지각 횟수
  levels: AxisLevels;
  onChange: (next: AxisLevels) => void;
  // 자동 강도 입력(지각 이력 · 잠귀 · 기본 말소리)을 읽는 중 · 못 읽음 — 새 일정(H05)만 씀. 없으면 다 읽은 것
  basis?: 'loading' | 'fallback';
  onRetry?: () => void; // fallback일 때 "다시 불러오기"
};

// 알람 강도 카드 — 새 일정(H05)과 알람 설정(H03)이 같이 씀. 값 · 콜백만 받고 저장은 화면이 함
export function AlarmIntensityCard({ auto, voiceAuto, importance, lateCount, levels, onChange, basis, onRetry }: Props) {
  const [open, setOpen] = useState(false); // 기본은 한 줄 요약 — 바꾸기를 눌러야 배경음 · 말소리 · 진동이 펴짐
  const autoOf = (axis: IntensityAxis): Level => (axis === 'voice' ? voiceAuto : auto);
  const lvOf = (axis: IntensityAxis): Level => levels[axis] ?? autoOf(axis);
  const summary = `${LEVELS[lvOf('sound')].name} · ${LEVELS[lvOf('sound')].sound} · ${LEVELS[lvOf('voice')].voice} · ${LEVELS[lvOf('vibration')].vibration}`;
  const anyManual = AXES.some(([axis]) => levels[axis] != null);
  const setAxis = (axis: IntensityAxis, level: Level | null) => onChange({ ...levels, [axis]: level });
  const loading = basis === 'loading';
  // 읽는 중에는 아직 모르는 자동 값을 보이지 않음 — 다 읽은 뒤 값이 바뀌어 보이지 않게
  const showAxes = ALARM_AXES_PICKER && open && !loading; // 축별 선택은 flag로 숨길 수 있음 (lib/flags.ts ALARM_AXES_PICKER)

  return (
    <Card>
      <Text variant="label" tone="sub" style={styles.label}>
        알람 강도
      </Text>
      {/* 점수 식은 안 보임 — 결과와 쉬운 말만 (H05 계산 근거와 같게, D47) */}
      {loading ? (
        <Text variant="small" tone="sub" accessibilityLiveRegion="polite">
          지각 이력 · 잠귀 설정을 불러오는 중이에요
        </Text>
      ) : basis === 'fallback' ? (
        // 못 읽으면 중요도만으로 본 예상값 — 저장할 때 서버가 지각 이력 · 잠귀까지 넣어 다시 정하고, 확인 시트에 그 값이 나옴
        <View style={styles.between}>
          <Text variant="small" tone="sub" style={styles.summary}>
            중요도 {IMPORTANCE_LABEL[importance]} 기준 예상 {LEVELS[auto].name} · 지각 이력 · 잠귀 설정을 못 불러왔어요. 저장할 때 반영돼요
          </Text>
          {onRetry ? <TextLink label="다시 불러오기" onPress={onRetry} /> : null}
        </View>
      ) : (
        <Text variant="small" tone="sub">
          자동 {LEVELS[auto].name} · 중요도 {IMPORTANCE_LABEL[importance]}
          {lateCount >= LATE_COUNT_THRESHOLD ? ` · 최근 4주 늦잠 지각 ${lateCount}번` : ''}
        </Text>
      )}
      {loading ? null : (
        <View style={styles.between}>
          <Text variant="body" style={styles.summary}>
            {summary}
          </Text>
          {ALARM_AXES_PICKER ? <TextLink label={open ? '접기 ›' : '바꾸기 ›'} onPress={() => setOpen((v) => !v)} /> : null}
        </View>
      )}
      {(showAxes ? AXES : []).map(([axis, name]) => {
        const picked = levels[axis];
        const level = lvOf(axis);
        return (
          <View key={axis}>
            {/* 항목명은 왼쪽, 약 · 중 · 강은 오른쪽 */}
            <View style={styles.axis}>
              <View style={styles.axisName}>
                <Text variant="rowLabel" tone="sub">
                  {name}
                </Text>
                {picked != null ? (
                  <Text variant="tiny" tone="sub" style={styles.manual}>
                    직접 고름
                  </Text>
                ) : null}
              </View>
              <OptionGrid size="mini" label={`${name} 강도`} options={LEVEL_OPTIONS} value={level} onChange={(next) => setAxis(axis, next)} />
            </View>
            <View style={styles.axisDesc}>
              {/* 직접 고른 항목만 이 축을 자동으로 되돌리는 링크 */}
              {picked != null ? <TextLink label="자동으로" accessibilityLabel={`${name} 자동으로 되돌리기`} onPress={() => setAxis(axis, null)} /> : <View />}
              <Text variant="label" tone="faint" align="right" accessibilityLiveRegion="polite">
                {LEVELS[level][axis]}
              </Text>
            </View>
          </View>
        );
      })}
      {showAxes && anyManual ? (
        <View style={styles.reset}>
          <TextLink label="모두 자동으로 되돌리기" onPress={() => onChange(AUTO_LEVELS)} />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  label: { marginBottom: 8 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  summary: { flex: 1 },
  axis: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 12 },
  axisName: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, gap: 6 },
  manual: { backgroundColor: colors.chip, borderRadius: 8, paddingHorizontal: 6, overflow: 'hidden' },
  axisDesc: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  reset: { marginTop: 6, alignSelf: 'flex-start' },
});
