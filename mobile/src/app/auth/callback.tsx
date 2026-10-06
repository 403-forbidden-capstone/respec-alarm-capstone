import { Redirect } from 'expo-router';

// 로그인 뒤 돌아오는 주소(respecalarm://auth/callback · 웹 /auth/callback)
// 토큰 처리는 lib/auth.ts(앱) · supabase-js(웹)가 하고, 이 화면은 홈으로 넘기기만 함
export default function AuthCallback() {
  return <Redirect href="/" />;
}
