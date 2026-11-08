import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Button, Sheet, Text } from '@/components/ui';
import { colors, font, radius } from '@/theme';

import { REPORT_NOTE_MAX, REPORT_REASONS } from '../blockTexts';
import type { Person, ReportReason } from '../types';

type Props = {
  person: Person | null; // 메뉴를 연 사람 — null이면 닫힘
  onClose: () => void;
  onBlock: (person: Person) => void; // 확인 창 · 차단 호출은 부르는 쪽(usePersonMenu)이 함
  onReport: (person: Person, reason: ReportReason, note: string) => Promise<void>;
};

// 사람 줄 메뉴 (친구 4장) — [신고하기] [차단하기] [취소]. [신고하기]를 누르면 같은 시트에서 사유 고르기 + 한 줄 메모
//   F02 친구 상세 · F01 받은 요청 카드 · 검색 결과 · G02 멤버 줄이 같이 씀. 시트 내용은 화면 밖(루트)에서 그려져 값 · 콜백만 받음
export function PersonMenuSheet({ person, onClose, onBlock, onReport }: Props) {
  return (
    <Sheet visible={person != null} onClose={onClose} title={person ? `${person.name} ${person.handle ?? ''}`.trim() : undefined}>
      {person ? <Body key={person.id} person={person} onClose={onClose} onBlock={onBlock} onReport={onReport} /> : null}
    </Sheet>
  );
}

function Body({ person, onClose, onBlock, onReport }: { person: Person } & Pick<Props, 'onClose' | 'onBlock' | 'onReport'>) {
  const [step, setStep] = useState<'menu' | 'report'>('menu');
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  if (step === 'menu') {
    return (
      <View style={styles.stack}>
        <Button variant="ghost" label="신고하기" onPress={() => setStep('report')} />
        <Button variant="ghost" label="차단하기" onPress={() => onBlock(person)} />
        <Button variant="plain" label="취소" onPress={onClose} />
      </View>
    );
  }

  async function send() {
    if (!reason) return;
    setBusy(true);
    try {
      await onReport(person, reason, note);
    } finally {
      setBusy(false); // 성공하면 시트가 닫혀 이 화면이 사라질 수도 있음
    }
  }

  return (
    <View>
      <Text variant="bodyStrong">{`${person.name}님 신고`}</Text>
      <Text variant="small" tone="sub" style={styles.lead}>
        어떤 점이 문제인가요?
      </Text>
      <View style={styles.reasons}>
        {REPORT_REASONS.USER.map((r) => {
          const on = reason === r.value;
          return (
            <Pressable
              key={r.value}
              onPress={() => setReason(r.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              style={({ pressed }) => [styles.reason, on && styles.reasonOn, pressed && styles.pressed]}
            >
              <Text variant="body" weight={on ? 600 : 400}>
                {r.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text variant="caption" tone="sub" style={styles.noteLabel}>
        한 줄 메모 (선택)
      </Text>
      <TextInput
        value={note}
        onChangeText={setNote}
        maxLength={REPORT_NOTE_MAX}
        placeholder="상황을 한 줄로 적어 주세요"
        placeholderTextColor={colors.faint}
        accessibilityLabel="한 줄 메모"
        maxFontSizeMultiplier={1.3}
        style={[styles.input, font(400)]}
      />
      <View style={styles.stack}>
        <Button label="신고하기" onPress={send} disabled={!reason} loading={busy} />
        <Text variant="caption" align="center">
          신고한 사실은 상대에게 알리지 않아요.
        </Text>
        <Button variant="plain" label="취소" onPress={onClose} disabled={busy} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 6, marginTop: 8 },
  lead: { marginTop: 2, marginBottom: 10 },
  reasons: { gap: 8 },
  reason: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 14, borderRadius: radius.field, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  reasonOn: { borderColor: colors.ink },
  pressed: { opacity: 0.6 },
  noteLabel: { marginTop: 14, marginBottom: 6 },
  input: { minHeight: 48, paddingHorizontal: 14, borderRadius: radius.field, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, color: colors.ink },
});
