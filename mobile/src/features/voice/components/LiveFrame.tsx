import { useEffect, useRef } from 'react';
import { Platform, StyleSheet } from 'react-native';

// 실시간 음성 대화(Gemini Live)의 소리만 다루는 페이지 — 화면에는 안 보임. 웹은 iframe, 앱은 WebView (웹 번들이 WebView 패키지를 읽지 않게 그릴 때 불러옴)
//   페이지 글은 live.ts의 livePage, 페이지가 보내는 메시지는 parseLiveMessage로 읽음 (hooks/useLiveVoice)
export function LiveFrame({ html, onMessage }: { html: string; onMessage: (raw: unknown) => void }) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const handler = useRef(onMessage);
  useEffect(() => {
    handler.current = onMessage;
  });

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const listener = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow) handler.current(event.data);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);

  if (Platform.OS === 'web') {
    return <iframe ref={frame} srcDoc={html} title="음성 대화" allow="microphone; autoplay" style={{ display: 'none' }} />;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 안드로이드일 때만 읽음 (웹 번들에서 로드되지 않게)
  const { WebView } = require('react-native-webview') as typeof import('react-native-webview');
  return (
    <WebView
      source={{ html, baseUrl: 'https://localhost/' }} // 마이크(getUserMedia)는 https 페이지에서만 열림
      originWhitelist={['*']}
      onMessage={(event) => handler.current(event.nativeEvent.data)}
      mediaCapturePermissionGrantType="grant" // 앱이 이미 마이크 권한을 받았으므로 페이지에 바로 허용
      mediaPlaybackRequiresUserAction={false}
      javaScriptEnabled
      style={styles.hidden}
    />
  );
}

const styles = StyleSheet.create({
  hidden: { width: 1, height: 1, opacity: 0 },
});
