// scripts/fetchers/kis.js
// 한국투자증권(KIS Developers) API 연동 모듈

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
// ---------------------------------------------------------------------------
async function getAccessToken() {
  if (fs.existsSync(TOKEN_CACHE_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, "utf-8"));
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
// 실제 HTTP 요청은 최소 2000ms 간격을 두고 순차적으로 나가도록 스로틀링합니다.
const MIN_CALL_INTERVAL_MS = 2000;
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

async function kisGet(pathname, trId, params, retryCount = 0) {
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
    const bodyText = await res.text();
    // 초당 거래건수 초과(EGW00201)는 순간적으로 튀는 제한이라, 조금 더 쉬었다가 최대 2번 재시도합니다.
    if (retryCount < 2 && bodyText.includes("EGW00201")) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * (retryCount + 1)));
      return kisGet(pathname, trId, params, retryCount + 1);
    }
    throw new Error(`KIS API 호출 실패 (${trId}): ${res.status} ${bodyText}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// 2. 국내 지수 시세 — 코스피 0001 / 코스닥 1001 / 코스피200 2001
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
// 3. 개별 종목 현재가
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
// 4. 시장별 투자자매매동향 (코스피/코스닥/선물 수급: 개인·기관·외국인 순매수)
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

  const o = (data.output && data.output[0]) || {};

  return {
    individual: Number(o.prsn_ntby_tr_pbmn),
    institution: Number(o.orgn_ntby_tr_pbmn),
    foreign: Number(o.frgn_ntby_tr_pbmn),
  };
}

// ---------------------------------------------------------------------------
// 5. 거래대금 상위 종목 (코스피/코스닥 각 5종목)
//    TR_ID: FHPST01710000 / URL: /uapi/domestic-stock/v1/quotations/volume-rank
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
      FID_BLNG_CLS_CODE: "3",
      FID_TRGT_CLS_CODE: "111111111",
      FID_TRGT_EXLS_CLS_CODE: "0000000000",
      FID_INPUT_PRICE_1: "",
      FID_INPUT_PRICE_2: "",
      FID_VOL_CNT: "",
    }
  );

  return (data.output || []).slice(0, 5).map((o) => ({
    code: o.mksc_shrn_iscd, // 종목코드 (시간외현재가 조회에 사용)
    name: o.hts_kor_isnm,
    price: Number(o.stck_prpr),
    changeRate: Number(o.prdy_ctrt),
    tradingValue: Number(o.acml_tr_pbmn), // 누적 거래대금(원)
  }));
}

// ---------------------------------------------------------------------------
// 6. 한국 국채 3년물 / 10년물 금리
//    TR_ID: FHPST07020000 / URL: /uapi/domestic-stock/v1/quotations/comp-interest
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

  const value = Number(o.bond_mnrt_prpr);
  // KIS가 간헐적으로 국채 데이터 필드를 밀려서 주는 경우가 있어(예: 11:30 신규갱신 전),
  // prpr이 숫자로 안 읽히면 나머지 필드도 신뢰할 수 없으므로 실패로 처리합니다.
  if (Number.isNaN(value)) {
    throw new Error(`금리 데이터 형식이 비정상입니다 (${tenor}): prpr="${o.bond_mnrt_prpr}"`);
  }

  return {
    value,
    change: Number(o.bond_mnrt_prdy_vrss),
    changeRate: Number(o.bstp_nmix_prdy_ctrt),
  };
}

// ---------------------------------------------------------------------------
// 7. KOSPI200 야간선물
//    TR_ID: FHMIF10000000 / URL: /uapi/domestic-futureoption/v1/quotations/inquire-price
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
// ---------------------------------------------------------------------------
// 8. 개별 종목 시간외현재가 (장후 시간외종가 15:40~16:00 / 시간외단일가 16:00~18:00)
//    TR_ID: FHPST02300000 / URL: /uapi/domestic-stock/v1/quotations/inquire-overtime-price
// ---------------------------------------------------------------------------
export async function getOvertimePrice(code) {
  const data = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-overtime-price",
    "FHPST02300000",
    { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code }
  );
  const o = data.output || {};
  const price = Number(o.ovtm_untp_prpr);
  if (!price) return null;
  return {
    price,
    changeRate: Number(o.ovtm_untp_prdy_ctrt),
  };
}

// ---------------------------------------------------------------------------
// 9. 시장별 투자자매매동향(일별) — 코스피/코스닥의 "그날 확정된" 최종 수급.
//    장중엔 inquire-time-by-market(실시간성)을 쓰고, 장 마감 후·주말엔 이걸로 대체합니다.
//    TR_ID: FHPTJ04040000 / URL: /uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market
// ---------------------------------------------------------------------------
const DAILY_MARKET_CODE_MAP = {
  KOSPI: { iscd: "0001", iscd1: "KSP" },
  KOSDAQ: { iscd: "1001", iscd1: "KSQ" },
};

export async function getInvestorDailyByMarket(marketCode, dateStr) {
  const codes = DAILY_MARKET_CODE_MAP[marketCode];
  if (!codes) throw new Error(`알 수 없는 marketCode: ${marketCode}`);

  const data = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market",
    "FHPTJ04040000",
    {
      FID_COND_MRKT_DIV_CODE: "U",
      FID_INPUT_ISCD: codes.iscd,
      FID_INPUT_DATE_1: dateStr,
      FID_INPUT_ISCD_1: codes.iscd1,
      FID_INPUT_DATE_2: dateStr,
      FID_INPUT_ISCD_2: codes.iscd,
    }
  );

  // output 배열의 첫 항목이 조회일(혹은 그 이전 가장 최근 영업일)의 확정 데이터
  const o = (data.output || [])[0];
  if (!o) throw new Error(`${marketCode} 일별 수급 데이터가 없습니다.`);

  return {
    individual: Number(o.prsn_ntby_tr_pbmn),
    institution: Number(o.orgn_ntby_tr_pbmn),
    foreign: Number(o.frgn_ntby_tr_pbmn),
  };
}