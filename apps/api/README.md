# 구매처 확인 API — 로컬 시연

현재 범위는 **DB·수동 검토·구매처 확인·등록·은행 심사·매입·상환 연결**이다. 등록 워커가 계약 성공을 검증하면 채권 등록 완료와 은행 대기열에 반영한다. 은행 판단·지갑 거래·결제 API는 [별도 연동 문서](SETTLEMENT.md)에 정리했다. 업로드/OCR/LLM과 실제 인증 제공자는 후속 단계다. 구매처 확인 CONFIRMED 자체는 온체인 등록 완료가 아니다.

## 실행

저장소 루트에서 실행한다. PostgreSQL은 로컬 포트 `54329`, API는 `3003`을 사용한다.

```bash
npm ci
npm run build
cp .env.example .env
docker compose up -d --wait postgres
npm run db:migrate
npm run db:seed
npm run dev:api
```

다른 터미널에서 `npm run demo:api`를 실행하면 신청 생성→수동 검토→확인 요청→구매처 확인을 실제 HTTP로 실행한다. 등록 워커가 없으면 `chainRegistration: NOT_SUBMITTED` 상태로 대기한다. 발행까지 실행하려면 [등록 워커 안내](../worker/README.md)를 따른다. 직접 실행한 PostgreSQL 16 이상을 사용하려면 `.env`의 `DATABASE_URL`을 변경한다.

마이그레이션은 트랜잭션·잠금·체크섬을 사용한다. 적용된 SQL 변경은 금지하고 다음 번호의 마이그레이션으로 변경한다.

## 시연 인증·데이터

- `DEMO_MODE=true`가 필요하며 `NODE_ENV=production`에서는 실행을 거부한다. 서버는 127.0.0.1에만 바인딩한다.
- seed는 가상 업체·구매처·은행, 사용자·지갑·문서 3개를 만든다. 재실행해도 기존 업무 데이터·승인 상태를 덮어쓰지 않는다.
- 무작위 시연 토큰은 DB에 SHA-256 해시만 저장한다. 원문은 git에서 제외한 `.local/demo-access.json`에 권한 600으로 저장한다. 유효기간은 24시간이며 만료 시 seed를 재실행한다.
- 요청 헤더: `Authorization: Bearer <token>`, `X-Organization-Id: <조직 UUID>`. DB 소속·업무 역할·조직 승인 상태를 다시 검사한다.
- 지갑은 `DEMO_ONLY` 예시 주소다. 개인키나 계약 역할 승인 완료를 의미하지 않는다.
- 증빙은 `packages/database/fixtures`의 가상 텍스트다. 파일 해시를 검증하고 권한 검사 후 제공한다. 객체 저장소 업로드는 후속 단계다.

## 엔드포인트

| 메서드·경로 | 권한 | 동작 |
|---|---|---|
| GET `/health` | 공개 | DB 연결 확인 |
| GET `/me` | 활성 구성원 | 사용자·선택 조직·역할·승인된 조직 지갑(`wallets`, DEMO_ONLY 제외)·`authMode: "DEMO"` |
| GET `/chain` | 활성 구성원 | 활성 배포의 체인 ID·계약 주소. 없으면 409 SETTLEMENT_NOT_CONFIGURED |
| GET `/applications` | 납품업체 | 본인 조직 신청 목록(현재 버전·최근 확인·등록·채권 상태), 최근 100개 |
| GET `/demo/catalog` | 활성 구성원 | 가상 조직·본인 조직 문서 목록 |
| POST `/applications` | 납품업체 | DRAFT 버전 1 생성 |
| GET `/applications/:id` | 소유 납품업체 | 현재 버전 + `confirmation`(현재 버전의 최근 확인)·`documents`·조직명. `id`는 신청 ID, 버전 ID는 `revision_id` |
| POST `/applications/:id/revisions` | 소유 납품업체 | 새 버전 생성·기존 확인 무효화 |
| POST `/applications/:id/review` | 소유 납품업체 | 합계·미해결 이슈 검사 후 수동 검토 완료 |
| POST `/applications/:id/confirmations` | 소유 납품업체 | 동의 저장·버전 동결·확인 요청 |
| GET `/confirmations?limit=20&offset=0` | 구매처 | 본인 조직 요청 목록 |
| GET `/confirmations/:id` | 지정 구매처 | 확인 버전·금액·근거·문서 메타데이터 |
| GET `/documents/:id/content` | 소유 업체·관련 구매처 | 권한 있는 원문 조회 |
| POST `/confirmations/:id/decision` | 지정 구매처 | 납품·지급 의무 확인 또는 반려 |
| POST `/confirmations/:id/withdraw` | 소유 납품업체 | PENDING 요청 철회 |

