import { StyleSheet } from 'react-native';

import { Card, Field, Text } from '@/components/ui';

type Props = {
  value: string;
  onChange: (next: string) => void;
  error?: string | null; // 저장하려다 막힌 이유 (이미 쓰는 아이디 등)
};

// 내 아이디 단계 (L02-1) — 입력 한 칸 + 규칙 안내. 형식 검사 · 중복 확인 · 저장은 부르는 화면이 함
// L3 changeHandle 오면 교체 (자동 아이디 [바꾸기] 화면 — Q1)
export function HandleStep({ value, onChange, error }: Props) {
  return (
    <>
      <Card>
        <Field
          first
          label="아이디"
          value={value}
          onChangeText={onChange}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={21}
          placeholder="respec_kim"
        />
      </Card>
      {error ? (
        <Text variant="small" tone="warn" style={styles.help}>
          {error}
        </Text>
      ) : null}
      <Text variant="caption" style={styles.help}>
        영문 소문자 · 숫자 · _ 3~20자
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  help: { marginHorizontal: 4, marginTop: 2 },
});
