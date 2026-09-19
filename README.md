# PaidAhead

가상 납품 거래의 매출채권 등록·조기 매입·전액 상환 시제품. **구매처 확인 → 채권 등록 → 은행 심사·조건 승인 → 지갑 서명 → 매입·전액 상환 → DB 동기화**까지 연결했고, 세 역할이 각자의 화면과 지갑으로 이 흐름을 끝내는 [로컬 시연 웹](apps/web/README.md)을 제공한다. 실제 인증·파일 업로드·AI 분석·공개 테스트넷 배포는 이후 단계다.

## 실행

Node.js 24 이상과 npm을 사용한다.

```bash
npm ci
npm run check
npm run demo -w @paidahead/contracts
```

`check`는 전체 빌드·타입 검사와 도메인·계약·PostgreSQL API 테스트를 실행한다. API 테스트에는 로컬 PostgreSQL 서버 도구 또는 `TEST_DATABASE_URL`이 필요하다. `demo`는 매번 새 로컬 체인에서 액면 300만원 채권을 297만원에 매입하고 만기에 300만원을 상환한다. 종료 후 체인 상태는 남지 않는다. 외부 네트워크 배포·실제 자금·비밀키는 사용하지 않는다.

**브라우저 시연(역할별 화면·지갑 연결)의 실행 순서·지갑 설정·시연 절차는 [웹 안내](apps/web/README.md)를 따른다.** Docker가 없으면 `npm run db:local`로 PostgreSQL을 띄운다.

DB·API 실행과 HTTP 시연은 [구매처 확인 API 안내](apps/api/README.md)를 참고한다.

구매처 확인부터 실제 로컬 채권 발행까지는 [등록 워커 안내](apps/worker/README.md)의 `chain:local` → `chain:setup` → `worker:start` → `demo:registration` 순서로 실행한다. API도 실행한 상태에서 `npm run demo:settlement`로 은행 심사부터 매입·상환까지 시연한다. 프론트 연동 명세는 [은행·매입·상환 API](apps/api/SETTLEMENT.md)를 참고한다.

## 구성

| 위치 | 내용 |
|---|---|
| `packages/domain` | 업무 상태, 계약 역할 ID, 정수 금액 변환, 확인 스냅샷 해시 |
| `packages/database` | PostgreSQL 마이그레이션·트랜잭션·가상 데이터·문서 |
| `apps/api` | Fastify 기반 신청·구매처 확인·은행 심사·조건 승인·지갑 거래·실행 전 점검 API |
| `apps/web` | Next.js 역할별 화면, 서버측 시연 인증 브리지, viem 지갑 연결·거래 상태 추적, 브라우저 E2E |
| `apps/worker` | 등록자 처리, 오퍼·매입·상환·취소 이벤트 동기화, DB 복구 |
| `contracts/src/ReceivableToken.sol` | 등록자 발행, 제한 이전 ERC-721, 채권 상태·식별자 보존 |
| `contracts/src/Settlement.sol` | 지정 은행 제안, 원자적 매입, 취소, 전액 상환 |
| `contracts/src/MockPaymentToken.sol` | 6자리 소수의 시연용 ERC-20 |
| `contracts/test` | 권한·실패 원복·중복 처리·만기 경계 시나리오 |
| `contracts/scripts/demo.ts` | 로컬 전체 흐름 시연 |

## 구현 결정

