import { StyleSheet, View } from 'react-native';

import { Button, Text } from '@/components/ui';
import { IMPORTANCE_LABEL, KIND_LABEL } from '@/features/alarm/types';
import { formatDateParen, formatTime } from '@/lib/format';
import { colors } from '@/theme';

import type { ConversationCard } from '../types';
import { Bubble, BubbleTime } from './ChatBubble';

type Props = {
  card: ConversationCard;
  at: Date; // 카드를 띄운 시각
  onSave: () => void; // [저장] · [바꾸기]
  onReject: () => void;
  onEdit?: () => void; // 새 일정(H05)에서 고쳐서 저장 — 목업 카드만 (실데이터는 말로 고침)
  onPickPlace?: () => void; // [장소 고르기] — 장소 검색 시트
  onSaveWithoutPlace?: () => void; // [장소 없이 저장] — 장소를 확인 못 한 새 일정을 알람 없이 저장 (장소 · 이동시간을 추측하지 않음)
  onOpen?: () => void; // [일정 열기] (APPT_OPEN)
  onManual?: () => void; // [직접 만들기] — 계산이 안 될 때 H05로
  disabled?: boolean; // 저장 · 저장 안 함이 도는 중
  working?: string | null; // 이 카드에서 도는 일의 지금 단계 ("일정을 저장하고 있어요..." · "장소를 확인하고 있어요..." …) — 있으면 버튼을 모두 막음
  saving?: boolean; // [저장]이 도는 중 — 그 버튼에 돌아가는 표시
  failure?: string | null; // 이 카드의 저장 · 계산이 실패한 까닭 — onRetry가 있으면 [다시 시도]
  onRetry?: () => void;
};

const HEAD: Record<ConversationCard['kind'], string> = {
  APPT_NEW: '대화에서 찾은 내용',
  ALARM_EDIT: '알람 바꾸기',
  ALARM_NEW: '알람 만들기',
  APPT_OPEN: '일정 바꾸기',
};

