import { useIsFocused } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { BackHandler, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, size } from '@/theme';

import { Text } from './Text';

type Entry = { title?: string; node: ReactNode; onClose: () => void };

// 화면 위에 그릴 시트를 루트의 SheetHost에 넘김 — 웹 미리 보기에서도 휴대폰 틀 안에 뜨게
// 시트 내용은 화면 밖(루트)에서 그려져서 화면의 Context · useLocalSearchParams를 못 받음 → 필요한 값은 props로 넘김
// 자리는 하나라 한 번에 시트 하나만 뜸
let show: ((entry: Entry | null) => void) | null = null;

type Props = {
  visible: boolean;
  onClose: () => void; // 바깥을 누르거나 뒤로 가기 · 오른쪽 위 "닫기"
  title?: string;
  children: ReactNode;
};

// 아래에서 올라오는 시트 (.sheet) — 알람 계산 확인 · 관계 고르기 · 변경 기록 등
// 위에 손잡이 · 제목 · "닫기"가 붙고, 입력칸이 있어도 키보드에 가리지 않게 시트가 키보드 위로 올라감
// <Sheet visible={open} onClose={() => setOpen(false)} title="…">…</Sheet>
export function Sheet({ visible, onClose, title, children }: Props) {
  // 다른 화면으로 넘어가면 시트를 내리고, 돌아오면 다시 띄움
  const focused = useIsFocused();
  const open = visible && focused;

  // 열려 있는 동안 내용이 바뀌면 다시 넘김
  useEffect(() => {
    if (!open) return;
    show?.({ title, node: children, onClose });
  });

  useEffect(() => {
    if (!open) return;
    return () => show?.(null);
  }, [open]);

  return null;
}

// 루트 레이아웃에 하나만 둠
export function SheetHost() {
  const [entry, setEntry] = useState<Entry | null>(null);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    show = setEntry;
    return () => {
      show = null;
    };
  }, []);

  // Android 뒤로 가기 = 시트 닫기
  useEffect(() => {
    if (!entry) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      entry.onClose();
      return true;
    });
    return () => sub.remove();
  }, [entry]);

  if (!entry) return null;
  return (
    <View style={StyleSheet.absoluteFill}>
      {/* 읽기 도구에는 아래 "닫기" 버튼 하나만 보이게 바깥 누름 칸은 감춤 */}
      <Pressable style={styles.backdrop} onPress={entry.onClose} accessible={false} importantForAccessibility="no" />
      <KeyboardAvoidingView behavior={Platform.OS === 'web' ? undefined : 'padding'} style={styles.avoid}>
        <View style={[styles.sheet, { paddingBottom: 26 + insets.bottom }]} accessibilityViewIsModal>
          <View style={styles.handle} />
          <View style={styles.head}>
            <Text variant="sheetTitle" numberOfLines={2} style={styles.title}>
              {entry.title ?? ''}
            </Text>
            <Pressable onPress={entry.onClose} accessibilityRole="button" accessibilityLabel="닫기" style={styles.close}>
              <Text variant="body" tone="sub">
                닫기
              </Text>
            </Pressable>
          </View>
          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {entry.node}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.scrim },
  // 키보드가 올라오면 이 칸이 아래 여백을 받아 시트를 밀어 올림. 빈 곳 터치는 뒤 배경(닫기)으로 넘김
  avoid: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, justifyContent: 'flex-end', pointerEvents: 'box-none' },
  sheet: {
    maxHeight: '88%',
    backgroundColor: colors.card,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingTop: 10,
    paddingHorizontal: 20,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.dash, marginBottom: 6 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: size.touch },
  title: { flex: 1 },
  close: { minWidth: size.touch, minHeight: size.touch, alignItems: 'flex-end', justifyContent: 'center' },
});
