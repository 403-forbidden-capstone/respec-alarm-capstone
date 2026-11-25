import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, EmptyState, LoadError, Loading, Screen, Text, toast, TopBar } from '@/components/ui';
import { getMemberWake, sendWakePing } from '@/features/social/api';
import { useNow } from '@/features/alarm/hooks/useNow';
import { useWakeLoad } from '@/features/social/hooks/useGroupWake';
import type { WakePingResult } from '@/features/social/types';
import {
  WAKE_NOT_SHARED_BODY,
  WAKE_NOT_SHARED_TITLE,
  WAKE_PING_FAILED,
  WAKE_STALE_TEXT,
  dayLinesOf,
  wakeScopeOf,
  wakePingLocks,
  wakePingNote,
  wakePingSent,
} from '@/features/social/wakeTexts';
import { formatTime } from '@/lib/format';
import { useAction } from '@/lib/useAction';
import { backOrHome } from '@/lib/nav';
import { colors } from '@/theme';
import { useAccent } from '@/lib/skyTone';

// G03 그룹원 기상 상태 (친구 7장) — 단계 글자 + 오늘의 흐름(목업 G03 시각 줄: 알람 울림 · 기상 확인 · 출발 · 도착, 아는 것만), [깨우기]는 알람이 울린 뒤 기상 확인 전에만 (D51)
//   [깨우기] (친구 8장) — 서버가 판정 · 횟수를 세고 결과를 줌. 버튼 아래 한 줄로 '1/3 · 8:15부터 다시' · '지금은 깨울 수 없어요' · '이미 일어났어요' · '지금은 알림이 닿지 않아요'.
//   읽기만 하는 상태 조회가 없어서 상태는 보내 본 뒤에 앎 — 잠긴 동안(다음 가능 시각 전 · 한도 · 꺼짐)은 버튼을 막음. 가짜 모드는 막힘(8-16)
//   알람 카드(강도 · 장소 · 준비)는 기상 공유로는 안 보이고, 알람 조회 권한이 있으면 [알람 보기](G04)로 (7-다 · 7-41)
//   미루기 횟수 · 알람 끈 시각은 본인만 — 서버가 안 줌 (7-거)
export default function MemberWakeScreen() {
  const accent = useAccent(); // 포인트 색 — 그 시각 하늘과 같은 계열 (lib/skyTone)
  const { id, userId } = useLocalSearchParams<{ id: string; userId: string }>();
  // 그룹 기상 신호 · 다시 연결 · 앱이 앞에 올 때 다시 읽음
  const { data, error, reload, stale } = useWakeLoad((date) => getMemberWake(id, userId, date), () => [id]);
  const { busy, run } = useAction();
  const [ping, setPing] = useState<WakePingResult | null>(null);
  const current = useNow(15_000);

  if (data === undefined) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} screenId="G03" />
        {error ? <LoadError onRetry={reload} /> : <Loading />}
      </Screen>
    );
  }
  if (data === null) {
    return (
      <Screen>
        <TopBar onBack={backOrHome} screenId="G03" />
        <EmptyState title={WAKE_NOT_SHARED_TITLE} body={WAKE_NOT_SHARED_BODY} />
      </Screen>
    );
  }

  const { person: p, groupName, state, canViewAlarm, noGroupAppointment } = data;
  const scope = wakeScopeOf(p.short, groupName, data.tripVisible);
  const lines = dayLinesOf(data, current); // 오늘의 흐름 — 알람 울림 · 기상 확인 · 출발 · 도착 중 아는 것만
  const nowIndex = lines.reduce((last, line, i) => (line.at.getTime() <= current.getTime() ? i : last), -1); // 지난 줄 중 마지막 = 지금(진한 점)

  // 잠금 — 한도 · 꺼짐 · 이미 일어남은 계속, 보냄(OK) · 5분 안 또 누름(WAIT)은 다음 가능 시각까지
  const timed = ping && (ping.status === 'OK' || ping.status === 'WAIT');
  const spent = ping?.status === 'OK' && ping.count >= ping.limit; // 마지막 보냄 — 시간이 지나도 오늘은 더 못 보냄
  const locked = ping != null && wakePingLocks(ping) && (spent || !(timed && ping.nextAt != null && current >= ping.nextAt));
  const sendPing = () =>
    run(async () => {
      const result = await sendWakePing(id, p.id);
      setPing(result);
      if (result.status === 'OK') toast(wakePingSent(p.short));
      if (result.status === 'ALREADY_UP' || result.status === 'NOT_RINGING') void reload(); // 판정이 바뀐 것 — 상태를 다시 읽음
    }, WAKE_PING_FAILED);
  const pingNote = ping && !(timed && !locked) ? wakePingNote(ping) : null; // 풀린 뒤에는 옛 '다시' 안내를 지움

  return (
    <Screen>
      <TopBar onBack={backOrHome} screenId="G03" />
      <Text variant="title" style={styles.title}>
        {p.short}님의 기상 상태
      </Text>
      <Text variant="lead" style={styles.lead}>
        알람을 끈 것만으로는 일어난 것으로 보지 않아요.
      </Text>
      {stale ? (
        <Text variant="small" tone="warn" style={styles.stale} accessibilityLiveRegion="polite">
          {WAKE_STALE_TEXT}
        </Text>
      ) : null}

      {noGroupAppointment ? (
        // 그 그룹의 약속이 있는 날에만 기상 상태를 줌 (D57)
        <EmptyState title="오늘은 그룹 약속이 없어요" body={`'${groupName}' 그룹의 약속이 있는 날에만 ${p.short}님의 기상 상태를 볼 수 있어요.`} />
      ) : (
        <Card>
          <View style={styles.row}>
            <Avatar initial={p.initial} dot={state.dot ?? undefined} />
            <View style={styles.grow}>
              <Text variant="big" accessibilityLiveRegion="polite">
                {state.text}
              </Text>
            </View>
          </View>
        </Card>
      )}

      {!noGroupAppointment && lines.length ? (
        <Card>
          <Text variant="label" tone="sub" style={styles.label}>
            오늘의 흐름
          </Text>
          {lines.map((line, i) => (
            <View key={line.label} style={styles.line}>
              <Text variant="small" tone="sub" style={styles.lineTime}>
                {formatTime(line.at)}
              </Text>
              <View style={[styles.lineDot, i === nowIndex && [styles.lineDotNow, { backgroundColor: accent }]]} />
              <Text variant="body" tone={i > nowIndex ? 'faint' : undefined}>
                {line.label}
              </Text>
            </View>
          ))}
        </Card>
      ) : null}

      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          공유 범위
        </Text>
        <Text variant="bodyStrong">{scope.title}</Text>
        <Text variant="small" tone="sub" style={styles.paragraph}>
          {scope.body}
        </Text>
      </Card>

      <View style={styles.stack}>
        {state.stage === 'RANG' ? <Button label="깨우기" loading={busy} disabled={locked} onPress={sendPing} /> : null}
        {pingNote ? (
          <Text variant="small" tone="sub" style={styles.pingNote} accessibilityLiveRegion="polite">
            {pingNote}
          </Text>
        ) : null}
        {canViewAlarm ? (
          <Button label="알람 보기" variant="ghost" onPress={() => router.push({ pathname: '/friends/[id]/alarms', params: { id: p.id } })} />
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  stale: { marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, minWidth: 0 },
  // 목업 G03 .tl — 시각 · 작은 점 · 글자, 줄 사이 선 없음, 지금 줄만 진한 점
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9 },
  lineTime: { width: 76 },
  lineDot: { width: 7, height: 7, borderRadius: 4, marginRight: 4, backgroundColor: colors.line },
  lineDotNow: { backgroundColor: colors.ink },
  label: { marginBottom: 8 },
  paragraph: { marginTop: 4, lineHeight: 20 },
  stack: { gap: 10, marginTop: 16 },
  pingNote: { textAlign: 'center' },
});
