import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type { WebView as WebViewClass } from 'react-native-webview';

import { Text } from '@/components/ui';
import { colors } from '@/theme';

import { KAKAO_JS_KEY, MAP_PICKER_ORIGIN, mapPickerUrl, moveToMessage, parsePageMessage } from '../mapPicker';
import type { LatLng } from '../types';

type Props = {
  center: LatLng; // 처음 중심 — 주소는 한 번만 정해서 쓰므로 나중에 바뀌어도 지도를 다시 열지 않음 (옮기려면 moveTo)
  onCenter: (lat: number, lng: number) => void; // 지도를 움직여 멈춘 뒤 가운데(핀) 좌표
  moveTo?: { lat: number; lng: number; nonce: number }; // 바뀔 때마다 그 좌표로 옮김 (같은 좌표를 또 보내려면 nonce를 올림)
  onStatus: (status: 'ready' | 'error') => void; // 지도가 떴음 · 못 띄움
};

// 카카오맵 지도 칸 — public/map-picker.html을 웹은 iframe, 앱은 WebView로 열고 postMessage로 주고받음 (형식은 mapPicker.ts)
// 가운데 핀은 페이지가 그림. 카카오 JavaScript 키(EXPO_PUBLIC_KAKAO_JS_KEY)가 없으면 열지 않고 "지도 준비 중" 문구만
// 부모가 크기를 정함 (이 칸은 주어진 자리를 가득 채움)
export function MapView({ center, onCenter, moveTo, onStatus }: Props) {
  const [url] = useState(() => (KAKAO_JS_KEY ? mapPickerUrl({ origin: MAP_PICKER_ORIGIN, key: KAKAO_JS_KEY, center }) : null));
  const [failure, setFailure] = useState<'no-key' | 'failed' | null>(url ? null : 'no-key');
  const post = useRef<((text: string) => void) | null>(null); // 페이지에 글자를 보내는 함수 — 아래 웹 · 앱 조각이 register로 채움
  const ready = useRef(false);
  const queued = useRef<string | null>(null); // 지도가 뜨기 전에 온 moveTo (마지막 것만)
  const callbacks = useRef({ onCenter, onStatus });

  useEffect(() => {
    callbacks.current = { onCenter, onStatus };
  });

  // 키가 없으면 페이지를 열지 않으므로 시트에 알려 줌 (검색만으로 정하는 길)
  useEffect(() => {
    if (!url) callbacks.current.onStatus('error');
  }, [url]);

  const fail = useCallback(() => {
    setFailure('failed');
    callbacks.current.onStatus('error');
  }, []);

  const onPageMessage = useCallback(
    (raw: unknown) => {
      const message = parsePageMessage(raw);
      if (!message) return;
      if (message.type === 'center') {
        callbacks.current.onCenter(message.lat, message.lng);
      } else if (message.type === 'ready') {
        ready.current = true;
        if (queued.current) post.current?.(queued.current);
        queued.current = null;
        callbacks.current.onStatus('ready');
      } else {
        setFailure(message.reason === 'no-key' ? 'no-key' : 'failed');
        callbacks.current.onStatus('error');
      }
    },
    [],
  );

  const register = useCallback((send: ((text: string) => void) | null) => {
    post.current = send;
  }, []);

  useEffect(() => {
    if (!moveTo) return;
    const text = moveToMessage(moveTo.lat, moveTo.lng);
    if (!text) return;
    if (ready.current && post.current) post.current(text);
    else queued.current = text;
  }, [moveTo]);

  if (!url || failure) {
    return (
      <View style={styles.placeholder}>
        <Text variant="bodyStrong" tone="sub">
          {failure === 'failed' ? '지도를 불러오지 못했어요' : '지도 준비 중'}
        </Text>
        <Text variant="caption" align="center">
          위에서 장소를 검색해 고를 수 있어요
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.fill}>
      {Platform.OS === 'web' ? (
        <WebFrame url={url} register={register} onMessage={onPageMessage} />
      ) : (
        <AppFrame url={url} register={register} onMessage={onPageMessage} onFail={fail} />
      )}
    </View>
  );
}

type FrameProps = { url: string; register: (send: ((text: string) => void) | null) => void; onMessage: (raw: unknown) => void };

// 웹 미리보기 — iframe. 같은 창의 iframe이 보낸 글자만 받음 (origin · 창 둘 다 확인)
function WebFrame({ url, register, onMessage }: FrameProps) {
  const frame = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const origin = new URL(url).origin;
    const listener = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      onMessage(event.data);
    };
    window.addEventListener('message', listener);
    register((text) => frame.current?.contentWindow?.postMessage(text, origin));
    return () => {
      window.removeEventListener('message', listener);
      register(null);
    };
  }, [url, register, onMessage]);

  return (
    <iframe
      ref={frame}
      src={url}
      title="지도"
      sandbox="allow-scripts allow-same-origin" // 지도 페이지는 스크립트만 필요 (이동 · 팝업 · 폼은 막음)
      style={{ border: 0, width: '100%', height: '100%', display: 'block' }}
    />
  );
}

// 안드로이드 앱 — WebView. 웹 번들이 이 패키지를 읽지 않도록 그릴 때 불러옴
function AppFrame({ url, register, onMessage, onFail }: FrameProps & { onFail: () => void }) {
  const view = useRef<WebViewClass | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 안드로이드일 때만 읽음 (웹 번들에서 로드되지 않게)
  const { WebView } = require('react-native-webview') as typeof import('react-native-webview');

  useEffect(() => {
    register((text) => view.current?.postMessage(text));
    return () => register(null);
  }, [register]);

  return (
    <WebView
      ref={view}
      source={{ uri: url }}
      onMessage={(event) => onMessage(event.nativeEvent.data)}
      onError={onFail}
      onHttpError={onFail}
      originWhitelist={['https://*', 'http://*']}
      javaScriptEnabled
      domStorageEnabled
      nestedScrollEnabled // 시트(스크롤) 안에서도 지도를 끌 수 있게
      setSupportMultipleWindows={false}
      overScrollMode="never"
      style={styles.web}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: 'hidden', backgroundColor: colors.chip },
  web: { flex: 1, backgroundColor: colors.chip },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 24, backgroundColor: colors.chip },
});
