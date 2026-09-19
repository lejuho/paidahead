# PaidAhead 웹 — 로컬 시연 프론트엔드

Next.js(App Router)·TypeScript·viem. 납품업체·구매처·은행이 각자의 화면과 **각자의 EVM 지갑**으로 신청 → 구매처 확인 → 채권 등록 → 은행 심사·조건 승인 → 오퍼 등록 → 먼저받기(매입) → 전액 상환을 끝까지 진행한다. 공개 테스트넷 배포, 운영 인증, 파일 업로드·AI 분석은 범위 밖이다.

## 1. 실행 순서

저장소 루트, Node.js 24 이상. **한 번에 띄우기:**

```bash
npm ci                                  # 최초 1회
npm run stack -- up --fresh --fund      # DB+체인 초기화 → 배포 → API·워커·웹 시작 → 모의 토큰 충전
npm run stack -- up                     # 이미 있는 DB·체인 그대로 (꺼진 서비스만 시작, seed 토큰 갱신)
npm run stack -- status | down | logs [chain|api|worker|web]
```

| 인자 | 동작 |
|---|---|
| `--fresh` | 스택을 멈추고 `.local/pg`와 체인을 **함께** 초기화. 체인을 껐다 켰다면 반드시 필요(안 쓰면 불일치를 감지해 중단하고 안내) |
| `--fund[=금액]` | 은행·구매처 지갑에 모의 토큰 발행 (기본 10000000) |
| `--docker` | 내장 PostgreSQL 대신 `docker compose` 사용 |
| `--no-web` | 웹을 직접 `npm run dev:web`으로 띄울 때 |

서비스는 백그라운드로 실행되고 로그는 `.local/logs/`에 쌓인다. `down`은 체인도 끄므로 다음 실행은 `up --fresh`다. 아래는 같은 일을 단계별로 직접 하는 방법이다(터미널 4개).

```bash
npm ci && npm run build
cp .env.example .env
npm run db:local            # Docker가 없을 때: .local/pg 에 PostgreSQL(127.0.0.1:54329) 시작. Docker면 docker compose up -d --wait postgres
npm run db:migrate && npm run db:seed
npm run chain:local         # 터미널 1: Hardhat 로컬 체인 (127.0.0.1:8545, chain 31337). 계정·개인키가 출력된다
npm run chain:setup         # 터미널 2: 계약 배포 + 조직 승인 지갑 연결 (최초 1회)
npm run dev:api             # 터미널 2: 업무 API  http://127.0.0.1:3003
npm run worker:start        # 터미널 3: 등록·결제 동기화 워커
npm run dev:web             # 터미널 4: 웹  http://127.0.0.1:3000
npm run demo:fund           # 은행·구매처 지갑에 모의 토큰 각 1,000만 mKRW 발행 (--krw, --only bank|buyer)
```

- 로컬 체인을 다시 시작하면 체인 데이터가 사라진다. `npm run db:local:stop && rm -rf .local/pg` 후 DB부터 다시 만든다(기존 DB와 새 체인을 섞지 않는다).
- 시연 토큰은 24시간 유효하다. 화면에 "시연 로그인이 만료"가 나오면 `npm run db:seed`를 다시 실행한다(업무 데이터는 유지).
- 종료: 각 터미널 Ctrl+C, `npm run db:local:stop`.

### 환경 변수 (루트 `.env`, 웹 서버가 함께 읽음)

| 변수 | 기본값 | 용도 |
|---|---|---|
| `DEMO_MODE` | `true` | 시연 인증 활성화. `NODE_ENV=production`(예: `next start`)에서는 값과 무관하게 **비활성** |
| `API_PORT` / `API_URL` | `3003` / `http://127.0.0.1:3003` | 웹 서버 → 업무 API. loopback만 허용 |
| `REGISTRATION_RPC_URL` | `http://127.0.0.1:8545` | API·워커 RPC. 지갑에 네트워크를 추가할 때 안내하는 RPC로도 사용 |
| `WEB_CHAIN_RPC_URL` | (없음) | 브라우저 지갑이 접속할 RPC가 다를 때만 지정 |
| `DEMO_ACCESS_FILE` | `.local/demo-access.json` | seed가 만든 시연 토큰 파일 |

