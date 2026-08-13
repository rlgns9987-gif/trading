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

// 실패해도 전체 실행이 멈추지 않도록 감싸는 헬퍼
async function safe(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[collect] ${label} 실패:`, err.message);
    return null;
  }
}

async function collectSupply() {
  // KIS 시장별 투자자매매동향 TR_ID가 채워지기 전까지는 null로 유지됩니다.
  const markets = ["KOSPI", "KOSDAQ", "FUTURES"];
  const result = {};
  for (const m of markets) {
    const trend = await safe(`수급(${m})`, () => kis.getMarketInvestorTrend(m));
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
  const markets = ["KOSPI", "KOSDAQ"];
  const result = {};
  for (const m of markets) {
    const list = await safe(`거래대금상위(${m})`, () => kis.getTopTradingValueStocks(m));
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

async function main() {
  const [supply, topValue, indices, rates, yahoo, crypto] = await Promise.all([
    collectSupply(),
    collectTopValue(),
    collectIndices(),
    collectRates(),
    safe("Yahoo Finance", getAllYahooQuotes),
    safe("암호화폐", getAllCryptoQuotes),
  ]);

  // 전일/20일 평균 대비 계산 전에, 오늘 값을 이력에 먼저 저장
  const flat = flattenSupplyAndTopValue(supply, topValue);
  saveSnapshot(flat);
  attachComparisons(supply, topValue);

  const data = {
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

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2));
  console.log(`[collect] 완료: ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("[collect] 치명적 오류:", err);
  process.exit(1);
});
