# Supabase Setup

## 1. Auth 설정

1. Supabase 대시보드에서 `Authentication > Providers > Email`로 이동합니다.
2. `Enable Email provider`를 켭니다.
3. 비밀번호 대신 매직링크만 쓸 거면 `Confirm email`은 켜두는 편이 안전합니다.
4. 공개 가입을 막고 싶으면 초대 방식으로 운영하고, 앱에서는 `shouldCreateUser: false`로 이미 막아 둔 상태입니다.

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
2. 저장소의 `supabase/001_auth_and_shared_data.sql` 내용을 그대로 실행합니다.
3. 이 스크립트는 공용 설정, 데이터셋, 변경 이력 테이블과 기본 RLS 정책을 생성합니다.
4. 이어서 `supabase/002_access_control.sql`도 실행합니다.
5. 이 스크립트는 `allowed_users`, `admin_users` 테이블을 만들고 `henry@kakaoventures.co.kr`를 최초 관리자/허용 사용자로 등록합니다.

## 4. 환경변수 설정

`.env.local`을 만들고 `.env.example` 값을 채웁니다.

```bash
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_SERVICE_ROLE_KEY
ALLOWED_EMAILS=name@company.com,other@company.com
# ALLOWED_EMAIL_DOMAINS=company.com
```

- `ALLOWED_EMAILS`를 넣으면 그 이메일만 허용합니다.
- `ALLOWED_EMAILS`가 없을 때만 `ALLOWED_EMAIL_DOMAINS` 기준으로 허용합니다.
- `SUPABASE_SERVICE_ROLE_KEY`를 넣으면 코드에 박지 않고 DB의 `allowed_users`, `admin_users` 기준으로 접근 제어를 할 수 있습니다.

## 5. Vercel 환경변수 설정

1. Vercel 프로젝트 > `Settings > Environment Variables`
2. 아래 값을 Preview/Production에 모두 넣습니다.
   - `NEXT_PUBLIC_SITE_URL`
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ALLOWED_EMAILS`
   - 필요 시 `ALLOWED_EMAIL_DOMAINS`

## 6. 허용 사용자 초대

1. Supabase 대시보드에서 `Authentication`으로 이동합니다.
2. `Users` 메뉴를 엽니다.
3. 오른쪽 위 `Invite user` 또는 `Add user` 버튼을 누릅니다.
4. 초대할 이메일에 `henry@kakaoventures.co.kr`를 입력합니다.
5. 이메일 초대를 보냅니다.
6. 받은 메일의 링크를 누르면 최초 로그인 세션이 생성됩니다.

- 지금 앱은 `ALLOWED_EMAILS`에 들어 있는 이메일만 통과시킵니다.
- `SUPABASE_SERVICE_ROLE_KEY`까지 연결하면 `allowed_users` 테이블에 등록된 이메일만 통과시킵니다.
- Supabase에 사용자를 초대하지 않으면 `shouldCreateUser: false` 때문에 로그인 메일 발송이 실패할 수 있습니다.
- 나중에 다른 사람을 추가할 때는 `ALLOWED_EMAILS`에 이메일을 더하고, 같은 방식으로 Supabase에서 초대하면 됩니다.

## 7. 관리자 위임 구조

- `admin_users`에 들어 있는 이메일은 이후 관리자 화면에서 다른 사용자를 추가/비활성화할 수 있게 확장할 수 있습니다.
- 즉, 나중에 후임자 이메일을 `admin_users`에 넣으면 관리 권한을 넘길 수 있습니다.
- 현재는 테이블/권한 구조까지 준비했고, 다음 단계에서 관리자 UI를 붙이면 됩니다.

## 8. 허용 사용자 운영

- 지금 코드는 `ALLOWED_EMAILS` 또는 `ALLOWED_EMAIL_DOMAINS`로 앱 접근을 막습니다.
- 실제 운영에서는 Supabase 초대 기능으로 계정을 미리 만든 뒤 로그인시키는 방식을 권장합니다.
- 후임자에게 넘길 때는 Vercel/Supabase 권한을 추가하고, 허용 이메일 목록만 바꾸면 됩니다.

## 9. 현재 반영된 앱 변경점

- `/login` 매직링크 로그인 페이지 추가
- `/auth/callback` 세션 처리 추가
- `/auth/logout` 로그아웃 처리 추가
- `middleware.ts`로 보호 라우트 적용
- 메인 페이지에서 허용 이메일만 접근 가능하도록 검증 추가

## 10. 아직 남아 있는 작업

현재는 인증 연결까지 끝난 상태입니다. 실제 데이터는 아직 `localStorage`를 쓰고 있으므로 다음 단계에서 아래를 Supabase로 옮겨야 합니다.

- `savedDatasets`
- `logicConfig`
- `companyConfigs`
- `classificationCatalog`
- 변경 이력 저장
