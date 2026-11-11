import { StyleSheet, View } from 'react-native';

import { Button, Card, Text } from '@/components/ui';
import { keepWords } from '@/lib/format';

import { noticeActions, noticeCopy, primaryAction, type NoticeAction, type NoticeKind } from '../chatNotice';

type Props = {
  kind: NoticeKind; // failed = AI가 지금 답하지 못함 · extract = 일정 정리 못 함 · busy = 분당 사용량 · limit = 하루 사용량 · turn = 대화 길이 (chatNotice.ts)
  onRetry?: () => void; // 다시 시도 (failed · extract · busy만)
  onManual?: () => void; // 직접 일정 만들기
  onDone?: () => void; // 대화 마치기
  busy?: boolean; // 1차 버튼 처리 중 — 1차 버튼이 돌아가고 나머지는 눌리지 않음
};

const LABEL: Record<NoticeAction, string> = { retry: '다시 시도', manual: '직접 일정 만들기', done: '대화 마치기' };

// AI 대화 안내 — 마지막 말풍선 아래, AI 쪽(왼쪽)에 놓음. 점선 카드라 AI의 말이 아니라 앱의 안내로 보임
// 진한 버튼은 1차 행동 하나, 나머지는 글자 버튼. 입력창을 막는 일은 부르는 쪽이 함
export function ChatNotice({ kind, onRetry, onManual, onDone, busy }: Props) {
  const { title, body } = noticeCopy(kind);
  const handlers: Record<NoticeAction, (() => void) | undefined> = { retry: onRetry, manual: onManual, done: onDone };
  const actions = noticeActions(kind, { hasRetry: !!onRetry, hasManual: !!onManual, hasDone: !!onDone });
  const primary = primaryAction(kind);

  return (
    <View style={styles.wrap} accessibilityLiveRegion="polite">
      <Card variant="dash" style={styles.card}>
        <Text variant="bodyStrong">{keepWords(title)}</Text>
        <Text variant="body" tone="sub" style={styles.body}>
          {keepWords(body)}
        </Text>
        {actions.length ? (
          <View style={styles.actions}>
            {actions.map((key) =>
              key === primary ? (
                <Button key={key} label={LABEL[key]} onPress={handlers[key]} loading={busy} />
              ) : (
                <Button key={key} label={LABEL[key]} variant="plain" onPress={handlers[key]} disabled={busy} />
              ),
            )}
          </View>
        ) : null}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'flex-start', width: '92%' },
  card: { marginBottom: 0 }, // 간격은 대화 목록(gap)이 맡음
  body: { marginTop: 6 },
  actions: { marginTop: 14, gap: 4 },
});
