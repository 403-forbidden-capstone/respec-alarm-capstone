import { Text } from '@/components/ui';
import { ChoiceChips } from '@/features/onboarding/views/ChoiceChips';
import { HOLIDAY_PATTERN_OPTIONS, type HolidayPatternCode } from '../prepareMlSurvey';

const EMPTY_CHOICE = 'UNANSWERED' as const;
const OPTIONS: readonly (readonly [HolidayPatternCode | typeof EMPTY_CHOICE, string])[] = [
  [EMPTY_CHOICE, '모름 / 해당 없음 / 답하지 않음'],
  ...HOLIDAY_PATTERN_OPTIONS,
];

// 2024 Time Use Survey 휴일종류코드 = respondent's usual time-off pattern.
// It does NOT mean whether an appointment date is a national holiday.
export function HolidayPatternPicker({
  value, onChange,
}: { value: HolidayPatternCode | null; onChange: (value: HolidayPatternCode | null) => void }) {
  return (
    <>
      <Text variant="bodyStrong">평소 쉬는 날은 어떻게 정해져 있나요? (선택)</Text>
      <Text variant="small" tone="sub">
        공휴일 여부가 아니라 평소 직장 등의 정기 휴무 형태예요. 해당하지 않으면 선택하지 않아도 돼요.
      </Text>
      <ChoiceChips
        label="평소 휴무 형태"
        options={OPTIONS}
        value={value ?? EMPTY_CHOICE}
        onChange={(next) => onChange(next === EMPTY_CHOICE ? null : next)}
      />
    </>
  );
}
