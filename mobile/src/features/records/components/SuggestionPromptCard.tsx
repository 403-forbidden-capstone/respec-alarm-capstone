import { StyleSheet, View } from "react-native";

import { Button, Card, Text } from "@/components/ui";
import { TextLink } from "@/features/alarm/components/TextLink";

import { promptLine } from "../suggestion";
import type { Suggestion } from "../types";

// 저녁 대화(A02) 속 알람 조정 제안 카드 (안건 D111 5번) — 대화 첫 마디 바로 아래. [적용하기] · [괜찮아요] · 자세히(S01)
//   대화(AI) 쪽 카드(FoundScheduleCard)와 따로: 화면이 records api로 읽고 처리 — 서버 대화 상태(turn-core) · 카드 종류는 안 건드림
//   applied = 적용한 뒤 한 줄 — 카드는 그 자리에 "적용했어요"로 남고, 되돌리기는 자세히(S01)에서
export function SuggestionPromptCard({
  suggestion,
  applied,
  busy,
  onApply,
  onIgnore,
  onOpen,
}: {
  suggestion: Suggestion;
  applied: string | null;
  busy: boolean;
  onApply: () => void;
  onIgnore: () => void;
  onOpen: () => void;
}) {
  return (
    <Card>
      <Text variant="caption" tone="sub">
        알람 조정 제안
      </Text>
      <Text variant="bodyLarge" weight={600} style={styles.title}>
        {applied ? "적용했어요" : suggestion.title}
      </Text>
      <Text variant="small" tone="sub">
        {applied ?? suggestion.summary}
      </Text>
      {applied ? null : (
        <>
          <Text variant="small" style={styles.line}>
            {promptLine(suggestion)}
          </Text>
          <View style={styles.actions}>
            <Button label="적용하기" onPress={onApply} disabled={busy} />
            <Button
              label="괜찮아요"
              variant="ghost"
              onPress={onIgnore}
              disabled={busy}
            />
          </View>
        </>
      )}
      <View style={styles.more}>
        <TextLink
          label={applied ? "자세히 · 되돌리기 ›" : "자세히 보기 ›"}
          onPress={onOpen}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 4 },
  line: { marginTop: 8 },
  actions: { marginTop: 12, gap: 8 },
  more: { marginTop: 10, alignItems: "flex-start" },
});
