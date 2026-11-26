import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Text } from '@/components/ui';
import { draftAt } from '@/features/alarm/schedule';
import { IMPORTANCE_LABEL, KIND_LABEL, TRANSPORT_LABEL } from '@/features/alarm/types';
import { formatDateParen, formatTime } from '@/lib/format';
import { useSkyTone } from '@/lib/skyTone';
import { colors, radius, size } from '@/theme';

import type { ApptChanges, ConversationCard } from '../types';
import { Bubble, BubbleTime } from './ChatBubble';

type Props = {
  card: ConversationCard;
  at: Date; // 카드를 띄운 시각
  onSave: () => void; // [저장] · [바꾸기] · [변경하기]
  onReject: () => void;
  onEdit?: () => void; // 새 일정(H05)에서 고쳐서 저장 — 목업 카드만 (실데이터는 말로 고침)
  onPickPlace?: () => void; // [장소 고르기] — 장소 검색 시트
  onSaveWithoutPlace?: () => void; // 이전 호출부 호환용 — 카드에서는 [장소 없이 저장] 버튼을 노출하지 않음
  onManual?: () => void; // [직접 만들기] — 계산이 안 될 때 H05로
  disabled?: boolean; // 저장 · 저장 안 함이 도는 중
  working?: string | null; // 이 카드에서 도는 일의 지금 단계 ("일정을 저장하고 있어요..." · "장소를 확인하고 있어요..." …) — 있으면 버튼을 모두 막음
  saving?: boolean; // [저장]이 도는 중 — 그 버튼에 돌아가는 표시
  failure?: string | null; // 이 카드의 저장 · 계산이 실패한 까닭 — onRetry가 있으면 [다시 시도]
  onRetry?: () => void;
  onPickGroup?: (groupId: string | null) => void; // 그룹 · 개인 일정 칩 (null = 개인) — 새 일정 카드에 그룹 고르기가 붙었을 때만
};

// 그룹 칩 값 — 개인 일정은 빈 글자, 아직 안 고름(ASK)은 어느 칩에도 안 맞는 값
const PERSONAL = '';
const UNPICKED = '?';

const HEAD: Record<ConversationCard['kind'], string> = {
  APPT_NEW: '대화에서 찾은 내용',
  ALARM_EDIT: '알람 바꾸기',
  ALARM_NEW: '알람 만들기',
  APPT_OPEN: '일정 바꾸기',
};

const SAVE_LABEL: Record<ConversationCard['kind'], string> = { APPT_NEW: '저장', ALARM_EDIT: '바꾸기', ALARM_NEW: '저장', APPT_OPEN: '변경하기' };

// 약속 변경 카드의 바뀌는 칸 — [이름, 지금, 바뀔 값]. 서버가 바뀌는 칸만 줌
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
function whenText(x: ApptChanges): string {
  const m = x.date ? DAY.exec(x.date) : null;
  const day = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  return [day ? formatDateParen(day) : null, x.time ? formatTime(draftAt(day ?? new Date(), x.time)) : null].filter(Boolean).join(' ');
}
function changeRows(before: ApptChanges, after: ApptChanges): [string, string, string][] {
  const rows: [string, string, string][] = [];
  if (after.date !== undefined || after.time !== undefined) rows.push([after.date && after.time ? '날짜 · 시간' : after.date ? '날짜' : '시간', whenText(before), whenText(after)]);
  if (after.place !== undefined) rows.push(['장소', before.place || '미정', after.place || '미정']);
  if (after.importance !== undefined) rows.push(['중요도', before.importance ? IMPORTANCE_LABEL[before.importance] : '없음', after.importance ? IMPORTANCE_LABEL[after.importance] : '없음']);
  if (after.transport !== undefined) rows.push(['이동 방법', before.transport ? TRANSPORT_LABEL[before.transport] : '없음', after.transport ? TRANSPORT_LABEL[after.transport] : '없음']);
  return rows;
}