`NEXT_PUBLIC_*` 변수는 쓰지 않는다. 브라우저 번들에는 토큰·키·RPC 비밀값이 들어가지 않는다.

## 2. 인증 구조 (시연 전용)

```
브라우저 ──(httpOnly 쿠키: 역할 이름만)──▶ Next 서버 /api/backend/* ──(Bearer 토큰 + X-Organization-Id)──▶ 업무 API
```

- 첫 화면은 **공통 로그인** 하나다. 시연 계정으로 로그인하면 어떤 업무 화면(납품업체·구매처·은행)이 열리는지는 클라이언트 선택이 아니라 `/me`가 돌려준 **소속 조직 종류**로 정해진다. 실제 인증을 붙일 때는 이 로그인 단계만 교체하면 된다.
- 로그인하면 Next 서버가 `paidahead_demo_role` 쿠키(httpOnly, SameSite=Strict)를 굽는다. **Bearer 토큰은 Next 서버만 읽고 브라우저로 나가지 않는다.** CORS를 열지 않았고 API는 계속 127.0.0.1에만 바인딩한다.
- 모든 권한 판단은 기존 API(조직 소속·역할·승인 상태·채권 당사자)가 한다. 웹은 버튼을 숨길 뿐이고, 숨김을 우회한 요청은 API가 403/404로 거절한다.
- **지갑 연결은 로그인도 권한도 아니다.** 연결 주소가 로그인 조직의 승인 지갑(`/me.wallets`)과 같은지, 준비된 거래의 `from`과 같은지 확인하고 다르면 서명 요청 자체를 보내지 않는다.
- 상단 배너와 역할 배지에 시연 모드임을 항상 표시한다. 운영 인증은 구현되어 있지 않다.

## 3. 지갑 네트워크·계정 설정 (MetaMask 등 확장 지갑)

| 항목 | 값 |
|---|---|
| 네트워크 이름 | PaidAhead 로컬 (Hardhat 31337) |
| RPC URL | `http://127.0.0.1:8545` |
| 체인 ID | `31337` |
| 통화 기호 | ETH |

지갑이 다른 네트워크에 있으면 상단 지갑 막대의 **네트워크 전환**이 `wallet_switchEthereumChain` → 필요 시 `wallet_addEthereumChain`을 요청한다.

`chain:setup`은 Hardhat 기본 계정을 조직 승인 지갑으로 연결한다. `npm run chain:local` 출력의 해당 Account 개인키를 지갑에 **가져오기** 한다(공개된 테스트 키다. 실제 자산이 있는 네트워크에서 절대 쓰지 않는다).

| 역할(시연 계정) | 조직 | Hardhat 계정 | 주소 |
|---|---|---|---|
| 납품업체 | 대구 식자재 납품 역할 | Account #2 | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` |
| 구매처 | 시장 식당 역할 | Account #3 | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` |
| 은행 | iM뱅크 역할 · 시연용 | Account #4 | `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` |

