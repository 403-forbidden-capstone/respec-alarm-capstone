import { useIsFocused } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '@/theme';

import { Text } from './Text';

type Entry = { node: ReactNode; onClose: () => void };

// 화면 위에 그릴 시트를 루트의 SheetHost에 넘김 — 웹 미리 보기에서도 휴대폰 틀 안에 뜨게
// 시트 내용은 화면 밖(루트)에서 그려져서 화면의 Context · useLocalSearchParams를 못 받음 → 필요한 값은 props로 넘김
// 자리는 하나라 한 번에 시트 하나만 뜸
let show: ((entry: Entry | null) => void) | null = null;

type Props = {
  visible: boolean;
  onClose: () => void; // 바깥을 누르거나 뒤로 가기
  title?: string;
  children: ReactNode;
};

// 아래에서 올라오는 시트 (.sheet) — 알람 계산 확인 · 관계 고르기 · 변경 기록 등
// <Sheet visible={open} onClose={() => setOpen(false)} title="…">…</Sheet>
export function Sheet({ visible, onClose, title, children }: Props) {
  // 다른 화면으로 넘어가면 시트를 내리고, 돌아오면 다시 띄움
  const focused = useIsFocused();
  const open = visible && focused;

  // 열려 있는 동안 내용이 바뀌면 다시 넘김
  useEffect(() => {
    if (!open) return;
    show?.({
      node: (
        <>
          {title ? (
            <Text variant="sheetTitle" style={styles.title}>
              {title}
            </Text>
          ) : null}
          {children}
        </>
      ),
      onClose,
    });
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
      <Pressable style={styles.backdrop} onPress={entry.onClose} accessibilityRole="button" accessibilityLabel="닫기" />
      <View style={[styles.sheet, { paddingBottom: 26 + insets.bottom }]} accessibilityViewIsModal>
        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {entry.node}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.scrim },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '88%',
    backgroundColor: colors.card,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingTop: 22,
    paddingHorizontal: 20,
  },
  title: { marginBottom: 6 },
});
