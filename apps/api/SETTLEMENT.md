# 은행 심사·매입·상환 API

등록 완료 채권을 은행이 심사하고 조건을 승인한 뒤, 각 참여자 지갑이 계약을 실행한다. API/워커는 은행·납품업체·구매처의 비밀키를 받지 않는다. 인증은 기존 비운영 시연용 Bearer 토큰과 `x-organization-id`를 사용한다.

## HTTP 흐름

| 메서드·경로 | 권한·역할 |
|---|---|
| GET `/bank/reviews` | 지정 은행 검토 대기열 |
| GET `/bank/reviews/:id` | 지정 은행만 원문 목록·내부 메모·검토 이력·보완·승인 조회 |
| POST `/bank/reviews/:id/decision` | BANK_REVIEWER의 START / NOTE / REQUEST_INFO / DECLINE |
| POST `/supplements/:id/response` | 해당 납품업체의 보완 설명 제출 |
| POST `/bank/supplements/:id/close` | 해당 은행이 제출된 보완을 확인하고 검토 재개 |
| POST `/bank/reviews/:id/approvals` | BANK_REVIEWER와 BANK_APPROVER를 보유한 담당자의 조건 승인 |
| GET `/receivables` | 소속 조직의 채권 목록, 최근 100개 |
| GET `/receivables/:id` | 관련 조직의 공개 심사 결과·보완·오퍼·매입·상환 이벤트 |
| POST `/receivables/:id/operations` | 업무 권한에 맞는 서명용 거래 생성 |
| GET `/receivables/:id/operations` | 호출 조직이 만든 작업만 최근 20개(id·kind·status·해시). 새로고침 후 미결 작업 복구용 |
| GET `/operations/:id` | 생성 조직의 작업 상태·서명용 거래 |
| GET `/operations/:id/preflight` | 해당 작업의 체인 시뮬레이션·가스·모의 토큰 잔액·사용 승인 |
| POST `/operations/:id/transaction` | 지갑이 반환한 거래 해시 통지 |
| POST `/operations/:id/reject` | 아직 해시를 통지하지 않은 지갑 서명 요청 거절 표시 |

기존 GET `/documents/:id/content`는 은행 검토 대상으로 등록된 채권의 문서에만 BANK_REVIEWER 접근을 허용한다. 내부 메모와 검토 이력은 은행 상세에서만 반환한다. 보완은 추가 설명으로 처리하며, 등록된 금액·만기·문서 버전을 수정하지 않는다. 추가 파일 업로드는 아직 없다.

### 1. 심사와 조건 승인

검토 시작:

```json
{"expectedVersion":1,"action":"START","internalNote":"가상 거래 자료 검토"}
```

보완 요청은 `action: "REQUEST_INFO"`, 매입 불가는 `action: "DECLINE"`이며 두 경우 모두 `publicMessage`가 필요하다. 보완 요청은 검토를 NEEDS_INFO로 바꾸고, 업체가 `{"response":"추가 설명"}`을 제출하면 은행이 close API로 확인한다. 검토는 IN_REVIEW로 복귀한다.

승인 요청 예시(유효기간은 현재 이후·채권 만기 이전의 ISO 시각):

```json
{"expectedVersion":2,"purchaseAmountKrw":"2970000","expiresAt":"2026-09-20T12:00:00Z"}
```

검토자와 승인자를 각각 기록하며 시연 seed 사용자는 두 역할을 겸임한다. 검토 버전이 다르면 STALE_REVIEW, 미검토·보완 중·매입 불가는 승인 불가다. 미사용 유효 승인 또는 활성 오퍼가 있으면 다른 조건 승인을 막는다. 오퍼 철회·만료 뒤에는 새 조건 승인이 가능하다. 승인 레코드와 승인 해시는 변경할 수 없다.

### 2. 서명용 작업 준비

`idempotencyKey`는 클라이언트에서 생성한 UUID다. 같은 조직·키·요청은 동일 거래와 작업을 반환하며, 같은 키로 다른 요청을 보내면 409다. 같은 미결 calldata를 새 키로 중복 생성하면 OPERATION_IN_PROGRESS다.

```json
{"idempotencyKey":"UUID","kind":"CREATE_OFFER","approvalId":"승인 UUID"}
```

| kind | 요청 추가 필드 | 서명 지갑 |
|---|---|---|
| CREATE_OFFER | approvalId | 지정 은행 |
| WITHDRAW_OFFER | offerId (DB UUID) | 지정 은행 |
| ACCEPT_OFFER | offerId (DB UUID) | 현재 납품업체 |
| REPAY | 없음 | 지정 구매처 |
| CANCEL | 없음 | 매입 전 납품업체 |