// 대화에서 찾은 카드 (.xcard) — 여러 장이 대화 줄에 하나씩 놓임. 상태에 따라 계산 중 · 장소 고르기 · 저장 · 바꾸기 · 저장 안 함, 고른 뒤에는 결과만
// 그날 첫 일정(firstOfDay)만 알람 줄을 자세히, 나머지는 "출발 알림" 한 줄 (D36)
export function FoundScheduleCard({ card, at, onSave, onReject, onEdit, onPickPlace, onManual, disabled, working, saving, failure, onRetry, onPickGroup }: Props) {
  const { status, kind } = card;
  const calculating = status === 'NEEDS_ESTIMATE' || status === 'ESTIMATING';
  const done = status === 'SAVED' || status === 'REJECTED';
  const departure = card.alarms.find((a) => a.kind === 'DEPARTURE' && a.enabled);
  const blocked = disabled || !!working;
  const retry = !!onRetry && !working;
  const group = kind === 'APPT_NEW' ? card.group : null;
  const groupName = group?.choice === 'GROUP' ? (group.candidates.find((g) => g.id === group.id)?.name ?? null) : null;
  const groupOptions = group ? ([[PERSONAL, '개인 일정'], ...group.candidates.map((g) => [g.id, `${g.name} 그룹`] as const)] as const) : [];

  return (
    <Bubble who="ai" wide>
      <Text variant="caption" tone="faint" style={styles.head}>
        {HEAD[kind]}
      </Text>
      {kind === 'APPT_NEW' ? (
        <>
          <Row label="일정" value={card.title} />
          {card.at ? <Row label="날짜 · 시간" value={`${formatDateParen(card.at)} ${formatTime(card.at)}`} /> : null}
          {card.place ? <Row label="장소" value={card.place} note={status === 'NEEDS_PLACE' ? '미확정' : undefined} /> : status === 'NEEDS_PLACE' ? <Row label="장소" value="미확정" /> : null}
          {card.importance && card.importance !== 'LOW' ? <Row label="중요도" value={IMPORTANCE_LABEL[card.importance]} /> : null}
          {card.items.length ? <Row label="준비물" value={card.items.join(', ')} note="같이 저장" /> : null}
          {done && groupName ? <Row label="그룹" value={groupName} note="내 알람만" /> : null}
          {status === 'READY' || status === 'SAVED' ? (
            card.firstOfDay && card.alarms.length ? (
              card.alarms.filter((a) => a.enabled).map((a) => <Row key={a.kind} label={`${KIND_LABEL[a.kind]} 알람`} value={formatTime(a.at)} />)
            ) : card.alarms.length ? (
              <Row label="알람" value={departure ? `출발 알림 ${formatTime(departure.at)}` : '출발 알림'} />
            ) : null
          ) : null}
        </>
      ) : kind === 'APPT_OPEN' && card.change ? (
        <>
          <Row label="일정" value={card.change.before.title ?? ''} />
          {changeRows(card.change.before, card.change.after).map(([label, from, to]) => (
            <Row key={label} label={label} value={`${from} → ${to}`} note={label === '장소' && status === 'NEEDS_PLACE' ? '미확정' : undefined} />
          ))}
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
      {group && !done && onPickGroup ? (
        <View style={styles.group}>
          <Text variant="small" tone="sub" style={styles.groupNote}>
            {group.missing && group.choice === 'ASK'
              ? `${group.missing} 그룹을 찾을 수 없어요. 그룹을 만들거나 개인 일정으로 등록해 주세요`
              : group.choice === 'ASK'
                ? '그룹 일정인지 개인 일정인지 골라 주세요'
                : '알람은 내 것만 맞춰요'}
          </Text>
          <GroupPicker
            options={groupOptions}
            value={group.choice === 'GROUP' ? (group.id ?? UNPICKED) : group.choice === 'PERSONAL' ? PERSONAL : UNPICKED}
            onChange={(v) => onPickGroup(v === PERSONAL ? null : v)}
            disabled={blocked}
          />
        </View>
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
          저장하려면 아래 [{SAVE_LABEL[kind]}]을 눌러 주세요
        </Text>
      ) : null}

      {done ? (
        <Text variant="small" tone="sub" style={styles.result}>
          {status === 'SAVED' ? (kind === 'ALARM_EDIT' ? '바꿨어요' : kind === 'APPT_NEW' ? '일정이 저장됐어요' : kind === 'APPT_OPEN' ? '일정을 바꿨어요' : '저장했어요') : kind === 'APPT_OPEN' ? '바꾸지 않았어요' : '저장하지 않았어요'}
        </Text>
      ) : (
        <View style={styles.buttons}>
          {/* 저장이 실패했으면 [저장] 자리에 [다시 시도] (같은 저장을 다시 — 중복 저장은 saveCard가 막음) */}
          {status === 'READY' ? (
            <Button label={retry ? '다시 시도' : SAVE_LABEL[kind]} small onPress={retry ? onRetry : onSave} disabled={blocked && !saving} loading={saving} />
          ) : null}
          {status === 'FAILED' && retry ? <Button label="다시 시도" small onPress={onRetry} disabled={blocked} /> : null}
          {status === 'NEEDS_PLACE' && onPickPlace ? <Button label="장소 고르기" small onPress={onPickPlace} disabled={blocked} /> : null}
          {status === 'FAILED' && onManual ? <Button label="직접 만들기" small variant="ghost" onPress={onManual} disabled={blocked} /> : null}
          {status === 'READY' && kind === 'APPT_NEW' && onEdit ? <Button label="수정" small variant="ghost" onPress={onEdit} disabled={blocked} /> : null}
          {!calculating ? <Button label={kind === 'APPT_OPEN' ? '변경 안 함' : '저장 안 함'} small variant="plain" onPress={onReject} disabled={blocked} /> : null}
        </View>
      )}
      <BubbleTime who="ai" at={at} />
    </Bubble>
  );
}

// 그룹 · 개인 일정 칩 — 공용 Segmented보다 낮고, 고른 칩은 그 시각 하늘의 포인트 색 (lib/skyTone). 이름이 길면 줄을 바꿔 카드 안에 둠
const PICK_SLOP = { top: (size.touch - size.chip - 6) / 2, bottom: (size.touch - size.chip - 6) / 2 } as const;
function GroupPicker({ options, value, onChange, disabled }: { options: readonly (readonly [string, string])[]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const { base, accent } = useSkyTone();
  return (
    <View style={[styles.pick, { backgroundColor: base }]} accessibilityRole="tablist">
      {options.map(([v, label]) => {
        const on = v === value;
        return (
          <Pressable
            key={v}
            onPress={() => onChange(v)}
            disabled={disabled}
            hitSlop={PICK_SLOP}
            accessibilityRole="tab"
            accessibilityState={{ selected: on, disabled }}
            style={[styles.pickItem, on && { backgroundColor: accent }, disabled && styles.pickOff]}
          >
            <Text variant="note" tone={on ? 'inverse' : 'sub'} weight={on ? 600 : 400} align="center">
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
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
  group: { marginTop: 8 },
  groupNote: { marginBottom: 6 },
  pick: { flexDirection: 'row', flexWrap: 'wrap', gap: 3, padding: 3, borderRadius: radius.chip },
  pickItem: {
    flexGrow: 1,
    flexShrink: 1,
    maxWidth: '100%',
    minHeight: size.chip + 6,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: radius.chip - 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickOff: { opacity: 0.35 }, // Button의 disabled와 같은 흐림
});
