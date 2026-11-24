import { StyleSheet, View } from 'react-native';

import { Avatar, Button, Loading, Sheet, Text } from '@/components/ui';
import { formatDateShort, formatTime } from '@/lib/format';

import { CREATOR_UNKNOWN, joinedCountText, PAST_APPOINTMENT } from '../groupTexts';
import type { AppointmentJoiner, GroupAppointment } from '../types';

type Props = {
  appointment: GroupAppointment | null; // 열린 약속 — null이면 닫힘
  joiners: AppointmentJoiner[] | null; // 읽는 중이면 null
  onClose: () => void;
  onJoin: (a: GroupAppointment) => void;
  onLeave: (a: GroupAppointment) => void;
};

const STATE_TEXT: Record<AppointmentJoiner['state'], string> = { JOINED: '참여', NO_ALARM: '알람 없음', HIDDEN: '' }; // 차단 쌍은 이름만 (9-33)

// G02 연결 일정을 열었을 때 — 참여자 줄(참여 / 알람 없음 두 가지, 9-42) + 내 버튼([내 알람 만들기] 또는 [나는 빠지기]). 지난 약속은 버튼 없이 '지난 약속이에요'
//   만든 사람은 빠지지 않고 지움(H03) — 이 시트에서는 [나는 빠지기]를 안 보임
export function AppointmentJoinersSheet({ appointment: a, joiners, onClose, onJoin, onLeave }: Props) {
  return (
    <Sheet visible={a != null} onClose={onClose} title={a?.title}>
      {a ? (
        <View>
          <Text variant="small" tone="sub">
            {[`${formatDateShort(a.at)} ${formatTime(a.at)}`, a.place, joinedCountText(a.joinedCount), a.creatorUnknown ? CREATOR_UNKNOWN : null].filter(Boolean).join(' · ')}
          </Text>
          <View style={styles.list}>
            {joiners == null ? (
              <Loading />
            ) : (
              joiners.map((j) => (
                <View key={j.person.id} style={styles.row}>
                  <Avatar initial={j.person.initial} small dot={j.state === 'JOINED' ? 'ok' : undefined} />
                  <Text variant="body" style={styles.name}>
                    {j.isMe ? `${j.person.name} (나)` : j.person.name}
                  </Text>
                  <Text variant="small" tone={j.state === 'JOINED' ? undefined : 'sub'}>
                    {STATE_TEXT[j.state]}
                  </Text>
                </View>
              ))
            )}
          </View>
          {a.past ? (
            <Text variant="small" tone="sub" style={styles.past}>
              {PAST_APPOINTMENT}
            </Text>
          ) : a.iJoined ? (
            <Button variant="ghost" label="나는 빠지기" onPress={() => onLeave(a)} />
          ) : (
            <Button label="내 알람 만들기" onPress={() => onJoin(a)} />
          )}
        </View>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: 12, marginBottom: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  name: { flex: 1, minWidth: 0 },
  past: { marginBottom: 6 },
});