(Account #0은 배포·모의 토큰 발행 관리자, #1은 등록 워커 전용이다. 브라우저 지갑에 넣지 않는다.) 역할을 바꾸면 지갑에서도 계정을 바꾼다. 계정·네트워크 변경은 즉시 감지되어 불일치 경고가 뜬다. 로컬 체인을 재시작했다면 MetaMask의 "활동 및 nonce 데이터 지우기"를 실행한다.

WSL2에서 서버를 띄우고 Windows 브라우저를 쓰는 경우 `http://localhost:3000`, RPC `http://127.0.0.1:8545` 그대로 접속된다(WSL localhost 전달).

## 4. 전체 시연 절차

역할마다 브라우저 프로필(또는 시크릿 창)을 따로 쓰면 편하다. 한 창에서 하려면 우상단 **로그아웃** 후 다른 계정으로 로그인한다.

1. **납품업체** `/applications` → 새 먼저받기 신청(300만원·만기·가상 서류 3종) → 서류 검토(품목 100 × 30,000원 = 합계 일치) → 동의 후 **구매처에 확인 요청**.
2. **구매처** `/confirmations` → 요청 열기 → 서류 열람 → 납품 사실·지급 의무 체크 → **확인** (또는 사유와 함께 반려).
3. 워커가 채권을 등록한다. 납품업체 화면이 자동 갱신되어 "채권 등록 완료" → **은행 조건·먼저받기 화면으로**.
4. **은행** `/bank/reviews` → 건 열기 → **검토 시작** → (선택) 보완 요청 ↔ 납품업체 답변 ↔ 답변 확인 → 매입 금액 2,970,000원·유효기간 → **조건 승인**.
5. 은행 지갑(Account #4) 연결 → **오퍼 등록 시작** → ① 토큰 사용 승인 → ② 오퍼 등록 서명 → "DB 반영 완료"까지 대기. (철회는 **조건 철회**, 이후 새 조건 승인 가능)
6. `npm run demo:fund` 로 은행·구매처에 모의 토큰을 채운다(안 채우면 다음 단계에서 "은행 지갑 잔액 부족"으로 차단되는 것을 볼 수 있다).
7. **납품업체** 지갑(Account #2) 연결 → **이 조건으로 먼저받기** → 서명 → "모의 지급 완료 · 297만원".
8. **구매처** `/repayments` → 채권 열기 → 지갑(Account #3) 연결 → **모의 상환 시작** → ① 토큰 사용 승인(300만) → ② 상환 서명 → "상환 완료".
9. **은행** `/portfolio` 에서 매입·상환 현황, 각 상세의 "온체인 기록"에서 이벤트·거래 해시를 확인한다.

## 5. 화면과 경로

| 역할 | 경로 | 내용 |
|---|---|---|
| 공통 | `/` | 공통 로그인(시연 계정). 로그인 후 소속 조직에 따라 이동 |
| 공통 | 상단 탭 | 탭마다 색이 다른 **할 일 배지**(내 조직 차례인 건수)와 대기 건수. 목록은 "지금 할 일 / 기다리는 중 / 완료"로 묶고 "5분 전" 상대 시간(툴팁에 정확한 시각)과 최근 10분 변경 점을 표시 |
| 납품업체 | `/applications`, `/applications/new`, `/applications/[id]` | 신청 목록·생성, 서류 검토, 확인 요청·철회, 반려 후 새 버전, 등록 진행·재시도 |
| 납품업체 | `/receivables`, `/receivables/[id]` | 은행 조건 확인·수락(먼저받기), 보완 요청 답변, 매입 결과, 등록 취소 |
| 구매처 | `/confirmations`, `/confirmations/[id]` | 확인 요청 목록·상세, 서류 열람, 확인·반려 |
| 구매처 | `/repayments`, `/receivables/[id]` | 상환 대상, 액면 전액 상환 |
| 은행 | `/bank/reviews`, `/bank/reviews/[id]` | 대기열, 검토 자료, 내부 메모·보완 요청·매입 불가·조건 승인, 오퍼 등록·철회 |
| 은행 | `/portfolio`, `/receivables/[id]` | 매입·상환 현황, 연체 표시, 온체인 이력 |

API에 없는 동작은 만들지 않았다: 확인 요청 **철회는 납품업체만** 가능하고(구매처 화면에는 철회된 상태만 표시), 부분 상환·분쟁 접수·파일 업로드·관리자 화면은 없다.

## 6. 지갑 거래 처리 규칙

한 거래는 다섯 단계로 따로 표시된다: **거래 준비 → 지갑 승인 대기 → 전송 → 체인 확정 대기 → DB 반영 완료**.

- 거래 해시나 성공 영수증을 받아도 업무 완료로 표시하지 않는다. `GET /operations/:id`가 `CONFIRMED`(워커가 영수증·이벤트를 검증해 DB에 반영)일 때만 완료다.
- 서명 직전에 `preflight`를 다시 호출한다. 자기 지갑 allowance 부족 → "1단계 토큰 사용 승인" 후 본 거래, 자기 잔액 부족(상환) → 차단, 은행 자금 미준비(수락) → 차단, 계약 시뮬레이션 거절 → 차단·다시 점검. 오퍼 등록은 자금을 예약하지 않으므로 은행 잔액 부족은 경고만 한다.
- 서명 거절(4001)은 `/operations/:id/reject`에 기록하고 새 멱등키로 다시 시도한다. 지갑에 열린 요청 있음(-32002)·가스 부족·revert·RPC 오류는 각각 다른 문구로 안내하고 재시도할 수 있다.
- 중복 방지: 버튼 비활성화 + 동기 잠금(ref) + `idempotencyKey` 재사용(localStorage) + 서버의 `OPERATION_IN_PROGRESS`. 진행 중인 거래가 있으면 새로 만들지 않고 이어서 표시한다.
- 새로고침 복구: `GET /receivables/:id/operations`(자기 조직의 작업만)로 미결 작업을 찾아 패널을 복원한다. 해시 통지(`POST /operations/:id/transaction`)가 실패했어도 브라우저에 남은 해시를 재통지하고, 그것마저 없으면 워커가 체인 로그와 calldata를 대조해 복구한다.
- 금액은 API의 정수 문자열 → `bigint`로만 다루고 `@paidahead/domain`의 `parseKrw`·`toTokenUnits`·`fromTokenUnits`를 재사용한다. `Number`는 금액에 쓰지 않는다(수량·표시용 가스만 예외).

## 7. 검증

```bash
npm run check      # 빌드(웹 포함)·타입 검사·도메인 3 + 웹 7 + API 16 + 계약·연동 44 테스트
npm run e2e:web    # 위 1번 스택이 실행 중일 때: 실제 API·PostgreSQL·로컬 EVM + 헤드리스 Chromium 14단계
```

`e2e:web`은 `apps/web/e2e/test-wallet.mjs`의 **자동화 전용 EIP-1193 지갑**(EIP-6963로 주입, Node에서 Hardhat 공개 키로 서명, loopback 전용)을 쓴다. 이 지갑은 웹 번들에 포함되지 않는다. 시작할 때 은행·구매처 모의 토큰 잔액과 allowance를 0으로 되돌려 "부족" 시나리오를 매번 재현한다. 테스트가 만든 신청은 제목이 `E2E … [실행코드]` 형식이며, **전 단계가 통과하면 그 실행의 DB 기록을 자동 삭제**한다(실패 시 또는 `--keep`/`E2E_KEEP=1`이면 디버깅용으로 남긴다). 남은 테스트 데이터는 `npm run e2e:clean`으로 모두 지운다. 정리는 loopback 시연 DB의 superuser 연결에서만 동작하고 제목이 `E2E `로 시작하는 신청만 건드린다. 스크린샷은 `apps/web/e2e-output/`에 남는다. Chromium 실행에 시스템 라이브러리(libnss3, libnspr4, libasound2)가 필요하다: `npx playwright install --with-deps chromium`.

검증 범위: 권한 불일치(역할 화면·API 403), 반려→새 버전→철회, 중복 제출 1건, 구매처 확인→등록, 은행 보완·승인(내부 메모 비노출), 네트워크 불일치·전환, 조직-지갑 불일치 시 미전송, allowance 승인→서명 거절→재시도→더블클릭 1건, 오퍼 철회·재등록, 은행 잔액 부족 차단→충전 후 매입, 해시 통지 실패+새로고침 복구, 구매처 잔액 부족→승인→상환 중 새로고침→REPAID, 매입 불가→등록 취소, 모바일 폭 넘침 없음.

**확장 지갑(MetaMask 등) 실물 검증은 이 저장소의 자동화에 포함되지 않는다.** 3·4장의 절차로 수동 확인한다.
