import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, SectionHeader, Segmented, Stepper, Text, Toggle } from '@/components/ui';
import { TRANSPORT_NAME, WAKE_MARGIN_NAME } from '@/features/profile/labels';
import type { TransportType, WakeMargin } from '@/features/profile/types';
import type { HolidayPatternCode } from '@/features/profile/prepareMlSurvey';
import { TextLink } from '@/features/alarm/components/TextLink';
import { selectableTransport } from '@/features/alarm/realPlan';
import { HolidayPatternPicker } from '@/features/profile/components/HolidayPatternPicker';

import { colors } from '@/theme';

import { ChoiceChips } from './ChoiceChips';

export type PrepareValues = {
  outingPrep: number | null; // explicitly entered pure preparation start -> departure, never wake -> departure
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
const TRANSPORT_ORDER: readonly TransportType[] = ['TRANSIT', 'CAR', 'WALK'];
const MARGIN_ORDER: readonly WakeMargin[] = ['TIGHT', 'NORMAL', 'LOOSE'];
const TRANSPORTS = TRANSPORT_ORDER.map((v) => [v, TRANSPORT_NAME[v]] as const);
const MARGINS = MARGIN_ORDER.map((v) => [v, WAKE_MARGIN_NAME[v]] as const);

// 아침 준비 단계 (L02-5) — 준비 · 여유 시간, 이동 수단, 깨우는 여유. 값 · 콜백만 받고 저장은 부르는 화면이 함
export function PrepareStep({ values, onChange, ml, onMlChange }: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  // 온보딩(연구정보를 같이 받는 쪽)에서는 첫 화면에 값 4개만 — 깨우는 여유 · 연구정보는 "더 정하기"로 접음. 설정 시트는 그대로 펼침
  if (ml && onMlChange) {
    const prep = values.outingPrep ?? 30;
    const more = `깨우는 여유 ${WAKE_MARGIN_NAME[values.margin]} · 연구정보 ${ml.consent ? '동의' : '안 함'}`;
    return (
      <>
        <Card>
          <Stepper first label="순수 외출 준비시간" value={prep} onChange={(outingPrep) => onChange({ outingPrep })} min={5} max={240} step={5} unit="분" />
          {values.outingPrep == null ? (
            <View style={styles.exampleRow}>
              <Text variant="small" tone="sub" style={styles.moreText}>
                30분은 예시예요
              </Text>
              <TextLink label="30분으로 정하기" onPress={() => onChange({ outingPrep: 30 })} />
            </View>
          ) : null}
          <Stepper label="여유 시간" value={values.buffer} onChange={(buffer) => onChange({ buffer })} min={0} max={60} step={5} unit="분" />
          <View style={styles.sumRow}>
            <Text variant="body" tone="sub">
              기상 → 출발
            </Text>
            <Text variant="bodyStrong">{prep + values.buffer}분</Text>
          </View>
        </Card>
        <SectionHeader title="이동 수단" />
        <ChoiceChips label="이동 수단" options={TRANSPORTS} value={selectableTransport(values.transport)} onChange={(transport) => onChange({ transport })} />
        <View style={styles.moreRow}>
          <Text variant="small" tone="sub" numberOfLines={1} style={styles.moreText}>
            {more}
          </Text>
          <TextLink label={moreOpen ? '접기 ⌃' : '더 정하기(선택) ›'} onPress={() => setMoreOpen((v) => !v)} />
        </View>
        {moreOpen ? (
          <>
            <SectionHeader title="깨우는 여유" />
            <Segmented options={MARGINS} value={values.margin} onChange={(margin) => onChange({ margin })} />
            <Text variant="small" tone="sub" style={styles.help}>
              10번 중 7 · 8 · 9번 안 늦게
            </Text>
            <SectionHeader title="준비시간 연구정보" />
            <Stepper label="만 나이" value={ml.age} onChange={(age) => onMlChange({ age })} min={14} max={100} step={1} unit="세" />
            <HolidayPatternPicker value={ml.holiday} onChange={(holiday) => onMlChange({ holiday })} />
            <View style={styles.consentRow}>
              <Text variant="bodyStrong" style={styles.consentName}>
                준비시간 연구에 내 기록 쓰기
              </Text>
              <Toggle
                value={ml.consent}
                onChange={(consent) => onMlChange({ consent })}
                label="준비시간 연구에 내 기록 쓰기 — 만 나이와 선택한 휴무 형태의 수집 · 이용에 동의"
              />
            </View>
            <Text variant="small" tone="sub">선택이에요. 동의하면 개인정보 안내 단계에서 저장해요.</Text>
          </>
        ) : null}
      </>
    );
  }
  return (
    <>
      <Text variant="bodyStrong" style={styles.question}>
        외출 준비를 시작해서 집을 나서기까지 보통 몇 분?
      </Text>
      <Text variant="small" tone="sub">
        식사 · 과제처럼 준비 전에 하는 일은 빼고 입력해 주세요.
        연구에 동의하면 기록이 쌓일수록 실제 준비 시간에 맞춰 조금씩 고칠 수 있어요.
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
            <Text variant="small" tone="sub" style={styles.help}>아직 정하지 않았어요. 위 30분은 예시예요.</Text>
            <Button label="30분으로 설정" onPress={() => onChange({ outingPrep: 30 })} />
          </>
        ) : null}
      </Card>

      <SectionHeader title="여유 시간" />
      <Card>
        <Stepper first label="여유 시간" value={values.buffer} onChange={(buffer) => onChange({ buffer })} min={0} max={60} step={5} unit="분" />
      </Card>

      <SectionHeader title="이동 수단" />
      <ChoiceChips label="이동 수단" options={TRANSPORTS} value={selectableTransport(values.transport)} onChange={(transport) => onChange({ transport })} />

      <SectionHeader title="깨우는 여유" />
      <Segmented options={MARGINS} value={values.margin} onChange={(margin) => onChange({ margin })} />
      <Text variant="small" tone="sub" style={styles.help}>
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
          <View style={styles.consentRow}>
            <Text variant="bodyStrong" style={styles.consentName}>
              준비시간 연구에 내 기록 쓰기
            </Text>
            <Toggle
              value={ml.consent}
              onChange={(consent) => onMlChange({ consent })}
              label="준비시간 연구에 내 기록 쓰기 — 만 나이와 선택한 휴무 형태의 수집 · 이용에 동의"
            />
          </View>
          <Text variant="small" tone="sub">동의한 경우에만 온보딩의 개인정보 안내 단계에서 저장하며, 설정에서 언제든 삭제할 수 있어요.</Text>
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  question: { marginBottom: 10 },
  help: { marginHorizontal: 4 },
  sumRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: colors.line, minHeight: 44 },
  moreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 14, minHeight: 44 },
  exampleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 44 },
  moreText: { flex: 1, minWidth: 0 },
  consentRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 8 },
  consentName: { flex: 1, minWidth: 0 },
});
