# 채권 등록·결제 동기화 워커

구매처 확인 완료 → 등록 작업 → 채권 예약 → 서명·제출 → 영수증·이벤트 검증 → DB 등록 완료·은행 대기열을 연결한다. 같은 프로세스가 오퍼·매입·상환·취소 로그를 별도의 커서로 동기화한다. 각 단계 오류는 다음 주기에 재시도하며 다른 단계 실행을 막지 않는다.

## 로컬 전체 흐름

루트에서 `npm ci`, `npm run build`, `.env.example`을 참고한 `.env` 설정, `docker compose up -d --wait postgres`, `npm run db:migrate`, `npm run db:seed`를 먼저 실행한다. 기존 DB도 `003_settlement.sql`까지을 적용해야 한다.

터미널 1:

```bash
npm run chain:local
```

터미널 2에서 로컬 계약·역할·승인 지갑을 설정한다. 설정은 가상 조직 3곳을 사용하는 초기 로컬 시연용이다.

```bash
npm run chain:setup
npm run dev:api
```

터미널 3:

```bash
npm run worker:start
```

터미널 4:

```bash
npm run demo:registration
# 은행 심사·매입·전액 상환까지:
npm run demo:settlement
```

HTTP로 신청·검토·구매처 확인을 실행하고 등록 완료를 최대 30초 기다린다. `chainRegistration: CONFIRMED`, 채권 ID와 실제 로컬 거래 해시가 출력된다. 연속 워커 대신 `npm run worker:once`로 한 작업씩 처리할 수도 있다.

로컬 시연은 Hardhat 공개 테스트 계정의 두 번째 주소를 등록자로 사용한다. `LOCAL_DEMO_REGISTRAR=true`는 loopback RPC·chain ID 31337에서만 허용한다. 외부 테스트넷 배포·가스 충전은 수행하지 않는다. 테스트넷용 키를 나중에 사용할 경우 워커 환경에만 제공한다.

로컬 노드를 초기화하면 체인 데이터가 사라진다. 기존 등록 DB와 새 체인을 섞지 말고 별도 시연 DB로 시작한다. `chain:setup`은 활성 배포가 이미 있으면 새 배포로 덮어쓰지 않는다. 계약 설정 시 Settlement·모의 토큰·은행 승인 지갑을 DB에 연결한다. 매입·상환은 참여자 지갑이 서명하며 워커는 그 결과를 읽는다.

## DB와 API

- `chain_operation`: 확인 완료와 같은 DB 트랜잭션에서 NOT_SUBMITTED 작업을 생성한다. 확인 ID가 멱등키다. 기존 최신 확인 완료 건도 마이그레이션으로 큐에 들어간다.
- `receivable`: 워커가 최신 버전·확인·스냅샷·현재 승인 조직/지갑을 검증한 뒤 예약한다. UUID를 uint256 토큰 ID로 변환하고 이후 재시도에도 유지한다.
- `chain_transaction`: 원문 서명키가 아닌 서명된 거래 바이트·nonce·해시를 저장한다. 반드시 DB 저장 후 브로드캐스트한다. 이 데이터는 사용자 API에 노출하지 않는다.
- `chain_event`: 등록 계약의 이벤트와 예상 토큰 ID·모든 등록 필드가 일치해야 저장한다.
- `bank_review`: 영수증·이벤트 확인이 끝난 등록 채권에만 PENDING 검토 건을 한 번 만든다.

| API | 용도 |
|---|---|
| GET `/applications/:id/registration` | 관련 업체·구매처가 등록 상태, 실패 코드, 확정 거래 해시 조회 |
| POST `/applications/:id/registration/retry` | 소유 업체가 확실히 FAILED인 작업을 재시도. PENDING은 재시도 작업 생성 금지 |
| GET `/bank/reviews` | 지정 은행 담당자의 등록 완료 대기열 |

토큰·기관 헤더는 [API 안내](../api/README.md)와 같다. 구매처 확인 CONFIRMED와 등록 작업 CONFIRMED는 별개다. 자료 수정은 예약 전까지만 가능하고 큐의 이전 작업을 INVALIDATED로 만든다. 예약 이후에는 결과 불명·실패를 포함해 기초자료 수정과 식별자 재사용을 보수적으로 차단한다. 예약 해제·정정은 별도 운영 절차가 필요하다.

