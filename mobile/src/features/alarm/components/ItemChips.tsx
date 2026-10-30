import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Button, Text } from '@/components/ui';
import { colors, font, radius, size } from '@/theme';

type Props = {
  label: string;
  items: string[];
  onRemove: (name: string) => void;
  text: string; // 아직 추가하지 않은 입력
  onChangeText: (next: string) => void;
  onAdd: () => void; // "추가" · 키보드 완료
  placeholder?: string;
};

// 준비물 입력 — 적고 추가(또는 엔터)하면 아래에 칩이 쌓이고, × 로 하나씩 지움
// 입력이 비어 있으면 "추가"를 숨기고 글자도 굵게 하지 않음 — 자리 글자가 값처럼 보이지 않게
export function ItemChips({ label, items, onRemove, text, onChangeText, onAdd, placeholder }: Props) {
  const filled = text.trim().length > 0;
  return (
    <View>
      <View style={styles.row}>
        <Text variant="body" tone="sub" style={styles.label}>
          {label}
        </Text>
        <TextInput
          value={text}
          onChangeText={onChangeText}
          onSubmitEditing={onAdd}
          blurOnSubmit={false}
          returnKeyType="done"
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          maxLength={20}
          accessibilityLabel={`${label} 이름`}
          maxFontSizeMultiplier={1.3}
          style={[styles.input, font(filled ? 600 : 400)]}
        />
        {filled ? <Button small variant="ghost" label="추가" onPress={onAdd} /> : null}
      </View>
      {items.length ? (
        <View style={styles.chips}>
          {items.map((name) => (
            <View key={name} style={styles.chip}>
              <Text variant="label" numberOfLines={1} style={styles.chipText}>
                {name}
              </Text>
              <Pressable
                onPress={() => onRemove(name)}
                hitSlop={{ top: 14, bottom: 14, left: 18, right: 18 }}
                accessibilityRole="button"
                accessibilityLabel={`${name} 지우기`}
                style={({ pressed }) => pressed && styles.pressed}
              >
                <Text variant="label" tone="sub">
                  ×
                </Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: size.touch },
  label: { fontSize: 13.5, flexShrink: 0 },
  input: { flex: 1, minWidth: 0, fontSize: 14, color: colors.ink, textAlign: 'right', paddingVertical: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6, paddingBottom: 4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: size.chip,
    paddingHorizontal: 10,
    borderRadius: radius.chip,
    backgroundColor: colors.chip,
    maxWidth: '100%',
  },
  chipText: { flexShrink: 1 },
  pressed: { opacity: 0.5 },
});
