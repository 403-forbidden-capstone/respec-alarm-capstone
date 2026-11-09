import { StyleSheet, View } from 'react-native';

import { Card, Screen, Text } from '@/components/ui';
import { DELETION_MAIL, DELETION_PAGE } from '@/features/account/texts';

// 웹 계정 삭제 요청 안내 (Play 스토어 의무, 친구 12-사) — 로그인 없이 보는 안내 페이지, 폼 없음
//   팀 메일 주소와 보낼 내용(가입 이메일 · 아이디), '30일 안 처리' 안내. 가입 이메일에서 온 메일만 손으로 지움. 주소: /account-deletion
//   메일 주소는 정해지면 features/account/texts DELETION_MAIL에 적음 (그때까지 '준비하고 있어요')
export default function AccountDeletionScreen() {
  return (
    <Screen>
      <Text variant="label" tone="sub">
        {DELETION_PAGE.app}
      </Text>
      <Text variant="title" style={styles.title}>
        {DELETION_PAGE.title}
      </Text>
      <Text variant="lead" style={styles.lead}>
        {DELETION_PAGE.lead}
      </Text>

      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          {DELETION_PAGE.mailLabel}
        </Text>
        <Text variant="bodyStrong" selectable>
          {DELETION_MAIL ?? DELETION_PAGE.mailMissing}
        </Text>
      </Card>

      <Card>
        <Text variant="label" tone="sub" style={styles.label}>
          {DELETION_PAGE.sendTitle}
        </Text>
        <View style={styles.items}>
          {DELETION_PAGE.sendItems.map((item) => (
            <Text key={item} variant="body">
              {`· ${item}`}
            </Text>
          ))}
        </View>
      </Card>

      <Text variant="small" tone="sub" style={styles.note}>
        {DELETION_PAGE.timing}
      </Text>
      <Text variant="small" tone="sub" style={styles.note}>
        {DELETION_PAGE.scope}
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 24, marginBottom: 4 },
  lead: { marginBottom: 18 },
  label: { marginBottom: 6 },
  items: { gap: 4 },
  note: { marginTop: 10, lineHeight: 20 },
});
