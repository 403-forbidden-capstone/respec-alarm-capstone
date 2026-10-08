import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { Text } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { colors, font, radius } from '@/theme';

type Props = {
  placeholder: string;
  actionLabel: string; // 오른쪽 글자 버튼 (추가)
  onAction: (text: string) => void;
};

// 검색 칸 (.search) — 왼쪽 돋보기, 오른쪽 글자 버튼. 입력 중이면 테두리를 진하게
export function SearchBox({ placeholder, actionLabel, onAction }: Props) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);

  return (
    <View style={[styles.box, focused && styles.focused]}>
      <Text variant="body" tone="sub" accessibilityElementsHidden importantForAccessibility="no">
        ⌕
      </Text>
      <TextInput
        value={text}
        onChangeText={setText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={() => onAction(text)}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        accessibilityLabel={placeholder}
        returnKeyType="search"
        style={styles.input}
      />
      <TextLink label={actionLabel} onPress={() => onAction(text)} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 48,
    paddingHorizontal: 14,
    borderRadius: radius.field,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    marginTop: 14,
    marginBottom: 12,
  },
  focused: { borderColor: colors.ink },
  input: { ...font(400), flex: 1, minWidth: 0, fontSize: 14, color: colors.ink, paddingVertical: 0 },
});
