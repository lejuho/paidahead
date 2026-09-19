# Injective EVM 테스트넷 시연

로컬 시연의 성공 상태: 커밋 `6732cf0`, 태그 `demo-local-verified-20260919`.
기존 `npm run stack -- up`은 로컬 체인 31337과 포트 3000을 사용한다.
테스트넷은 별도 DB `paidahead_testnet`, 웹 3200, API 3103을 사용하며 로컬 DB·계약을 초기화하지 않는다.
인증은 여전히 로컬 전용 시연 모드다. 웹/API는 127.0.0.1에만 바인딩하고 인터넷에 공개하지 않는다.

## 준비

WSL Ubuntu-24.04의 `/home/user/paidahead`에서 Node.js 24로 실행한다.

```bash
nvm use 24
npm run check
npm run testnet -- init
npm run testnet -- status
```

`init`은 역할별 새 지갑 5개를 생성한다. 재실행해도 기존 지갑을 덮어쓰지 않는다.
기존 테스트 지갑을 쓰려면 최초 init 때 `--supplier=0x... --buyer=0x... --bank=0x...` 공개 주소를 지정한다.
Anvil/Hardhat 기본 지갑 20개와 역할 간 동일 주소는 거부한다.
개인키는 `.local/testnet/wallets.json`에 권한 0600으로 보관되고 Git에서 제외된다.
공개 주소만 보는 명령은 `npm run testnet -- addresses`이다.

## Faucet와 배포

[공식 faucet](https://testnet.faucet.injective.network/)에서 admin 주소로 테스트용 INJ를 받는다.
CAPTCHA는 사용자가 완료한다. 배포 스크립트는 최소 0.05 INJ를 확인한다.
이 값은 보수적인 시작 기준이며 실시간 가스 견적이나 보장 금액이 아니다.
admin은 배포·권한 설정·모의 토큰 발행을 담당하고, 나머지 지갑에 0.005 INJ씩 초기 가스를 제공한다.

```bash
npm run testnet -- deploy
npm run testnet -- up
```

배포 과정은 ReceivableToken, MockPaymentToken, Settlement 배포 → 등록자/업체/구매처/은행 역할 설정 → 가스 지급 → 은행·구매처에 모의 토큰 1천만원씩 발행 → 별도 DB 연결 순서다.
영수증 성공과 코드·역할을 확인하며 서명된 거래를 전송 전에 로컬 journal에 저장한다.
연결이 끊기면 같은 deploy 명령을 실행한다. 같은 거래 해시를 조회·재전송하며 새 거래를 임의로 만들지 않는다.
개인키·서명 거래가 포함된 `wallets.json`과 `journal.json`을 공유하지 않는다.
이미 revert된 단계나 다른 설정이 발견되면 자동으로 건너뛰지 않고 중단한다.
동시 실행은 command.lock으로 차단된다. 비정상 종료 후에는 기록된 PID가 종료됐는지 확인한 뒤 잠금만 해제한다.

## MetaMask 시연

1. `.local/testnet/wallets.json`의 supplier/buyer/bank 개인키를 본인 MetaMask에 직접 가져온다. 채팅에 붙여넣지 않는다.
2. http://localhost:3200 에 접속한다.
3. 각 역할을 선택하고 대응하는 MetaMask 계정으로 전환한다.
4. 지갑의 네트워크 전환 버튼으로 Injective EVM Testnet을 추가한다.
5. 기존 9단계 시연 흐름을 진행한다. 최초 allowance 승인 포함 서명은 총 5회다.
6. 채권 상세의 오퍼 거래·이벤트 링크로 탐색기 기록을 확인한다.

네트워크: 체인 ID 1439, 통화 INJ, RPC `https://k8s.testnet.json-rpc.injective.network/`, 탐색기 `https://testnet.blockscout.injective.network`.
은행·구매처·납품업체의 서명키는 API/웹/워커에 전달하지 않는다. 등록자 키는 워커에만 전달한다.
거래 해시 접수와 확정·DB 반영은 구분하며 확정 깊이는 2블록이다. 로컬의 3~5초 완료를 보장하지 않는다.

## 점검·중지

```bash
npm run testnet -- status
npm run testnet -- smoke   # 로컬에 전용 테스트 키가 모두 있을 때만: 실제 테스트넷에서 신청~상환 자동 시연
npm run testnet -- down
```

`smoke`는 새로운 가상 신청과 테스트넷 거래를 생성하며 실제 원화를 사용하지 않는다. 결과는 `.local/testnet/last-demo.json`에 저장된다.
MetaMask 팝업 검증을 대체하지 않는다. 은행/구매처 모의 토큰이 부족하면 추가 시연 전 잔액을 확인한다.
로그: `.local/testnet/api.log`, `worker.log`, `web.log`. 지갑 주소·배포 주소: `addresses.json`, `deployment.json`.
`up`은 시연 인증 토큰을 갱신한다(24시간). PC 재부팅 후에도 테스트넷 계약은 유지되므로 `--fresh`로 초기화하지 않는다.
테스트넷 체인과 DB 대응을 보존해야 하므로 `.local/testnet`과 `paidahead_testnet` DB를 함께 백업한다.

## 배포 스크립트 로컬 리허설

Hardhat의 `testnetRehearsal` 네트워크(1439)는 개발자 검증용이며 실제 테스트넷이 아니다.
127.0.0.1:18545, `.local/testnet-rehearsal`, `paidahead_testnet_rehearsal`만 사용한다.
`testnet init/status/deploy --rehearsal`이 가능하다. 서비스 실행과 smoke는 이 모드에서 차단한다.
실제 MetaMask에 이 리허설 체인을 추가하지 않는다.

## 공식 자료

- [네트워크 정보](https://docs.injective.network/developers-evm/network-information)
- [Hardhat 배포 안내](https://docs.injective.network/developers-evm/smart-contracts/deploy-hardhat)
