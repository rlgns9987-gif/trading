// scripts/fetchers/kis.js
// 한국투자증권(KIS Developers) API 연동 모듈
//
// ⚠️ 중요: 아래 TR_ID 중 일부는 KIS Developers 포털(apiportal.koreainvestment.com)의
// "국내주식 > 시세/순위분석" 문서에서 반드시 재확인 후 채워 넣으셔야 합니다.
// 확실하게 검증된 항목(토큰 발급, 현재가 시세, 지수 시세)은 바로 동작하지만,
// 시장별 수급(투자자매매동향)과 거래대금 상위 종목, 국내선물/채권 API는
// TR_ID와 파라미터가 계정/문서 버전에 따라 달라질 수 있어 TODO로 표시해두었습니다.

import fs from "fs";
import path from "path";

const IS_PAPER = process.env.KIS_IS_PAPER === "true";
const DOMAIN = IS_PAPER
  ? "https://openapivts.koreainvestment.com:29443"
  : "https://openapi.koreainvestment.com:9443";

const APP_KEY = process.env.KIS_APP_KEY;
const APP_SECRET = process.env.KIS_APP_SECRET;

const TOKEN_CACHE_PATH = path.resolve(".kis-token-cache.json");

// ---------------------------------------------------------------------------
// 1. 인증 토큰 발급/캐싱
//    KIS는 토큰을 짧은 주기로 재발급하면 제한이 걸릴 수 있어(1일 1회 권장),
//    GitHub Actions의 actions/cache로 .kis-token-cache.json 파일을 런(run) 간에
//    재사용하도록 워크플로우(update-data.yml)에서 캐시 처리합니다.
// ---------------------------------------------------------------------------
async function getAccessToken() {
  if (fs.existsSync(TOKEN_CACHE_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, "utf-8"));
      // 만료 10분 전까지는 캐시된 토큰 재사용
      if (cached.expiresAt && Date.now() < cached.expiresAt - 10 * 60 * 1000) {
        return cached.accessToken;
      }
    } catch {
      // 캐시 파일이 손상된 경우 무시하고 새로 발급
    }
  }

  const res = await fetch(`${DOMAIN}/oauth2/tokenP`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: APP_KEY,
      appsecret: APP_SECRET,
    }),
  });

  if (!res.ok) {
    throw new Error(`KIS 토큰 발급 실패: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const expiresAt = Date.now() + Number(data.expires_in) * 1000;

  fs.writeFileSync(
    TOKEN_CACHE_PATH,
    JSON.stringify({ accessToken: data.access_token, expiresAt }, null, 2)
  );

  return data.access_token;
}

// KIS API는 초당 호출 건수 제한이 있어, 여러 함수가 동시에 호출돼도
// 실제 HTTP 요청은 최소 300ms 간격을 두고 순차적으로 나가도록 스로틀링합니다.
const MIN_CALL_INTERVAL_MS = 300;
let lastCallAt = 0;
let throttleChain = Promise.resolve();

function throttle() {
  const result = throttleChain.then(async () => {
    const wait = lastCallAt + MIN_CALL_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCallAt = Date.now();
  });
  throttleChain = result.catch(() => {});
  return result;
}

async function kisGet(pathname, trId, params) {
  const token = await getAccessToken();
  const url = new URL(DOMAIN + pathname);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  await throttle();

  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      appkey: APP_KEY,
      appsecret: APP_SECRET,
      tr_id: trId,
      custtype: "P",
    },
  });

  if (!res.ok) {
    throw new Error(`KIS API 호출 실패 (${trId}): ${res.status} ${await res.text()}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// 2. 국내 지수 시세 (검증됨) — 코스피 0001 / 코스닥 1001 / 코스피200 2001
// ---------------------------------------------------------------------------
export async function getIndexPrice(indexCode) {
  const data = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-index-price",
    "FHPUP02100000",
    { FID_COND_MRKT_DIV_CODE: "U", FID_INPUT_ISCD: indexCode }
  );
  const o = data.output || {};
  return {
    value: Number(o.bstp_nmix_prpr),
    change: Number(o.bstp_nmix_prdy_vrss),
    changeRate: Number(o.bstp_nmix_prdy_ctrt),
  };
}

// ---------------------------------------------------------------------------
// 3. 개별 종목 현재가 (검증됨)
// ---------------------------------------------------------------------------
export async function getStockPrice(code) {
  const data = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-price",
    "FHKST01010100",
    { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code }
  );
  const o = data.output || {};
  return {
    name: o.hts_kor_isnm,
    price: Number(o.stck_prpr),
    changeRate: Number(o.prdy_ctrt),
    tradingValue: Number(o.acml_tr_pbmn), // 누적 거래대금(원)
  };
}

// ---------------------------------------------------------------------------
// 4. 시장별 투자자매매동향 (코스피/코스닥/선물 수급: 개인·기관·외국인 순매수) — 완성됨
//    TR_ID: FHPTJ04030000 / URL: /uapi/domestic-stock/v1/quotations/inquire-investor-time-by-market
// ---------------------------------------------------------------------------
const MARKET_CODE_MAP = {
  KOSPI: { iscd: "KSP", iscd2: "0001" },
  KOSDAQ: { iscd: "KSQ", iscd2: "1001" },
  FUTURES: { iscd: "K2I", iscd2: "F001" }, // 지수선물(코스피200 선물)
};

