import { useEffect, useState } from 'react';
import { BackHandler, Platform, Pressable, StyleSheet, View } from 'react-native';

import { colors, radius } from '@/theme';

import { Button } from './Button';
import { Text } from './Text';

export type ConfirmOptions = {
  title: string;
  message?: string;
  okLabel?: string; // 기본 "확인"
  cancelLabel?: string; // 기본 "취소"
  destructive?: boolean; // 삭제 · 나가기처럼 되돌릴 수 없는 행동이면 확인 버튼을 붉게
};

type Entry = { opts: ConfirmOptions; resolve: (ok: boolean) => void };

let show: ((entry: Entry | null) => void) | null = null;
let current: Entry | null = null; // 떠 있는 것 하나 — 새로 물으면 앞의 것은 취소로 끝냄

// 가운데 뜨는 확인 창 — 확인이면 true, 취소 · 바깥 누름 · 뒤로 가기면 false
// if (await confirm({ title: '일정을 삭제할까요?', okLabel: '삭제', destructive: true })) remove();
export function confirm(opts: ConfirmOptions): Promise<boolean> {
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

// 루트 레이아웃에 하나만 둠 (SheetHost 뒤에 — 시트 위에도 떠야 함)
export function ConfirmHost() {
  const [entry, setEntry] = useState<Entry | null>(null);

  useEffect(() => {
    show = setEntry;
    return () => {
      current?.resolve(false);
      show = null;
    };
  }, []);

  // Android 뒤로 가기 · 웹 Esc = 취소
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
  const { title, message, okLabel = '확인', cancelLabel = '취소', destructive } = entry.opts;
  return (
    <View style={styles.wrap}>
      <Pressable style={styles.backdrop} onPress={() => entry.resolve(false)} accessibilityRole="button" accessibilityLabel={cancelLabel} />
      <View style={styles.dialog} role="alertdialog" accessibilityViewIsModal>
        <Text variant="sheetTitle">{title}</Text>
        {message ? (
          <Text variant="note" tone="sub" style={styles.message}>
            {message}
          </Text>
        ) : null}
        <View style={styles.buttons}>
          <View style={styles.button}>
            <Button variant="ghost" label={cancelLabel} onPress={() => entry.resolve(false)} />
          </View>
          <View style={styles.button}>
            <Button variant={destructive ? 'danger' : 'primary'} label={okLabel} onPress={() => entry.resolve(true)} />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.scrim },
  dialog: { width: '100%', maxWidth: 340, backgroundColor: colors.card, borderRadius: radius.card, padding: 22 },
  message: { marginTop: 8 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 20 },
  button: { flex: 1 },
});
