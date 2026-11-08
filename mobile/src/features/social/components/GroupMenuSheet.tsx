import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { Button, Sheet, Text } from '@/components/ui';
import { colors, font, radius } from '@/theme';

import { GROUP_NAME_MAX } from '../groupTexts';
import type { Person } from '../types';

export type GroupMenuTarget = {
  id: string;
  name: string;
  notificationsOff: boolean;
  others: Person[]; // 나를 뺀 참여 중 멤버 — 내보내기 대상
};

type Props = {
  group: GroupMenuTarget | null; // 메뉴를 연 그룹 — null이면 닫힘
  onClose: () => void;
  onRename: (name: string) => Promise<void>;
  onCode: () => void; // [새 코드] → 코드 시트
  onRemove: (person: Person) => void; // 확인 창 · 호출은 부르는 쪽(useGroupMenu)이 함
  onLeave: () => void;
  onNotifications: (off: boolean) => void;
};

// G02 그룹 메뉴 (친구 5장) — 이름 바꾸기 · 새 코드 · 내보내기 · 알림 끄기 · 나가기. 그룹장이 없어 누구나 같은 메뉴, [그룹 삭제] 없음 (5-46)
//   시트 내용은 화면 밖(루트)에서 그려져 값 · 콜백만 받음
export function GroupMenuSheet({ group, onClose, ...rest }: Props) {
  return (
    <Sheet visible={group != null} onClose={onClose} title={group?.name}>
      {group ? <Body key={group.id} group={group} onClose={onClose} {...rest} /> : null}
    </Sheet>
  );
}

function Body({ group, onClose, onRename, onCode, onRemove, onLeave, onNotifications }: { group: GroupMenuTarget } & Omit<Props, 'group'>) {
  const [step, setStep] = useState<'menu' | 'rename' | 'remove'>('menu');
  const [name, setName] = useState(group.name);
  const [busy, setBusy] = useState(false);

  if (step === 'rename') {
    const save = async () => {
      setBusy(true);
      try {
        await onRename(name);
      } finally {
        setBusy(false); // 성공하면 시트가 닫혀 이 화면이 사라질 수도 있음
      }
    };
    return (
      <View style={styles.stack}>
        <TextInput
          value={name}
          onChangeText={setName}
          maxLength={GROUP_NAME_MAX}
          autoFocus
          placeholder="그룹 이름"
          placeholderTextColor={colors.faint}
          accessibilityLabel="그룹 이름"
          maxFontSizeMultiplier={1.3}
          returnKeyType="done"
          onSubmitEditing={save}
          style={[styles.input, font(400)]}
        />
        <Button label="저장" onPress={save} disabled={!name.trim()} loading={busy} />
        <Button variant="plain" label="뒤로" onPress={() => setStep('menu')} disabled={busy} />
      </View>
    );
  }

  if (step === 'remove') {
    return (
      <View style={styles.stack}>
        <Text variant="small" tone="sub">
          내보낼 사람을 골라 주세요. 그룹 코드가 새로 바뀌고, 상대에게는 알리지 않아요.
        </Text>
        {group.others.map((p) => (
          <Button key={p.id} variant="ghost" label={p.name} onPress={() => onRemove(p)} />
        ))}
        <Button variant="plain" label="뒤로" onPress={() => setStep('menu')} />
      </View>
    );
  }

  return (
    <View style={styles.stack}>
      <Button variant="ghost" label="이름 바꾸기" onPress={() => setStep('rename')} />
      <Button variant="ghost" label="새 코드" onPress={onCode} />
      {group.others.length ? <Button variant="ghost" label="내보내기" onPress={() => setStep('remove')} /> : null}
      <Button variant="ghost" label={group.notificationsOff ? '이 그룹 알림 켜기' : '이 그룹 알림 끄기'} onPress={() => onNotifications(!group.notificationsOff)} />
      <Button variant="ghost" label="나가기" onPress={onLeave} />
      <Button variant="plain" label="닫기" onPress={onClose} />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 8, marginTop: 4 },
  input: { minHeight: 48, paddingHorizontal: 14, borderRadius: radius.field, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, color: colors.ink },
});