신청 생성 입력(조직·문서 ID는 seed 결과 사용):

```json
{
  "buyerOrgId": "10000000-0000-4000-8000-000000000002",
  "targetBankOrgId": "10000000-0000-4000-8000-000000000003",
  "tradeReference": "INV-DEMO-001", "title": "가상 식자재 납품",
  "faceAmountKrw": "3000000", "dueAt": "2027-01-01T00:00:00+09:00",
  "documentIds": ["40000000-0000-4000-8000-000000000001", "40000000-0000-4000-8000-000000000002", "40000000-0000-4000-8000-000000000003"]
}
```

만기는 실행 시점 이후로 지정한다. 금액은 정수 문자열, 만기는 시간대가 있는 ISO 8601 초 단위다. 새 revision은 같은 입력에 `expectedRevision`을 추가한다.

수동 검토 입력:

```json
{ "expectedRevision": 1, "items": [{ "name": "식자재 세트", "quantity": 100, "unitPriceKrw": "30000" }], "note": "시연 서류 수동 검토 완료" }
```

확인 요청 입력:

```json
{ "expectedRevision": 1, "consent": true, "consentVersion": "v1" }
```

구매처 확인 입력(응답의 `snapshot_hash` 사용):

```json
{ "decision": "CONFIRM", "snapshotHash": "0x<확인 대상 해시 64자리>", "deliveryAcknowledged": true, "paymentObligationAcknowledged": true }
```

반려는 `{ "decision": "REJECT", "snapshotHash": "...", "reason": "수량 확인 필요" }`다. 확인 리소스 응답은 현재 DB 기반 snake_case이며 금액은 문자열, 시각은 ISO 8601로 반환한다.

## 불변성·동시성

- 신청 행 잠금으로 버전·확인 변경을 직렬화한다. 같은 버전 동시 수정은 한 건만 성공한다.
- 동일 버전 확인 요청은 기존 PENDING/CONFIRMED를 반환한다. 동일 결정 재요청은 감사 로그를 중복 생성하지 않는다.
- 확인·철회 경합은 하나만 성공한다. 새 버전 생성과 기존 확인 INVALIDATED 처리는 같은 트랜잭션이다.
- 동결 버전·첨부 목록·원문 메타데이터·감사 로그는 DB 트리거로 보호한다. 확인 버전·구매처·해시는 복합 FK로 연결한다.
- 반려·철회 후 재요청은 새 버전·재검토를 요구하는 기본안이다.
- 등록 워커도 같은 신청 잠금을 사용한다. 예약 이후 새 버전 생성은 REGISTRATION_LOCKED로 차단한다. 워커는 스냅샷과 현재 참여자 승인을 다시 검증하며, 영수증·이벤트 확인 후에만 등록 완료로 표시한다.

에러는 `{ "error": "STALE_REVISION" }` 형식이다. 잘못된 입력 400, 인증 실패 401, 권한 없음 403, 접근 불가 리소스 404, 상태 경합 409다. DB 내부 오류는 응답에 노출하지 않는다.

## 검증

```bash
npm run test:api
```

로컬 `initdb`, `pg_ctl`, `pg_config`가 있으면 임시 DB·Unix 소켓을 생성하고 테스트 후 제거한다. 도구가 없으면 테스트 DB를 명시한다.

```bash
TEST_DATABASE_URL=postgresql://paidahead:paidahead_local_only@127.0.0.1:54329/paidahead npm run test:api
```

각 테스트는 무작위 schema만 생성·삭제한다. DB 전체 초기화는 하지 않는다. PostgreSQL이 없으면 테스트를 건너뛰지 않고 실패한다. 전체 `npm run check`에도 포함된다.

참고: [Fastify 테스트](https://fastify.dev/docs/latest/Guides/Testing/), [node-postgres 트랜잭션](https://node-postgres.com/features/transactions), [PostgreSQL 잠금](https://www.postgresql.org/docs/current/explicit-locking.html).

은행 심사·보완·조건 승인·서명용 거래·잔액 점검·매입·상환 연결은 [은행·매입·상환 API](SETTLEMENT.md)에 정리했다. 전체 연동 검증은 `npm run check`, HTTP 전체 시연은 `npm run demo:settlement`다.
