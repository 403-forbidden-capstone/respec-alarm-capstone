# Re:Spec Alarm 앱

Expo SDK 57 · Expo Router · TypeScript

## 실행

```bash
cd mobile
npm install
npm run web
```

브라우저에서 화면을 바로 볼 수 있습니다. PC에서는 휴대폰 크기로 가운데에 보입니다.
폰에서 보려면 개발용 APK가 필요합니다. Expo Go로는 실행되지 않습니다.

패키지는 `npx expo install <이름>`으로 추가합니다. SDK 57에 맞는 버전이 들어갑니다.

## 폴더

| 폴더 | 내용 |
|---|---|
| `src/app/` | 화면. 파일 위치가 곧 주소 (Expo Router) |
| `src/app/(tabs)/` | 탭 4개: 01 홈 · 02 그룹 · 03 AI · 04 기록 (목업 순서) |
| `src/features/alarm/` | ① 약속 기반 알람 |
| `src/features/social/` | ② 알람 공유 · 기상 확인 |
| `src/features/voice/` | ③ 수면 전후 음성 AI |
| `src/features/records/` | ④ 일정 · 하루 기록 |
| `src/features/routine/` | ⑥ AI 일기 · 루틴 |
| `src/components/ui/` | 여러 화면에서 같이 쓰는 UI (글자 · 카드 · 버튼 · 칩 · 스위치 · 탭 막대 등). 견본은 `/dev/ui` |
| `src/lib/` | Supabase 클라이언트 같은 공용 코드 |
| `src/mocks/` | 목업용 가짜 데이터 |
| `src/theme/` | 색 · 간격 · 글자 크기 (목업 `mockup.html`의 :root 값). 글꼴은 Pretendard(`assets/fonts`) |

기능 폴더 안에는 `api.ts`(데이터) · `types.ts` · `components/` · `hooks/`가 있습니다.
`api.ts`는 지금 목업 데이터를 돌려주고, Supabase가 붙으면 이 파일만 바꿉니다.