// 대화에서 찾은 카드 (.xcard) — 여러 장이 대화 줄에 하나씩 놓임. 상태에 따라 계산 중 · 장소 고르기 · 저장 · 바꾸기 · 저장 안 함, 고른 뒤에는 결과만
// 그날 첫 일정(firstOfDay)만 알람 줄을 자세히, 나머지는 "출발 알림" 한 줄 (D36)
export function FoundScheduleCard({ card, at, onSave, onReject, onEdit, onPickPlace, onSaveWithoutPlace, onOpen, onManual, disabled, working, saving, failure, onRetry }: Props) {
  const { status, kind } = card;
  const calculating = status === 'NEEDS_ESTIMATE' || status === 'ESTIMATING';
  const done = status === 'SAVED' || status === 'REJECTED';
  const departure = card.alarms.find((a) => a.kind === 'DEPARTURE' && a.enabled);
  const blocked = disabled || !!working;
  const retry = !!onRetry && !working;

  return (
    <Bubble who="ai" wide>
      <Text variant="caption" tone="faint" style={styles.head}>
        {HEAD[kind]}
      </Text>
      {kind === 'APPT_NEW' ? (
        <>
          <Row label="일정" value={card.title} />
          {card.at ? <Row label="날짜 · 시간" value={`${formatDateParen(card.at)} ${formatTime(card.at)}`} /> : null}
          {card.place ? <Row label="장소" value={card.place} /> : null}
          {card.importance && card.importance !== 'LOW' ? <Row label="중요도" value={IMPORTANCE_LABEL[card.importance]} /> : null}
          {card.items.length ? <Row label="준비물" value={card.items.join(', ')} note="같이 저장" /> : null}
          {status === 'READY' || status === 'SAVED' ? (
            card.firstOfDay && card.alarms.length ? (
              card.alarms.filter((a) => a.enabled).map((a) => <Row key={a.kind} label={`${KIND_LABEL[a.kind]} 알람`} value={formatTime(a.at)} />)
            ) : card.alarms.length ? (
              <Row label="알람" value={departure ? `출발 알림 ${formatTime(departure.at)}` : '출발 알림'} />
            ) : null
          ) : null}
        </>
      ) : (
        <>
          <Text variant="note" weight={600} style={styles.summary}>
            {card.summary}
          </Text>
          {card.alarms.length && status === 'READY' ? card.alarms.map((a) => <Row key={a.kind} label={`${KIND_LABEL[a.kind]} 알람`} value={a.enabled ? formatTime(a.at) : '꺼짐'} />) : null}
        </>
      )}

      {card.question ? (
        <Text variant="bodyStrong" style={styles.question}>
          “{card.question}”
        </Text>
      ) : null}
      {working || calculating ? (
        <Text variant="small" tone="sub" style={styles.note} accessibilityLiveRegion="polite">
          {working ?? '기상·준비·출발 시간을 계산하고 있어요...'}
        </Text>
      ) : failure ? (
        <Text variant="small" tone="sub" style={styles.note} accessibilityLiveRegion="polite">
          {failure}
        </Text>
      ) : status === 'NEEDS_PLACE' || status === 'FAILED' ? (
        <Text variant="small" tone="sub" style={styles.note} accessibilityLiveRegion="polite">
          {card.error ?? (status === 'NEEDS_PLACE' ? '장소를 골라 주세요' : '알람을 계산하지 못했어요')}
        </Text>
      ) : null}
      {card.highlight && status === 'READY' ? (
        <Text variant="small" tone="sub" style={styles.note}>
          저장하려면 아래 [{kind === 'ALARM_EDIT' ? '바꾸기' : '저장'}]을 눌러 주세요
        </Text>
      ) : null}

      {done ? (
        <Text variant="small" tone="sub" style={styles.result}>
          {status === 'SAVED' ? (kind === 'ALARM_EDIT' ? '바꿨어요' : kind === 'APPT_NEW' ? '일정이 저장됐어요' : '저장했어요') : '저장하지 않았어요'}
        </Text>
      ) : (
        <View style={styles.buttons}>
          {/* 저장이 실패했으면 [저장] 자리에 [다시 시도] (같은 저장을 다시 — 중복 저장은 saveCard가 막음) */}
          {status === 'READY' && kind !== 'APPT_OPEN' ? (
            <Button label={retry ? '다시 시도' : kind === 'ALARM_EDIT' ? '바꾸기' : '저장'} small onPress={retry ? onRetry : onSave} disabled={blocked && !saving} loading={saving} />
          ) : null}
          {status === 'FAILED' && retry ? <Button label="다시 시도" small onPress={onRetry} disabled={blocked} /> : null}
          {status === 'READY' && kind === 'APPT_OPEN' && onOpen ? <Button label="일정 열기" small onPress={onOpen} disabled={blocked} /> : null}
          {status === 'NEEDS_PLACE' && onPickPlace ? <Button label="장소 고르기" small onPress={onPickPlace} disabled={blocked} /> : null}
          {status === 'NEEDS_PLACE' && kind === 'APPT_NEW' && onSaveWithoutPlace ? (
            <Button label="장소 없이 저장" small variant="ghost" onPress={onSaveWithoutPlace} disabled={blocked && !saving} loading={saving} />
          ) : null}
          {status === 'FAILED' && onManual ? <Button label="직접 만들기" small variant="ghost" onPress={onManual} disabled={blocked} /> : null}
          {status === 'READY' && kind === 'APPT_NEW' && onEdit ? <Button label="수정" small variant="ghost" onPress={onEdit} disabled={blocked} /> : null}
          {!calculating ? <Button label={kind === 'APPT_OPEN' ? '닫기' : '저장 안 함'} small variant="plain" onPress={onReject} disabled={blocked} /> : null}
        </View>
      )}
      <BubbleTime who="ai" at={at} />
    </Bubble>
  );
}

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <View style={styles.row}>
      <Text variant="note" tone="sub">
        {label}
      </Text>
      <Text variant="note" weight={600} align="right" style={styles.value}>
        {value}
        {note ? (
          <Text variant="caption" tone="sub">
            {' '}
            {note}
          </Text>
        ) : null}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { marginBottom: 6 },
  summary: { marginBottom: 6 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  value: { flexShrink: 1 },
  question: { marginVertical: 10 },
  note: { marginTop: 8 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  result: { marginTop: 6 },
});