응답의 `transaction`에는 `chainId`, `from`, `to`, `data`, `value: "0x0"`, `type: "legacy"`가 있다. 금액은 API에서 원 단위 문자열, ERC-20에서는 원 × 10^6이다. 지갑 전송 시 value는 bigint 0으로 변환하고, 올바른 네트워크·from을 확인한 뒤 가스 추정과 gasPrice를 사용한다.

CREATE_OFFER에는 은행의 매입금액, REPAY에는 구매처의 액면금액에 대한 ERC-20 `paymentApproval` 거래도 반환한다. 사용 승인 거래를 필요 시 먼저 서명하고 영수증을 확인한다. 은행이 오퍼를 등록했다고 자금이 예약되지는 않으며, 매입 시 은행 잔액·allowance가 다시 검사된다. ACCEPT_OFFER는 업체 지갑으로 서명하지만 자금 제공자는 은행이다.

`preflight`의 payment에는 `requiredRaw`, `balanceRaw`, `allowanceRaw`, 충분 여부가 포함된다. simulation은 OK 또는 CONTRACT_REJECTED다. RPC 미설정·장애는 503으로 구분한다. 이 조회는 자금을 예약하거나 이후 실행 성공을 보장하지 않는다. 프론트는 실제 전송 직전 다시 검사한다.

### 3. 전송·조회·복구

지갑 전송 후:

```json
{"transactionHash":"0x...64자리..."}
```

이를 POST `/operations/:id/transaction`에 전달하면 PENDING이다. 이 시점에는 채권의 매입·상환 상태가 바뀌지 않는다. 워커가 지정 계약 로그·성공 영수증·발신자·calldata·금액·당사자·확정 블록을 확인해야 CONFIRMED와 업무 상태가 함께 반영된다.

- API에 해시를 알리지 못해도 워커가 체인 로그와 준비된 거래를 매칭한다.
- 지갑 거절 표시는 거래 취소가 아니다. 이후 실제 실행이 발견되면 체인 결과를 반영한다.
- 모르는 해시·RPC 장애는 PENDING으로 유지한다. 확정 revert는 FAILED / TRANSACTION_REVERTED다.
- 엉뚱한 해시는 FAILED / TRANSACTION_MISMATCH다. 사용자가 알려 준 해시만으로 자산 상태를 변경하지 않는다.
- 실패 후에는 새 idempotencyKey로 작업을 만들고 현재 상태를 다시 검사한다. PENDING을 임의로 재전송하거나 새 nonce로 대체하지 않는다.
- 계약에서 직접 등록된 미승인 참조 오퍼도 조회에 반영하지만 `approval_id`가 null이고 API 수락은 차단한다. 승인 지갑이 API를 우회한 실제 계약 실행 결과는 원장 사실대로 반영한다. 계약 자체가 오프체인 은행 승인을 증명하지는 않는다.
- 연체는 PURCHASED + 만기 경과에서 파생한다. 부분 상환은 없고, 은행의 신규 매입 권한이 철회되어도 기존 채권의 전액 수취는 유지한다.

## 로컬 실행

[워커 실행 안내](../worker/README.md)에 따라 DB, 로컬 체인, API, 워커를 실행한 다음:

```bash
npm run demo:settlement
```

HTTP 신청부터 등록·심사·조건 승인·실제 로컬 서명·매입·상환까지 진행한다. 공개 Hardhat 테스트 계정을 loopback chain 31337에서만 사용하며 필요한 가상 지급 토큰을 발행한다. 실제 네트워크에서 실행할 수 없다.

새 DB는 `npm run db:migrate`, `npm run db:seed`, `npm run chain:setup`으로 설정한다. 기존 DB는 `003_settlement.sql`까지 적용해야 한다. 이전 chain:setup이 만든 배포에는 Settlement·모의 토큰·은행 지갑 연결이 없으므로 해당 배포의 실제 주소를 운영자가 검증해 채우거나 새 시연 DB/로컬 체인에서 시작한다. 기존 활성 배포를 자동으로 덮어쓰지 않는다.

## 검증·남은 범위

`npm run check`에 은행 API와 PostgreSQL·로컬 EVM 연동 테스트가 포함된다. 실제 HTTP API와 RPC 경유 서명으로 `demo:settlement`도 실행한다. [로컬 시연 웹](../web/README.md)은 이 API를 그대로 사용한다. 목록 응답에는 화면용 `title`·조직명이 추가되었다. 실제 인증, 파일 업로드·AI, 공개 테스트넷 배포 및 깊은 reorg 이후 자동 재구축은 별도 단계다.
