import { useEffect, useState } from 'react';
import { BackHandler, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Text } from '@/components/ui';
import { colors, space } from '@/theme';

export type NotifyPromptOptions = {
  title: string;
  message: string;
  okLabel: string; // 예: "알림 켜기"
  cancelLabel: string; // 예: "나중에"
};

type Entry = { opts: NotifyPromptOptions; resolve: (ok: boolean) => void };

let show: ((entry: Entry | null) => void) | null = null;
let current: Entry | null = null; // 떠 있는 것 하나 — 새로 물으면 앞의 것은 "나중에"로 끝냄

// 알림 안내 시트 — 켜기면 true, 나중에 · 바깥 누름 · 뒤로 가기면 false. 호스트가 안 붙어 있으면 false
// Sheet 부품은 화면 안에서만 쓸 수 있어(useIsFocused) 화면 밖에서 부르는 이 안내는 루트에 따로 둔 호스트로 그림 — ConfirmHost와 같은 방식
export function showNotifyPrompt(opts: NotifyPromptOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (!show) {
      resolve(false);
      return;
    }
    current?.resolve(false);
    const entry: Entry = {
      opts,
      resolve: (ok) => {
        if (current === entry) {
          current = null;
          show?.(null);
        }
        resolve(ok);
      },
    };
    current = entry;
    show(entry);
  });
}

// 루트 레이아웃에 하나만 둠 (SheetHost 뒤, ConfirmHost 앞) — 값 · 콜백만 다루고 api.ts는 안 부름
export function PermissionPromptHost() {
  const [entry, setEntry] = useState<Entry | null>(null);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    show = setEntry;
    return () => {
      current?.resolve(false);
      show = null;
    };
  }, []);

  // Android 뒤로 가기 · 웹 Esc = 나중에
  useEffect(() => {
    if (!entry) return;
    if (Platform.OS === 'web') {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') entry.resolve(false);
      };
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      entry.resolve(false);
      return true;
    });
    return () => sub.remove();
  }, [entry]);

  if (!entry) return null;
  const { title, message, okLabel, cancelLabel } = entry.opts;
  return (
    <View style={StyleSheet.absoluteFill}>
      {/* 읽기 도구에는 아래 "나중에" 버튼 하나만 보이게 바깥 누름 칸은 감춤 */}
      <Pressable style={styles.backdrop} onPress={() => entry.resolve(false)} accessible={false} importantForAccessibility="no" />
      <View style={[styles.sheet, { paddingBottom: 26 + insets.bottom }]} accessibilityViewIsModal>
        <View style={styles.handle} />
        <Text variant="sheetTitle">{title}</Text>
        <Text variant="note" tone="sub" style={styles.message}>
          {message}
        </Text>
        <View style={styles.buttons}>
          <Button label={okLabel} onPress={() => entry.resolve(true)} />
          <Button variant="ghost" label={cancelLabel} onPress={() => entry.resolve(false)} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.scrim },
  sheet: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.card,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingTop: 10,
    paddingHorizontal: 20,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.dash, marginBottom: 12 },
  message: { marginTop: 8 },
  buttons: { gap: space.gap, marginTop: 20 },
});
