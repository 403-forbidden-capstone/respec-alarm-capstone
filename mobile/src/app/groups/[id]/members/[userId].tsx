import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, EmptyState, LoadError, Loading, Screen, Text, toast, TopBar } from '@/components/ui';
import { getMemberWake, sendWakePing } from '@/features/social/api';
import { useNow } from '@/features/alarm/hooks/useNow';
import { useWakeLoad } from '@/features/social/hooks/useGroupWake';
import type { WakePingResult } from '@/features/social/types';
import { alarmLine } from '@/features/social/map';
import {
  WAKE_NOT_SHARED_BODY,
  WAKE_NOT_SHARED_TITLE,
  WAKE_PING_FAILED,
  WAKE_STALE_TEXT,
  wakePingLocks,
  wakePingNote,
  wakePingSent,
} from '@/features/social/wakeTexts';
import { useAction } from '@/lib/useAction';
import { backOrHome } from '@/lib/nav';

// G03 그룹원 기상 상태 (친구 7장) — 단계 글자 + 알람 시각 한 줄, [깨우기]는 '울렸어요'일 때만 (D51)
//   [깨우기] (친구 8장) — 서버가 판정 · 횟수를 세고 결과를 줌. 버튼 아래 한 줄로 '1/3 · 8:15부터 다시' · '지금은 깨울 수 없어요' · '이미 일어났어요' · '지금은 알림이 닿지 않아요'.
//   읽기만 하는 상태 조회가 없어서 상태는 보내 본 뒤에 앎 — 잠긴 동안(다음 가능 시각 전 · 한도 · 꺼짐)은 버튼을 막음. 가짜 모드는 막힘(8-16)
//   알람 카드(강도 · 장소 · 준비)는 기상 공유로는 안 보이고, 알람 조회 권한이 있으면 [알람 보기](G04)로 (7-다 · 7-41)
//   미루기 횟수 · 알람 끈 시각은 본인만 — 서버가 안 줌 (7-거)
export default function MemberWakeScreen() {
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

  const { person: p, groupName, state, alarmAt, canViewAlarm, noGroupAppointment } = data;
  // 아직 단계는 글자가 이미 알람 시각이라 아래 줄을 또 쓰지 않음
  const sub = state.stage === 'SCHEDULED' ? null : alarmLine(alarmAt);

  // 잠금 — 한도 · 꺼짐 · 이미 일어남은 계속, 보냄(OK) · 5분 안 또 누름(WAIT)은 다음 가능 시각까지
  const timed = ping && (ping.status === 'OK' || ping.status === 'WAIT');
  const locked = ping != null && wakePingLocks(ping) && !(timed && ping.nextAt != null && current >= ping.nextAt);
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
              {sub ? (
                <Text variant="small" tone="sub" style={styles.sub}>
                  {sub}
                </Text>
              ) : null}
            </View>
          </View>
        </Card>
      )}

      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          공유 범위
        </Text>
        <Text variant="bodyStrong">기상 여부와 알람 시각</Text>
        <Text variant="small" tone="sub" style={styles.paragraph}>
          {`${p.short}님이 '${groupName}' 그룹에 기상 공유를 켠 범위만 보여요. 수면 시간이나 알람 메모는 공유되지 않아요.`}
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
  sub: { marginTop: 2 },
  label: { marginBottom: 8 },
  paragraph: { marginTop: 4, lineHeight: 20 },
  stack: { gap: 10, marginTop: 16 },
  pingNote: { textAlign: 'center' },
});
