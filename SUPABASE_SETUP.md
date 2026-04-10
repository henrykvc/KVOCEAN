# Supabase Setup

## 1. Auth 설정

1. Supabase 대시보드에서 `Authentication > Providers > Email`로 이동합니다.
2. `Enable Email provider`를 켭니다.
3. 로그인 방식은 이메일+비밀번호 기준으로 운영합니다.
4. 공개 가입을 막고 싶으면 수동 사용자 생성 방식으로 운영합니다.

## 2. URL 설정

1. `Authentication > URL Configuration`으로 이동합니다.
2. `Site URL`에 배포 주소를 넣습니다.
   - 로컬: `http://localhost:3000`
   - 운영: `https://your-project.vercel.app`
3. `Redirect URLs`에 아래를 추가합니다.
   - `http://localhost:3000/auth/callback`
   - `https://your-project.vercel.app/auth/callback`
   - 커스텀 도메인이 있으면 그 도메인의 `/auth/callback`도 추가합니다.

## 3. SQL 실행

1. Supabase에서 `SQL Editor`를 엽니다.
2. 저장소의 `supabase/001_auth_and_shared_data.sql` 내용을 먼저 실행합니다.
3. 이어서 `supabase/002_access_control.sql`, `supabase/003_dataset_trash.sql`도 순서대로 실행합니다.
4. 이 스크립트들은 공용 설정, 데이터셋, 변경 이력 테이블과 접근 제어, 휴지통용 소프트 삭제 컬럼을 생성합니다.

## 4. 환경변수 설정

`.env.local`을 만들고 `.env.example` 값을 채웁니다.

```bash
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

## 5. Vercel 환경변수 설정

1. Vercel 프로젝트 > `Settings > Environment Variables`
2. 아래 값을 Preview/Production에 모두 넣습니다.
   - `NEXT_PUBLIC_SITE_URL`
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

## 6. 사용자 생성

1. Supabase 대시보드에서 `Authentication`으로 이동합니다.
2. `Users` 메뉴를 엽니다.
3. 오른쪽 위 `Add user` 버튼을 누릅니다.
4. 이메일에 `henry@kakaoventures.co.kr`를 입력합니다.
5. 비밀번호를 직접 지정하거나, 생성 후 비밀번호 재설정 절차를 사용합니다.
6. 생성된 이메일/비밀번호로 로그인합니다.

- Supabase Auth에 사용자가 없으면 이메일/비밀번호 로그인도 불가능합니다.
- 나중에 다른 사람을 추가할 때도 같은 방식으로 Supabase에서 사용자를 생성하면 됩니다.

## 7. 현재 반영된 앱 변경점

- `/login` 이메일/비밀번호 로그인 페이지 추가
- `/auth/callback` 세션 처리 추가
- `/auth/logout` 로그아웃 처리 추가
- `middleware.ts`로 보호 라우트 적용
- 메인 페이지에서 로그인 사용자만 접근 가능하도록 검증 추가

## 8. 아직 남아 있는 작업

현재는 인증 연결까지 끝난 상태입니다. 앱 설정과 검증 데이터는 모두 Supabase에 저장하고, 인증도 Supabase를 그대로 사용합니다.

- `savedDatasets`
- `logicConfig`
- `companyConfigs`
- `classificationCatalog`
- 변경 이력 저장
