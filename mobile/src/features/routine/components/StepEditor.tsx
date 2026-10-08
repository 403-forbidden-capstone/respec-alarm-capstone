import { StyleSheet, View } from 'react-native';

import { Button, Field, KeyValueRow, Stepper, Text, Toggle } from '@/components/ui';

import type { RoutineStep } from '../types';

type Props = {
  step: RoutineStep;
  time: string; // 시작 시각 21:30
  index: number;
  count: number; // 전체 단계 수
  onChange: (patch: Partial<Omit<RoutineStep, 'id'>>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  onClose: () => void;
};

// 단계 편집 시트 내용 — 이름 · 걸리는 시간 · 알람 · 순서 바꾸기 · 빼기 (마지막 한 단계는 못 뺌)
export function StepEditor({ step, time, index, count, onChange, onMove, onRemove, onClose }: Props) {
  return (
    <>
      <Text variant="small" tone="sub">
        {time} 시작
      </Text>
      <View style={styles.fields}>
        <Field first label="이름" value={step.name} onChangeText={(name) => onChange({ name })} maxLength={30} />
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
        <Button label="위로" small variant="ghost" onPress={() => onMove(-1)} disabled={index === 0} />
        <Button label="아래로" small variant="ghost" onPress={() => onMove(1)} disabled={index === count - 1} />
        <Button label="단계 빼기" small variant="plain" onPress={onRemove} disabled={count <= 1} />
      </View>
      <View style={styles.stack}>
        <Button label="완료" onPress={onClose} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  fields: { marginTop: 10 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  stack: { marginTop: 16 },
});
