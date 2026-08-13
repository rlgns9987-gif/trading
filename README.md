# 마켓 보드

국내외 시장 지표를 한눈에 보는 반응형 단일페이지 대시보드.
GitHub Actions가 1분마다 데이터를 수집해 `public/data/latest.json`을 갱신하고,
Vercel은 `public/`을 정적 사이트로 서빙합니다. 프론트엔드가 서버 없이
그 JSON만 60초마다 다시 읽어와 화면을 그리는 구조입니다.

## 폴더 구조

```
scripts/
  collect.js            # 메인 수집 스크립트 (GitHub Actions가 실행)
  fetchers/
    kis.js               # 한국투자증권 API (일부 TODO 있음, 아래 참고)
    yahoo.js              # 해외 지수/금리/원자재/환율/VIX (Yahoo Finance)
    crypto.js             # BTC/ETH (Binance)
  lib/
    history.js            # 전일/20일 동시간 평균 대비 계산용 이력 저장
public/
  index.html / style.css / app.js   # 프론트엔드 (정적 파일)
  data/latest.json         # 매 실행마다 갱신되는 최신 데이터
  data/history/            # 날짜별 스냅샷 (수급·거래대금 비교용)
.github/workflows/update-data.yml   # 1분 주기 수집 워크플로우
```

## 시작하기 전 반드시 해야 할 일

### 1. KOSPI200 야간선물 종목코드는 만기마다 갱신 필요

`scripts/fetchers/kis.js`의 4개 KIS 함수(수급, 거래대금상위, 금리, 야간선물)는 모두
실제 값으로 완성되어 있어 바로 동작합니다.

다만 `getKospi200NightFutures()` 안의 `KOSPI200_NIGHT_FUTURES_CODE`는 **만기(3/6/9/12월)마다
바뀌는 값**이라 자동으로 갱신되지 않습니다. 지금은 2026년 9월물(`A01609`)로 채워져
있고, 다음 월물(`A01612`, 2026년 12월물)로 롤오버되면 이 값을 직접 바꿔주셔야
합니다. 확인 방법: KIS Developers 포털 > 종목정보파일 > 선물옵션 종목마스터파일을
다시 받아 KOSPI200 선물 최근월물 코드를 확인하면 됩니다.

### 2. GitHub 저장소 준비

1. 이 프로젝트를 GitHub 저장소로 push
2. 저장소 Settings → Secrets and variables → Actions에서 등록:
   - `KIS_APP_KEY`, `KIS_APP_SECRET` (Secrets)
   - `KIS_IS_PAPER` (Variables, 모의투자면 `true`)
3. Settings → Actions → General에서 워크플로우 쓰기 권한(Read and write permissions) 허용
   — 워크플로우가 데이터를 커밋·push 하기 때문에 필요합니다.

**중요:** 1분마다 실행되면 하루 1,440회 실행됩니다. **Private 저장소는 무료 Actions
사용량(월 2,000분)을 며칠 내 소진**할 수 있습니다. Public 저장소로 두면 Actions
사용량이 무제한이라 이 구조에 더 적합합니다. Private을 유지하고 싶다면 cron
주기를 늘리는 것도 고려하세요.

### 3. Vercel 배포

1. Vercel에서 이 저장소를 Import
2. Framework Preset: Other / Build Command 비움 / Output Directory: `public`
   (레포에 포함된 `vercel.json`이 자동으로 이 설정을 적용합니다)
3. 배포 후 GitHub Actions가 `public/data/latest.json`을 갱신하면, Vercel도
   해당 커밋을 감지해 재배포하며 최신 데이터를 반영합니다.

## 로컬에서 테스트하기

```bash
cp .env.example .env   # 값 채우기
node --env-file=.env scripts/collect.js   # public/data/latest.json 생성 확인
npx serve public                            # 프론트엔드 로컬 확인
```

## 알려진 제약

- Yahoo Finance는 비공식 API라 언제든 응답 형식이 바뀔 수 있습니다. 문제가 생기면
  `scripts/fetchers/yahoo.js`만 교체하면 됩니다.
- GitHub Actions의 분 단위 cron은 부하 상황에 따라 몇 분 지연될 수 있습니다
  (공식적으로 "정확히 매분"을 보장하지 않습니다).
- KIS 접근토큰은 `actions/cache`로 런(run) 사이에 재사용하지만, 캐시가 만료되거나
  삭제되면 새로 발급됩니다. 토큰을 짧은 주기로 반복 발급하면 일시적으로 제한이
  걸릴 수 있다는 안내가 있으니, 첫 실행 후 정상 동작하는지 확인하세요.
