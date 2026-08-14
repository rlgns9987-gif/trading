// scripts/fetchers/crypto.js
// CoinGecko 공개 API로 BTC/USD, ETH/USD 시세를 조회합니다. (인증키 불필요, 무료)
// ※ Binance는 GitHub Actions 서버(미국 리전)를 지역 차단(451)하여 CoinGecko로 대체했습니다.

const IDS = { btc: "bitcoin", eth: "ethereum" };

export async function getAllCryptoQuotes() {
  const ids = Object.values(IDS).join(",");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`CoinGecko 호출 실패: ${res.status}`);
    }
    const d = await res.json();
    const result = {};
    for (const [key, id] of Object.entries(IDS)) {
      const entry = d[id];
      if (!entry) {
        result[key] = null;
        continue;
      }
      result[key] = {
        price: Number(entry.usd),
        changeRate: Number(entry.usd_24h_change),
      };
    }
    return result;
  } catch (err) {
    console.error(`[crypto] 조회 실패:`, err.message);
    return { btc: null, eth: null };
  }
}