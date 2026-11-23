import { StyleSheet } from 'react-native';

import { Button, Card, SectionHeader, Segmented, Stepper, Text, Toggle } from '@/components/ui';
import { TRANSPORT_NAME, WAKE_MARGIN_NAME } from '@/features/profile/labels';
import type { TransportType, WakeMargin } from '@/features/profile/types';
import type { HolidayPatternCode } from '@/features/profile/prepareMlSurvey';
import { HolidayPatternPicker } from '@/features/profile/components/HolidayPatternPicker';

import { ChoiceChips } from './ChoiceChips';

export type PrepareValues = {
  prepare: number; // legacy: wake -> departure (minutes)
  outingPrep?: number | null; // pure prep start -> actual departure, explicitly answered
  buffer: number; // 여유 시간(분)
  transport: TransportType;
  margin: WakeMargin;
};

export type PrepareMlDraft = { age: number; holiday: HolidayPatternCode | null; consent: boolean };
type Props = {
  values: PrepareValues;
  onChange: (patch: Partial<PrepareValues>) => void;
  // Onboarding-only research survey. Settings reuses PrepareStep without this.
  ml?: PrepareMlDraft;
  onMlChange?: (patch: Partial<PrepareMlDraft>) => void;
};

// 이름은 profile/labels.ts (깨우는 여유는 D63 3단계 — 기록의 0.7 · 0.8 · 0.9 분위수, 예측 반영은 L1)
const TRANSPORT_ORDER: readonly TransportType[] = ['TRANSIT', 'BUS', 'SUBWAY', 'CAR', 'WALK'];
const MARGIN_ORDER: readonly WakeMargin[] = ['TIGHT', 'NORMAL', 'LOOSE'];
const TRANSPORTS = TRANSPORT_ORDER.map((v) => [v, TRANSPORT_NAME[v]] as const);
const MARGINS = MARGIN_ORDER.map((v) => [v, WAKE_MARGIN_NAME[v]] as const);

// 아침 준비 단계 (L02-5) — 준비 · 여유 시간, 이동 수단, 깨우는 여유. 값 · 콜백만 받고 저장은 부르는 화면이 함
export function PrepareStep({ values, onChange, ml, onMlChange }: Props) {
  return (
    <>
      {/* Stepper 줄은 라벨이 줄어들지 않아 긴 질문은 줄 위에 따로 적음 */}
      <Text variant="bodyStrong" style={styles.question}>
        일어나서 집을 나서기까지 보통 몇 분?
      </Text>
      <Card>
        <Stepper
          first
          label="기상~출발 전체 시간"
          value={values.prepare}
          onChange={(prepare) => onChange({ prepare })}
          min={5}
          max={300}
          step={5}
          unit="분"
        />
        <Stepper label="여유 시간" value={values.buffer} onChange={(buffer) => onChange({ buffer })} min={0} max={60} step={5} unit="분" />
      </Card>
      <SectionHeader title="외출 준비만 걸리는 시간" />
      <Text variant="small" tone="sub">
        식사·과제처럼 준비하기 전에 하는 일은 제외하고, 씻고 옷을 입는 등 외출 준비를 시작한 순간부터 집을 나설 때까지의 시간을 입력해 주세요.
        기존 기상~출발 시간과 별도로 저장돼요. 새 개인 일정의 자동 계산에 반영되며, 이후 실제 기록이 쌓이면 점진적으로 보정돼요. 이미 저장된 알람은 다시 확인해 주세요.
      </Text>
      <Card>
        <Stepper
          first
          label="순수 외출 준비시간"
          value={values.outingPrep ?? 30}
          onChange={(outingPrep) => onChange({ outingPrep })}
          min={5}
          max={240}
          step={5}
          unit="분"
        />
        {values.outingPrep == null ? (
          <>
            <Text variant="caption" style={styles.help}>미설정 — 위 30분은 예시이며 아직 저장되지 않았어요.</Text>
            <Button label="30분으로 설정" onPress={() => onChange({ outingPrep: 30 })} />
          </>
        ) : null}
      </Card>

      <SectionHeader title="이동 수단" />
      <ChoiceChips label="이동 수단" options={TRANSPORTS} value={values.transport} onChange={(transport) => onChange({ transport })} />

      <SectionHeader title="깨우는 여유" />
      <Segmented options={MARGINS} value={values.margin} onChange={(margin) => onChange({ margin })} />
      <Text variant="caption" style={styles.help}>
        10번 중 7 · 8 · 9번 안 늦게
      </Text>
      {ml && onMlChange ? (
        <>
          <SectionHeader title="준비시간 예측 연구정보 (선택)" />
          <Text variant="small" tone="sub">
            선택하지 않아도 알람을 사용할 수 있어요. 수집된 정보는 검증과 별도 활성화 전까지 예측에 사용하지 않아요.
          </Text>
          <Stepper label="만 나이" value={ml.age} onChange={(age) => onMlChange({ age })} min={14} max={100} step={1} unit="세" />
          <HolidayPatternPicker value={ml.holiday} onChange={(holiday) => onMlChange({ holiday })} />
          <Toggle
            value={ml.consent}
            onChange={(consent) => onMlChange({ consent })}
            label="만 나이와 선택한 휴무 형태의 예측 연구용 수집·이용에 동의"
          />
          <Text variant="small" tone="sub">동의한 경우에만 온보딩의 개인정보 안내 단계에서 저장하며, 설정에서 언제든 삭제할 수 있어요.</Text>
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  question: { marginBottom: 10 },
  help: { marginHorizontal: 4 },
});