## 복구 규칙

1. PostgreSQL advisory lock으로 v1 전용 등록자 작업을 직렬화한다. 등록자는 다른 프로세스에서 임의의 nonce 거래를 보내지 않는 전용 지갑이어야 한다.
2. 전송 전 중단: DB의 같은 서명 바이트를 전송한다.
3. 전송 응답 유실: 저장된 해시의 영수증부터 조회한다. 없으면 같은 바이트를 재전송한다.
4. 체인 성공 후 DB 장애: 다음 실행에서 같은 영수증·이벤트로 복구한다. 이벤트·채권·은행 대기열·작업 확정은 하나의 DB 트랜잭션이다.
5. 계약 시뮬레이션의 명확한 거절 또는 확정된 reverted 영수증만 FAILED 처리한다. RPC 오류·영수증 미발견·이벤트 불일치는 실패로 단정하지 않는다.
6. 새 nonce의 재시도는 미결 거래가 없는 FAILED 작업에서만 가능하다. 이전 거래 기록과 동일 채권 ID를 보존한다.

확정 기준은 `chain_deployment.confirmations`이며 local 기본값은 1이다. 확정 직전 블록 해시도 대조한다. 이미 DB 확정된 뒤의 깊은 체인 재구성을 되돌리는 기능, 거래 가스 대체·외부 nonce 충돌 복구는 아직 제공하지 않는다. 서명 후 거래 상태가 불명확한 작업은 후속 등록보다 먼저 처리하므로 등록자 큐가 대기할 수 있다.

거래 식별 키 v1은 납품업체 ID·구매처 ID·NFKC 정규화 후 양끝 공백을 제거한 거래번호의 해시다. 대소문자·내부 공백은 보존한다. 외부 시스템 중복·다른 거래번호로 제출한 동일 거래까지 탐지하지 않는다.

## 검증

`npm run check`는 임시 PostgreSQL과 로컬 EVM에서 정상 등록, 중복 작업·동시 워커, 이전 확인 무효화, 등록 중 수정 차단, 서명 후 중단, 전송 응답 유실, DB 반영 장애, 지갑/등록자 권한 해제, 확정 대기, 이벤트 누락, reverted 재시도를 검증한다. 기존 도메인·계약·API 테스트도 함께 실행한다. 계약 테스트만 별도 실행할 때 DB 환경이 없으면 등록 통합 suite는 제외되므로 전체 검증에는 `npm run check`를 사용한다.

## 결제 동기화

`src/settlement.ts`는 지정 Settlement 로그를 배포 블록부터 최대 500블록씩 읽는다. `settlement_cursor`까지 반영된 블록의 해시를 다음 실행 때 검사하고, 설정한 confirmation 깊이 이후의 로그만 처리한다. 지정 계약·지급 토큰·은행·6자리 단위를 검증한다.

`settlement_event`, `settlement_offer`, 채권 상태·현재 소유자·매입/상환 일시, `wallet_operation`, 커서를 한 DB 트랜잭션으로 반영한다. 장애가 나면 커서를 전진시키지 않아 재시작 시 복구한다. 미동기화 등록 채권이 있으면 기다린다. 별도 advisory lock으로 중복 워커를 직렬화한다. API 해시 통지 없이 실행된 거래도 발신자·calldata가 일치하면 찾는다.

확정된 revert와 엉뚱한 보고 해시는 작업 실패로 표시한다. 실제 자산 상태는 성공 이벤트에서만 반영한다. 깊은 reorg는 SETTLEMENT_REORG_DETECTED로 중단하고 운영자 재구축을 요구한다. 이벤트 동기화를 우회하는 DB 수정은 지원하지 않는다.

등록 키 없이 결제 조회만 실행하려면 루트에서:

```bash
npm run start -w @paidahead/worker -- --settlement-only
```

DATABASE_URL·REGISTRATION_RPC_URL·DEMO_MODE는 필요하다. 업무 API와 지갑 연결 순서는 [매입·상환 API 안내](../api/SETTLEMENT.md)를 참고한다.
