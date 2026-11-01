import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet } from 'react-native';

import { Button, Card, Field, Screen, Text, toast, TopBar } from '@/components/ui';
import { joinGroupByCode } from '@/features/social/api';
import { Note } from '@/features/social/components/Note';
import { backOrHome, openGroupDetail } from '@/lib/nav';
import { useAction } from '@/lib/useAction';

// 초대 코드 칸 최대 글자 수 — 실데이터 코드는 8자(DB 기본값), 가짜 모드 코드는 하이픈 포함 8자. 붙여 넣을 때 공백이 섞여도 받게 여유를 둠
const CODE_MAX = 16;

// 초대 코드로 그룹 참여 — G01 그룹 탭 "그룹 참여하기"에서 옴 (지형님 와이어프레임 4번 · 목업 번호 없음)
//   와이어프레임의 "참여 전 그룹 미리보기(이름 · 인원 · 공유 범위)"는 코드로 그룹을 미리 읽는 서버 함수가 없어 뺌 — 참여하면 바로 그룹 상세(G02)로
export default function JoinGroupScreen() {
  const [code, setCode] = useState('');
  const { busy, run } = useAction();
  const cleaned = code.trim();

  const join = () =>
    run(async () => {
      if (!cleaned) return;
      const id = await joinGroupByCode(cleaned);
      // 친구 수락과 같게, 들어간 뒤 내가 보여 줄 범위를 바로 정하러 갈 수 있게 (G01 accept)
      toast('그룹에 참여했어요', {
        actionLabel: '공유 범위 정하기',
        onAction: () => router.push({ pathname: '/permissions', params: { relation: `group:${id}` } }),
      });
      openGroupDetail(id, 'stack');
    }, '그룹에 참여하지 못했어요');

  return (
    <Screen footer={<Button label="참여하기" onPress={join} disabled={!cleaned} loading={busy} />}>
      <TopBar onBack={backOrHome} />
      <Text variant="title" style={styles.title}>
        그룹 참여하기
      </Text>
      <Text variant="lead" style={styles.lead}>
        친구에게 받은 초대 코드를 입력해요.
      </Text>

      <Card>
        <Field
          first
          label="초대 코드"
          value={code}
          onChangeText={(t) => setCode(t.toUpperCase())}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={CODE_MAX}
          placeholder="예: A1B2C3D4"
          returnKeyType="go"
          onSubmitEditing={join}
        />
      </Card>
      <Note>들어가면 그룹원이 허용한 만큼 알람 시간과 기상 상태가 보여요. 내가 보여 줄 범위는 들어간 뒤 공유 권한 설정에서 정해요.</Note>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
});
