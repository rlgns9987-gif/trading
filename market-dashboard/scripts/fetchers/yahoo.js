// scripts/fetchers/yahoo.js
// Yahoo Finance 비공식 차트 API로 해외 지수/금리/원자재/환율/VIX를 조회합니다.
// 인증키가 필요 없지만 비공식 API이므로, 응답 형식이 예고 없이 바뀔 수 있습니다.
// 문제가 생기면 이 파일만 다른 데이터 소스로 교체하면 됩니다.

const TICKERS = {
  nikkei225: "^N225",
  nasdaq100Futures: "NQ=F",
  sp500Futures: "ES=F",
  philadelphiaSemi: "^SOX",
  usTreasury10y: "^TNX", // 값이 실제 금리 * 10 으로 내려오므로 /10 필요
  usTreasury30y: "^TYX", // 동일
  gold: "GC=F",
  silver: "SI=F",
  wti: "CL=F",
  brent: "BZ=F",
  dxy: "DX-Y.NYB",
  usdkrw: "KRW=X",
  vix: "^VIX",
};

async function fetchYahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=1m&range=1d`;

  const res = await fetch(url, {
    headers: {
      // User-Agent가 없으면 차단되는 경우가 있어 브라우저처럼 위장합니다.
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });

  if (!res.ok) {
    throw new Error(`Yahoo Finance 호출 실패 (${symbol}): ${res.status}`);
  }

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) {
    throw new Error(`Yahoo Finance 응답에 데이터가 없습니다 (${symbol})`);
  }

  const meta = result.meta;
  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose ?? meta.previousClose;
  const change = price - prevClose;
  const changeRate = prevClose ? (change / prevClose) * 100 : 0;

  return { price, prevClose, change, changeRate };
}

function scaleTenX(raw) {
  return {
    ...raw,
    price: raw.price / 10,
    prevClose: raw.prevClose / 10,
    change: raw.change / 10,
  };
}

export async function getYahooQuote(key) {
  const symbol = TICKERS[key];
  if (!symbol) throw new Error(`알 수 없는 티커 키: ${key}`);
  const raw = await fetchYahooChart(symbol);
  if (key === "usTreasury10y" || key === "usTreasury30y") {
    return scaleTenX(raw);
  }
  return raw;
}

export async function getAllYahooQuotes() {
  const keys = Object.keys(TICKERS);
  const entries = await Promise.all(
    keys.map(async (key) => {
      try {
        return [key, await getYahooQuote(key)];
      } catch (err) {
        console.error(`[yahoo] ${key} 조회 실패:`, err.message);
        return [key, null];
      }
    })
  );
  return Object.fromEntries(entries);
}
