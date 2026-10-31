import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';
import type { WebView as WebViewClass } from 'react-native-webview';

import { Button, Text } from '@/components/ui';
import { colors } from '@/theme';

import {
  isAllowedMapRequest,
  isWebLink,
  KAKAO_JS_KEY,
  MAP_PICKER_ORIGIN,
  mapPickerUrl,
  moveToMessage,
  parsePageMessage,
  setRadiusMessage,
  startReadyTimer,
} from '../mapPicker';
import type { LatLng } from '../types';

type Props = {
  center: LatLng; // 처음 중심 — 주소는 한 번만 정해서 쓰므로 나중에 바뀌어도 지도를 다시 열지 않음 (옮기려면 moveTo)
  onCenter: (lat: number, lng: number) => void; // 지도를 움직여 멈춘 뒤 가운데(핀) 좌표
  moveTo?: { lat: number; lng: number; nonce: number }; // 바뀔 때마다 그 좌표로 옮김 (같은 좌표를 또 보내려면 nonce를 올림)
  onStatus: (status: 'loading' | 'ready' | 'error') => void; // 지도가 떴음 · 못 띄움 (다시 시도하면 loading)
  radiusMeters?: number; // 핀 둘레에 그릴 감지 범위 원(m). 없으면 원 없음. 바뀔 때마다 페이지에 setRadius를 보냄 (지도가 뜨기 전 · 다시 시도 뒤에도 마지막 값이 다시 감)
};

// 카카오맵 지도 칸 — public/map-picker.html을 웹은 iframe, 앱은 WebView로 열고 postMessage로 주고받음 (형식은 mapPicker.ts)
// 가운데 핀은 페이지가 그림. 카카오 JavaScript 키(EXPO_PUBLIC_KAKAO_JS_KEY)가 없으면 열지 않고 "지도 준비 중" 문구만
// 키가 있는데 12초 안에 지도가 안 뜨면(허용 도메인이 틀려 빈 지도 · 네트워크 막힘) 못 띄운 것으로 보고 [다시 시도]를 보여 줌
// 부모가 크기를 정함 (이 칸은 주어진 자리를 가득 채움)
export function MapView({ center, onCenter, moveTo, onStatus, radiusMeters }: Props) {
  const [url] = useState(() => (KAKAO_JS_KEY ? mapPickerUrl({ origin: MAP_PICKER_ORIGIN, key: KAKAO_JS_KEY, center }) : null));
  const [failure, setFailure] = useState<'no-key' | 'failed' | null>(url ? null : 'no-key');
  const [loaded, setLoaded] = useState(false); // 페이지가 ready를 보냄
  const [attempt, setAttempt] = useState(0); // 다시 시도할 때마다 올려 웹 · 앱 조각을 새로 띄움
  const post = useRef<((text: string) => void) | null>(null); // 페이지에 글자를 보내는 함수 — 아래 웹 · 앱 조각이 register로 채움
  const ready = useRef(false);
  const queued = useRef<string | null>(null); // 지도가 뜨기 전에 온 moveTo (마지막 것만)
  const radiusText = useRef<string | null>(null); // 마지막 setRadius — 페이지가 새로 뜰 때(처음 · 다시 시도)마다 다시 보냄
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

  // 지도가 안 뜨는 채로 12초가 지나면 실패 — ready가 오면 · 다시 시도 · 언마운트 때 타이머를 풂
  const waiting = !!url && !failure && !loaded;
  useEffect(() => {
    if (!waiting) return;
    return startReadyTimer(fail);
  }, [waiting, attempt, fail]);

  const retry = useCallback(() => {
    ready.current = false;
    setLoaded(false);
    setFailure(null);
    setAttempt((n) => n + 1);
    callbacks.current.onStatus('loading');
  }, []);

  const onPageMessage = useCallback(
    (raw: unknown) => {
      const message = parsePageMessage(raw);
      if (!message) return;
      if (message.type === 'center') {
        callbacks.current.onCenter(message.lat, message.lng);
      } else if (message.type === 'ready') {
        ready.current = true;
        setLoaded(true);
        if (queued.current) post.current?.(queued.current);
        queued.current = null;
        if (radiusText.current) post.current?.(radiusText.current);
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

  // 감지 범위 원 — 지도가 떠 있으면 바로, 아니면 ready 때 보냄 (위 onPageMessage)
  useEffect(() => {
    if (radiusMeters == null) return;
    const text = setRadiusMessage(radiusMeters);
    radiusText.current = text;
    if (ready.current && post.current) post.current(text);
  }, [radiusMeters]);

  if (!url || failure) {
    return (
      <View style={styles.placeholder}>
        <Text variant="bodyStrong" tone="sub">
          {failure === 'failed' ? '지도를 불러오지 못했어요' : '지도 준비 중'}
        </Text>
        <Text variant="caption" align="center">
          위에서 장소를 검색해 고를 수 있어요
        </Text>
        {failure === 'failed' ? <Button label="다시 시도" variant="ghost" small onPress={retry} /> : null}
      </View>
    );
  }
  return (
    <View style={styles.fill}>
      {Platform.OS === 'web' ? (
        <WebFrame key={attempt} url={url} register={register} onMessage={onPageMessage} />
      ) : (
        <AppFrame key={attempt} url={url} register={register} onMessage={onPageMessage} onFail={fail} />
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
      // 페이지가 같은 origin이라 allow-scripts와 allow-same-origin을 함께 줘야 동작함 → 이 조합은 페이지 스크립트가 sandbox를 벗어날 수 있어 격리는 약함(이동 · 팝업 · 폼만 막음).
      // 우리 페이지(public/map-picker.html)만 열고 주소는 우리가 정하므로 위험을 알고 감. 바깥 페이지를 열게 되면 바꿔야 함
      sandbox="allow-scripts allow-same-origin"
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

  // 지도 페이지 말고는 WebView가 가지 못하게 막음 — 다른 주소(광고 · 카카오 약관 링크 등)는 http · https만 바깥 브라우저로 넘김
  const onShouldStart = useCallback((request: { url: string }) => {
    if (isAllowedMapRequest(request.url, MAP_PICKER_ORIGIN)) return true;
    if (isWebLink(request.url)) {
      try {
        Promise.resolve(Linking.openURL(request.url)).catch(() => {});
      } catch {
        /* 열 수 없는 주소면 조용히 */
      }
    }
    return false;
  }, []);

  return (
    <WebView
      ref={view}
      source={{ uri: url }}
      onMessage={(event) => onMessage(event.nativeEvent.data)}
      onError={onFail}
      onHttpError={onFail}
      originWhitelist={[MAP_PICKER_ORIGIN.replace(/\/+$/, '')]} // 지도 페이지 origin 하나 (개발 중 http 주소면 그 주소)
      onShouldStartLoadWithRequest={onShouldStart}
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
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 24, backgroundColor: colors.chip },
});
