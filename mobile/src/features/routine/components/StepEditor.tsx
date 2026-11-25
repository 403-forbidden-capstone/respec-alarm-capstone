import { StyleSheet, View } from 'react-native';

import { Button, Field, KeyValueRow, Stepper, Text, Toggle } from '@/components/ui';

import type { RoutineStep } from '../types';

type Props = {
  step: RoutineStep;
  time: string; // 시작 시각 21:30
  index?: number; // (안 씀 — 순서는 단계 줄 ▲▼, 호출부 정리 전까지 받기만)
  onMove?: (by: -1 | 1) => void; // (안 씀)
  count: number; // 전체 단계 수
  focusName?: boolean; // 새로 추가한 단계라 열자마자 이름 칸에 커서
  onChange: (patch: Partial<Omit<RoutineStep, 'id'>>) => void;
  onRemove: () => void;
  onClose: () => void;
};

// 단계 편집 시트 내용 — 이름 · 걸리는 시간 · 알람 · 빼기 (순서는 단계 줄의 ▲▼) (마지막 한 단계는 못 뺌)
export function StepEditor({ step, time, count, focusName, onChange, onRemove, onClose }: Props) {
  return (
    <>
      <Text variant="small" tone="sub">
        {time} 시작
      </Text>
      <View style={styles.fields}>
        {/* 이름 칸에 들어가면 글자 전체를 선택 — 기본 이름("새 단계")을 바로 덮어씀 */}
        <Field first label="이름" value={step.name} onChangeText={(name) => onChange({ name })} maxLength={30} autoFocus={focusName} selectTextOnFocus />
        <Stepper
          label="걸리는 시간"
          value={step.minutes}
          onChange={(minutes) => onChange({ minutes })}
          step={1}
          min={1}
          max={60}
          unit="분"
        />
        <KeyValueRow
          label="알람"
          value={<Toggle value={step.alarm} onChange={(alarm) => onChange({ alarm })} label={`${step.name} 알람`} />}
        />
      </View>
      <View style={styles.row}>
        <Button label="단계 빼기" small variant="plain" onPress={onRemove} disabled={count <= 1} />
      </View>
      {count <= 1 ? (
        <Text variant="caption" tone="faint" style={styles.caption}>
          단계는 하나 이상 있어야 해요
        </Text>
      ) : null}
      <View style={styles.stack}>
        <Button label="완료" onPress={onClose} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  fields: { marginTop: 10 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  caption: { marginTop: 6 },
  stack: { marginTop: 16 },
});
