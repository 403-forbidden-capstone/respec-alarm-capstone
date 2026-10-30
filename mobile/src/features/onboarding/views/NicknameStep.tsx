import { StyleSheet } from 'react-native';

import { Card, Field, Text } from '@/components/ui';

type Props = {
  value: string;
  onChange: (next: string) => void;
  max: number; // 글자 수 한도
};

// 닉네임 단계 (L02-2) — 입력 한 칸. 공백만이면 못 넘어가는 처리와 저장은 부르는 화면이 함
export function NicknameStep({ value, onChange, max }: Props) {
  return (
    <>
      <Card>
        <Field first label="닉네임" value={value} onChangeText={onChange} maxLength={max} placeholder="이름" />
      </Card>
      <Text variant="caption" style={styles.help}>
        {max}자까지 쓸 수 있어요
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  help: { marginHorizontal: 4, marginTop: 2 },
});
