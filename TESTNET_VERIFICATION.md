# Injective 테스트넷 배포·검증 결과

2026-09-19 실제 Injective EVM Testnet(1439)에 배포했다. 로컬 리허설과 구분되는 공개 테스트넷 결과다.

- 웹: http://localhost:3200
- API: http://127.0.0.1:3103
- DB: paidahead_testnet
- 확정 깊이: 2블록

## 계약

- receivable: [0xede8d93d423e5dfed7ca7a880a76b2ec3643f66a](https://testnet.blockscout.injective.network/address/0xede8d93d423e5dfed7ca7a880a76b2ec3643f66a)
- payment: [0xe9f560a40b32c561b01a9c6b14daaff1f4118b31](https://testnet.blockscout.injective.network/address/0xe9f560a40b32c561b01a9c6b14daaff1f4118b31)
- settlement: [0x1145007f807cc92f870b744dd804d7cc72def15c](https://testnet.blockscout.injective.network/address/0x1145007f807cc92f870b744dd804d7cc72def15c)

## 전체 거래 검증

가상 신청 → 구매처 확인 → 등록 워커 발행 → 은행 승인·오퍼 → 매입 → 전액 상환을 실제 HTTP/API와 테스트 전용 지갑 서명으로 실행했다.

- 채권 ID: `6e7eec51-b8b2-46e4-b25c-bc751b0ca2bc`
- 최종 DB 상태: `REPAID`
- 액면: 3,000,000원 상당 모의 토큰
- 매입: 2,970,000원 상당 모의 토큰
- offerTransaction: [0x65de1ccf913bbf4fbbf04fb31072b0235db12e4e66101e8d221305fa7695bb94](https://testnet.blockscout.injective.network/tx/0x65de1ccf913bbf4fbbf04fb31072b0235db12e4e66101e8d221305fa7695bb94)
- purchaseTransaction: [0xfd10cf18212c76c3a9b3570b0c71a923f969fd0205b9ae5d9b128880f5aadfb7](https://testnet.blockscout.injective.network/tx/0xfd10cf18212c76c3a9b3570b0c71a923f969fd0205b9ae5d9b128880f5aadfb7)
- repaymentTransaction: [0xda6aed40c8c40170ad1988ada8a33072903446362baf9185b58cb9fd29370504](https://testnet.blockscout.injective.network/tx/0xda6aed40c8c40170ad1988ada8a33072903446362baf9185b58cb9fd29370504)

이번 자동 검증은 MetaMask 확장 팝업 검증을 대체하지 않는다. 사용자는 별도 테스트넷 지갑을 가져와 3200번 화면에서 실제 MetaMask 네트워크 전환·서명을 확인할 수 있다. 지갑 가져오기와 실행 방법은 [TESTNET.md](TESTNET.md)를 참고한다.

3100 포트에 이미 실행 중인 개발 서버가 있어 테스트넷 웹 포트를 3200으로 옮겼다. 기존 서버는 중지하지 않았다.

## 추가 확인

- 브라우저의 은행 포트폴리오에서 상환 완료 1건 표시를 확인했다.
- 온체인 모의 토큰 잔액: 납품업체 2,970,000, 구매처 7,000,000, 은행 10,030,000 mKRW. 초기 은행·구매처 잔액 각 10,000,000을 기준으로 매입·상환 결과와 정확히 일치했다.
