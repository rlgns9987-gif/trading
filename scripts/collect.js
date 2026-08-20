// scripts/collect.js
// GitHub Actions가 1분마다 이 스크립트를 실행합니다.
// 모든 데이터 소스를 조회해 public/data/latest.json 을 생성/갱신합니다.

import fs from "fs";
import path from "path";
import * as kis from "./fetchers/kis.js";
import { getAllYahooQuotes } from "./fetchers/yahoo.js";
import { getAllCryptoQuotes } from "./fetchers/crypto.js";
import { saveSnapshot, getComparisons } from "./lib/history.js";

const OUT_PATH = path.resolve("public/data/latest.json");
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 실패해도 전체 실행이 멈추지 않도록 감싸는 헬퍼
async function safe(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[collect] ${label} 실패:`, err.message);
    return null;
  }
}

function nowKst() {
  return new Date(Date.now() + KST_OFFSET_MS);
}

// 국내 증시 정규장 시간(09:00~15:30, 평일)인지 확인. 공휴일까진 따지지 않지만,
// 공휴일엔 어차피 장중 API도 값이 안 바뀌므로 일별 API로 자연스럽게 대체됩니다.
function isKrMarketHours() {
  const kst = nowKst();
  const day = kst.getUTCDay(); // 0=일,6=토
  if (day === 0 || day === 6) return false;
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return mins >= 9 * 60 && mins <= 15 * 60 + 30;
}

function todayDateStrKst() {
  return nowKst().toISOString().slice(0, 10).replace(/-/g, "");
}

async function collectSupply() {
  const inMarketHours = isKrMarketHours();
  const dateStr = todayDateStrKst();
  const result = {};

  for (const m of ["KOSPI", "KOSDAQ", "FUTURES"]) {
    let trend = null;

    if (inMarketHours || m === "FUTURES") {
      // 장중이거나(실시간성 API 사용), 선물은 일별 대체 API가 없어 그대로 시도
      trend = await safe(`수급(${m})`, () => kis.getMarketInvestorTrend(m));
    }

    if (!trend && m !== "FUTURES") {
      // 장 마감/주말/공휴일: 그날(혹은 가장 최근 영업일) 확정된 일별 수급으로 대체
      trend = await safe(`수급(${m}, 일별)`, () => kis.getInvestorDailyByMarket(m, dateStr));
    }

    const key = m.toLowerCase();
    result[key] = {
      individual: trend?.individual ?? null,
      institution: trend?.institution ?? null,
      foreign: trend?.foreign ?? null,
    };
  }
  return result;
}

async function collectTopValue() {
  const inMarketHours = isKrMarketHours();
  const markets = ["KOSPI", "KOSDAQ"];
  const result = {};

  for (const m of markets) {
    const list = await safe(`거래대금상위(${m})`, () => kis.getTopTradingValueStocks(m));

    if (list && !inMarketHours) {
      // 장 마감 후엔 순위에 뽑힌 종목들의 "가격"만 시간외현재가로 덮어씁니다.
      // (순위 자체는 정규장 거래대금 기준이라 장 마감 후 바뀌지 않는 게 정상)
      for (const stock of list) {
        if (!stock.code) continue;
        const overtime = await safe(`시간외가(${stock.name})`, () => kis.getOvertimePrice(stock.code));
        if (overtime) {
          stock.price = overtime.price;
          stock.changeRate = overtime.changeRate;
        }
      }
    }

    result[m.toLowerCase()] = list ?? [];
  }
  return result;
}

async function collectIndices() {
  const kospi = await safe("코스피 지수", () => kis.getIndexPrice("0001"));
  const kosdaq = await safe("코스닥 지수", () => kis.getIndexPrice("1001"));
  const kospi200Night = await safe("KOSPI200 야간선물", () => kis.getKospi200NightFutures());
  return { kospi, kosdaq, kospi200Night };
}

async function collectRates() {
  const krTreasury3y = await safe("한국 국채 3년물", () => kis.getKrTreasuryYield("3Y"));
  const krTreasury10y = await safe("한국 국채 10년물", () => kis.getKrTreasuryYield("10Y"));
  return { krTreasury3y, krTreasury10y };
}

function flattenSupplyAndTopValue(supply, topValue) {
  const flat = {};
  for (const market of Object.keys(supply)) {
    for (const investor of ["individual", "institution", "foreign"]) {
      const v = supply[market]?.[investor];
      if (typeof v === "number") flat[`supply.${market}.${investor}`] = v;
    }
  }
  for (const market of Object.keys(topValue)) {
    (topValue[market] || []).forEach((stock, i) => {
      if (typeof stock?.tradingValue === "number") {
        flat[`topValue.${market}.${i}.tradingValue`] = stock.tradingValue;
      }
    });
  }
  return flat;
}

function attachComparisons(supply, topValue) {
  for (const market of Object.keys(supply)) {
    for (const investor of ["individual", "institution", "foreign"]) {
      const key = `supply.${market}.${investor}`;
      const { vsYesterday, vs20dAvg } = getComparisons(key);
      supply[market][investor] = {
        netBuy: supply[market][investor],
        vsYesterday,
        vs20dAvg,
      };
    }
  }
  for (const market of Object.keys(topValue)) {
    topValue[market] = (topValue[market] || []).map((stock, i) => {
      const key = `topValue.${market}.${i}.tradingValue`;
      const { vsYesterday, vs20dAvg } = getComparisons(key);
      return { ...stock, vsYesterday, vs20dAvg };
    });
  }
}

// 이번에 새로 받아온 값(curr)에 빈 값(null/undefined/빈배열)이 있으면,
// 직전 실행 결과(prev)의 값으로 채웁니다. 주말/공휴일/일시적 API 오류로
// 값을 못 받아왔을 때 화면이 텅 비지 않고 "가장 최근 값"을 계속 보여주기 위함입니다.
function fillWithPrevious(curr, prev) {
  if (curr === null || curr === undefined) {
    return prev !== undefined ? prev : null;
  }
  if (Array.isArray(curr)) {
    if (curr.length > 0) return curr;
    return Array.isArray(prev) && prev.length > 0 ? prev : curr;
  }
  if (typeof curr === "object") {
    const prevObj = prev && typeof prev === "object" ? prev : {};
    const out = {};
    for (const key of Object.keys(curr)) {
      out[key] = fillWithPrevious(curr[key], prevObj[key]);
    }
    return out;
  }
  return curr;
}

function loadPreviousData() {
  try {
    return JSON.parse(fs.readFileSync(OUT_PATH, "utf-8"));
  } catch {
    return null;
  }
}

async function main() {
  const previousData = loadPreviousData();

  const [supply, topValue, indices, rates, yahoo, crypto] = await Promise.all([
    collectSupply(),
    collectTopValue(),
    collectIndices(),
    collectRates(),
    safe("Yahoo Finance", getAllYahooQuotes),
    safe("암호화폐", getAllCryptoQuotes),
  ]);

  // 전일/20일 평균 대비 계산 전에, 오늘 값을 이력에 먼저 저장
  // (여기서는 "이번에 실제로 받아온 값"만 저장 — 직전 값으로 채운 것은 이력에 안 남김)
  const flat = flattenSupplyAndTopValue(supply, topValue);
  saveSnapshot(flat);
  attachComparisons(supply, topValue);

  const rawData = {
    updatedAt: new Date().toISOString(),
    supply,
    topValue,
    indices: {
      ...indices,
      nikkei225: yahoo?.nikkei225 ?? null,
      nasdaq100Futures: yahoo?.nasdaq100Futures ?? null,
      sp500Futures: yahoo?.sp500Futures ?? null,
      philadelphiaSemi: yahoo?.philadelphiaSemi ?? null,
    },
    rates: {
      ...rates,
      usTreasury10y: yahoo?.usTreasury10y ?? null,
      usTreasury30y: yahoo?.usTreasury30y ?? null,
    },
    commoditiesFx: {
      gold: yahoo?.gold ?? null,
      silver: yahoo?.silver ?? null,
      wti: yahoo?.wti ?? null,
      brent: yahoo?.brent ?? null,
      dxy: yahoo?.dxy ?? null,
      usdkrw: yahoo?.usdkrw ?? null,
    },
    volatilityCrypto: {
      vix: yahoo?.vix ?? null,
      btc: crypto?.btc ?? null,
      eth: crypto?.eth ?? null,
    },
  };

  // 빈 값들을 직전 실행 결과로 채우되, updatedAt만은 항상 지금 시각으로 유지
  const data = fillWithPrevious(rawData, previousData);
  data.updatedAt = rawData.updatedAt;

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2));
  console.log(`[collect] 완료: ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("[collect] 치명적 오류:", err);
  process.exit(1);
});