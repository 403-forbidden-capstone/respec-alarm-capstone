import { StyleSheet } from 'react-native';

import { Card, SectionHeader, Segmented, Stepper, Text } from '@/components/ui';
import type { TransportType, WakeMargin } from '@/features/profile/types';

import { ChoiceChips } from './ChoiceChips';

export type PrepareValues = {
  prepare: number; // 준비 시간(분)
  buffer: number; // 여유 시간(분)
  transport: TransportType;
  margin: WakeMargin;
};

type Props = {
  values: PrepareValues;
  onChange: (patch: Partial<PrepareValues>) => void;
};

const TRANSPORTS: readonly (readonly [TransportType, string])[] = [
  ['TRANSIT', '대중교통'],
  ['BUS', '버스'],
  ['SUBWAY', '지하철'],
  ['CAR', '자차'],
  ['WALK', '도보'],
];

// D63 깨우는 여유 3단계 — 기록의 0.7 · 0.8 · 0.9 분위수, 예측 반영은 L1
const MARGINS: readonly (readonly [WakeMargin, string])[] = [
  ['TIGHT', '빠듯'],
  ['NORMAL', '보통'],
  ['LOOSE', '넉넉'],
];

// 아침 준비 단계 (L02-5) — 준비 · 여유 시간, 이동 수단, 깨우는 여유. 값 · 콜백만 받고 저장은 부르는 화면이 함
export function PrepareStep({ values, onChange }: Props) {
  return (
    <>
      {/* Stepper 줄은 라벨이 줄어들지 않아 긴 질문은 줄 위에 따로 적음 */}
      <Text variant="bodyStrong" style={styles.question}>
        일어나서 집을 나서기까지 보통 몇 분?
      </Text>
      <Card>
        <Stepper
          first
          label="준비 시간"
          value={values.prepare}
          onChange={(prepare) => onChange({ prepare })}
          min={5}
          max={300}
          step={5}
          unit="분"
        />
        <Stepper label="여유 시간" value={values.buffer} onChange={(buffer) => onChange({ buffer })} min={0} max={60} step={5} unit="분" />
      </Card>

      <SectionHeader title="이동 수단" />
      <ChoiceChips label="이동 수단" options={TRANSPORTS} value={values.transport} onChange={(transport) => onChange({ transport })} />

      <SectionHeader title="깨우는 여유" />
      <Segmented options={MARGINS} value={values.margin} onChange={(margin) => onChange({ margin })} />
      <Text variant="caption" style={styles.help}>
        10번 중 7 · 8 · 9번 안 늦게
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  question: { marginBottom: 10 },
  help: { marginHorizontal: 4 },
});