export async function getMarketInvestorTrend(marketCode) {
  const codes = MARKET_CODE_MAP[marketCode];
  if (!codes) throw new Error(`알 수 없는 marketCode: ${marketCode}`);

  const data = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-investor-time-by-market",
    "FHPTJ04030000",
    { FID_INPUT_ISCD: codes.iscd, FID_INPUT_ISCD_2: codes.iscd2 }
  );

  // 응답 output은 배열 형태 (Example 기준 원소 1개)
  const o = (data.output && data.output[0]) || {};

  // *_ntby_tr_pbmn = 순매수 거래대금. 개인/외국인은 개별 필드, 기관은 "기관계"(orgn_*)를 사용합니다.
  return {
    individual: Number(o.prsn_ntby_tr_pbmn),
    institution: Number(o.orgn_ntby_tr_pbmn),
    foreign: Number(o.frgn_ntby_tr_pbmn),
  };
}

// ---------------------------------------------------------------------------
// 5. 거래대금 상위 종목 (코스피/코스닥 각 5종목) — 완성됨
//    TR_ID: FHPST01710000 / URL: /uapi/domestic-stock/v1/quotations/volume-rank
//    FID_BLNG_CLS_CODE="3"(거래금액순)으로 정렬, FID_INPUT_ISCD에 업종코드(0001=코스피,
//    1001=코스닥)를 넣어 시장을 구분합니다.
// ---------------------------------------------------------------------------
const TOP_VALUE_MARKET_ISCD = { KOSPI: "0001", KOSDAQ: "1001" };

export async function getTopTradingValueStocks(marketCode) {
  const iscd = TOP_VALUE_MARKET_ISCD[marketCode];
  if (!iscd) throw new Error(`알 수 없는 marketCode: ${marketCode}`);

  const data = await kisGet(
    "/uapi/domestic-stock/v1/quotations/volume-rank",
    "FHPST01710000",
    {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_COND_SCR_DIV_CODE: "20171",
      FID_INPUT_ISCD: iscd,
      FID_DIV_CLS_CODE: "0",
      FID_BLNG_CLS_CODE: "3", // 3: 거래금액순
      FID_TRGT_CLS_CODE: "111111111",
      FID_TRGT_EXLS_CLS_CODE: "0000000000",
      FID_INPUT_PRICE_1: "",
      FID_INPUT_PRICE_2: "",
      FID_VOL_CNT: "",
    }
  );

  return (data.output || []).slice(0, 5).map((o) => ({
    name: o.hts_kor_isnm,
    price: Number(o.stck_prpr),
    changeRate: Number(o.prdy_ctrt),
    tradingValue: Number(o.acml_tr_pbmn), // 누적 거래대금(원)
  }));
}

// ---------------------------------------------------------------------------
// 6. 한국 국채 3년물 / 10년물 금리 — 완성됨
//    TR_ID: FHPST07020000 / URL: /uapi/domestic-stock/v1/quotations/comp-interest
//    output2 배열 안에 "국고채 3년"(Y0101), "국고채 10년"(Y0106) 항목이 들어있습니다.
//    ※ 문서에 따르면 이 데이터는 11:30 이후에 신규 갱신됩니다 (그 전엔 전일값).
// ---------------------------------------------------------------------------
const TENOR_BCDT_CODE = { "3Y": "Y0101", "10Y": "Y0106" };

export async function getKrTreasuryYield(tenor) {
  const bcdtCode = TENOR_BCDT_CODE[tenor];
  if (!bcdtCode) throw new Error(`알 수 없는 tenor: ${tenor}`);

  const data = await kisGet(
    "/uapi/domestic-stock/v1/quotations/comp-interest",
    "FHPST07020000",
    {
      FID_COND_MRKT_DIV_CODE: "I",
      FID_COND_SCR_DIV_CODE: "20702",
      FID_DIV_CLS_CODE: "1",
      FID_DIV_CLS_CODE1: "",
    }
  );

  const o = (data.output2 || []).find((row) => row.bcdt_code === bcdtCode);
  if (!o) throw new Error(`금리 데이터에서 ${tenor}(${bcdtCode})를 찾지 못했습니다.`);

  return {
    value: Number(o.bond_mnrt_prpr),
    change: Number(o.bond_mnrt_prdy_vrss),
    changeRate: Number(o.bstp_nmix_prdy_ctrt),
  };
}

// ---------------------------------------------------------------------------
// 7. KOSPI200 야간선물 — 완성됨
//    TR_ID: FHMIF10000000 / URL: /uapi/domestic-futureoption/v1/quotations/inquire-price
//    FID_COND_MRKT_DIV_CODE: "CM" (야간선물) — 주간선물과 같은 종목코드를 그대로 쓰고
//    시장구분만 CM으로 바꿔서 조회합니다.
//
//    ⚠️ 이 종목코드는 "현재 근월물" 코드라 만기(3/6/9/12월)마다 바뀝니다.
//    2026-08-13 기준 최근월물(2026년 9월물) 코드로 채워뒀습니다. 다음 롤오버는
//    2026년 9월 만기 이후이니, 그 무렵 종목정보파일을 다시 받아서
//    KOSPI200_NIGHT_FUTURES_CODE 값을 다음 월물 코드로 갱신해주세요.
//    (파일 안에서 다음 월물은 "A01612" 로 확인됩니다.)
// ---------------------------------------------------------------------------
const KOSPI200_NIGHT_FUTURES_CODE = "A01609"; // 2026년 9월물

export async function getKospi200NightFutures() {
  const data = await kisGet(
    "/uapi/domestic-futureoption/v1/quotations/inquire-price",
    "FHMIF10000000",
    { FID_COND_MRKT_DIV_CODE: "CM", FID_INPUT_ISCD: KOSPI200_NIGHT_FUTURES_CODE }
  );
  const o = data.output1 || {};
  return {
    value: Number(o.futs_prpr),
    change: Number(o.futs_prdy_vrss),
    changeRate: Number(o.futs_prdy_ctrt),
  };
}