- 금액은 계약에 **원 단위 정수**로 전달한다. ERC-20 이전에서만 `원 × 10^6`으로 변환한다. 도메인과 계약의 최대 액면금액은 PostgreSQL signed bigint 범위다.
- 채권 상태: NONE(0), REGISTERED(1), PURCHASED(2), REPAID(3), CANCELLED(4). NONE은 아직 등록되지 않은 계약 조회 결과다.
- 제안 상태: NONE(0), ACTIVE(1), WITHDRAWN(2), EXPIRED(3), ACCEPTED(4), INVALIDATED(5). 오프체인 DRAFT는 계약에 없는 상태다.
- 채권은 ERC-721이지만 일반 이전·승인·재매각을 차단한다. 최초 설정한 결제 계약만 채권 이전과 종료 상태를 바꿀 수 있다. 취소·상환 시 토큰과 거래 식별자를 보존한다.
- 지정 은행 주소와 BANK_ROLE을 함께 확인한다. 구매처·납품업체 역할과 등록자 역할도 별도다. 관리자에게 발행 권한을 자동 부여하지 않는다.
- 승인된 등록자가 구매처 확인을 검증한 후 해시와 함께 등록하는 신뢰 모델이다. **0이 아닌 해시는 실제 구매처 확인의 증명이 아니다.** 버전·동의·문서 확인은 API/등록 워커가 검증한다. 은행의 승인 참조 해시도 같은 한계를 가진다.
- 은행 매입 권한 철회는 신규 매입을 막지만 기존 보유 채권 수취 권리는 없애지 않는다. 지급자는 지정된 승인 구매처이며 부분 상환은 지원하지 않는다.
- v1 가정: 동일 지갑의 자전 납품 금지, `0 < 매입금액 <= 액면금액`, 제안 만료 < 만기, 조기·만기 후 전액 상환 허용. 이 정책들은 은행 실무 정책이 아니다.
- 모의 토큰과 결제 계약은 배포 시 고정한다. 수수료 차감·리베이스·콜백이 있는 임의 외부 토큰은 지원 대상이 아니다.

## 빌드와 연동

Solidity 0.8.28과 OpenZeppelin 5.4.0, Hardhat 3·viem을 고정 버전으로 설치하고 lockfile을 관리한다. npm의 로컬 solc를 사용해 빌드 때 별도 컴파일러 다운로드를 요구하지 않는다. 현재 EVM 컴파일 타깃은 `paris`이며 Injective 테스트넷 실행 호환성은 실제 배포 전에 별도로 검증한다.

ABI와 타입은 `npm run build` 후 `contracts/artifacts`에 생성된다. `ReceivableRegistered`, `OfferCreated`, `OfferClosed`, `Settled`, `Repaid`, `Cancelled`, `ReceivableStatusChanged`를 등록·결제 동기화의 근거로 사용한다. 이벤트와 성공 영수증을 함께 검사해야 하며, 서명·제출만으로 DB를 완료 처리하지 않는다.

스냅샷 직렬화 v1은 `packages/domain`의 `hashSnapshot`을 기준으로 한다. 문서는 ID순 정렬, SHA-256 해시는 소문자, 금액·Unix 초는 정수 문자열로 고정한다. 현재 API는 수동 검토 품목·메모를 정해진 JSON 순서로 해시하고 확인 버전과 함께 동결한다. AI 근거와의 연결은 후속 단계다.

로컬 테스트 통과는 실제 은행 업무나 배포 계약 보안 검증을 대체하지 않는다. 공개 테스트넷 배포와 운영 키 관리는 아직 수행하지 않았다. 설정한 확정 깊이와 블록 해시를 검사하고, 결제 동기화는 깊은 reorg를 탐지하면 중단한다. 자동 원장 재구축은 후속 범위다.

## 설계 문서·참고

- [기능명세서](PaidAhead_기능명세서_v1.md)
- [제안 요약서](proposal_digest.md)
- [ERD](ERD.md)
- [컴포넌트 구조](COMPONENT_ARCHITECTURE.md)
- [Hardhat의 viem 테스트 안내](https://hardhat.org/docs/guides/testing/using-viem)
- [OpenZeppelin ERC-721](https://docs.openzeppelin.com/contracts/5.x/erc721)
- [Injective EVM 네트워크 정보](https://docs.injective.network/developers-evm/network-information)

## Injective 테스트넷

별도 지갑·DB·포트로 실행하는 절차는 [테스트넷 안내](TESTNET.md)를 참고한다. `npm run testnet -- status`로 연결과 잔액을 확인한다. 실제 배포 성공 여부는 `.local/testnet/deployment.json`과 온체인 영수증으로 확인한다.
