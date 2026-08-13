// scripts/fetchers/crypto.js
// Binance 공개 API로 BTC/USD, ETH/USD 시세를 조회합니다. (인증키 불필요, 무료)

const SYMBOLS = { btc: "BTCUSDT", eth: "ETHUSDT" };

async function fetch24h(symbol) {
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Binance 호출 실패 (${symbol}): ${res.status}`);
  }
  const d = await res.json();
  return {
    price: Number(d.lastPrice),
    change: Number(d.priceChange),
    changeRate: Number(d.priceChangePercent),
  };
}

export async function getAllCryptoQuotes() {
  const entries = await Promise.all(
    Object.entries(SYMBOLS).map(async ([key, symbol]) => {
      try {
        return [key, await fetch24h(symbol)];
      } catch (err) {
        console.error(`[crypto] ${key} 조회 실패:`, err.message);
        return [key, null];
      }
    })
  );
  return Object.fromEntries(entries);
}
