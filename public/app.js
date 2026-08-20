// public/app.js
// 60초마다 data/latest.json을 가져와 화면을 그립니다.

const REFRESH_MS = 60 * 1000;

function fmtNum(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("ko-KR", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function signClass(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "flat";
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "flat";
}

function fmtSigned(n, digits = 0, suffix = "") {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${fmtNum(n, digits)}${suffix}`;
}

function row(label, valueHtml, compareHtml = "") {
  return `<div class="row">
    <span class="label">${label}</span>
    <span>
      ${valueHtml}
      ${compareHtml}
    </span>
  </div>`;
}

function quoteRow(label, quote, digits = 2) {
  if (!quote) return row(label, `<span class="value flat">—</span>`);
  const cls = signClass(quote.change ?? quote.changeRate);
  const valueHtml = `<span class="value ${cls}">${fmtNum(quote.price ?? quote.value, digits)} <span style="font-size:11px">(${fmtSigned(quote.changeRate, 2, "%")})</span></span>`;
  return row(label, valueHtml);
}

function supplyRow(label, entry) {
  if (!entry) return row(label, `<span class="value flat">—</span>`);
  const cls = signClass(entry.netBuy);
  const valueHtml = `<span class="value ${cls}">${fmtSigned(entry.netBuy, 0)}</span>`;
  const compareHtml = `<span class="sub-compare">전일比 ${fmtSigned(entry.vsYesterday, 0)} · 20일평균比 ${fmtSigned(entry.vs20dAvg, 0)}</span>`;
  return `<div class="row" style="flex-direction:column; align-items:stretch;">
    <div style="display:flex; justify-content:space-between;">
      <span class="label">${label}</span>
      ${valueHtml}
    </div>
    ${compareHtml}
  </div>`;
}

function supplyCard(title, data) {
  if (!data) return `<section class="card"><h2>${title}</h2><p class="empty-note">데이터 연동 준비 중입니다.</p></section>`;
  return `<section class="card">
    <h2>${title}</h2>
    ${supplyRow("개인", data.individual)}
    ${supplyRow("기관", data.institution)}
    ${supplyRow("외국인", data.foreign)}
  </section>`;
}

function stockItem(stock) {
  if (!stock) return "";
  const cls = signClass(stock.changeRate);
  return `<div class="stock-item">
    <div class="top-line">
      <span class="name">${stock.name ?? "—"}</span>
      <span class="value ${cls}">${fmtNum(stock.price, 0)} (${fmtSigned(stock.changeRate, 2, "%")})</span>
    </div>
    <div class="meta">
      <span>거래대금 ${fmtNum(stock.tradingValue / 100_000_000, 1)}억</span>
      <span>전일比 ${fmtSigned(stock.vsYesterday / 100_000_000, 1)}억 · 20일比 ${fmtSigned(stock.vs20dAvg / 100_000_000, 1)}억</span>
    </div>
  </div>`;
}

function topValueCard(title, list) {
  if (!list || list.length === 0) {
    return `<section class="card"><h2>${title}</h2><p class="empty-note">데이터 연동 준비 중입니다.</p></section>`;
  }
  return `<section class="card"><h2>${title}</h2>${list.map(stockItem).join("")}</section>`;
}

function indexCard(title, quotes) {
  return `<section class="card"><h2>${title}</h2>${quotes.map(([label, q, digits]) => quoteRow(label, q, digits)).join("")}</section>`;
}

function render(data) {
  const app = document.getElementById("app");

  const supplySection = `
    ${supplyCard("코스피 수급", data.supply?.kospi)}
    ${supplyCard("코스닥 수급", data.supply?.kosdaq)}
    ${supplyCard("선물 수급", data.supply?.futures)}
  `;

  const topValueSection = `
    ${topValueCard("코스피 거래대금 상위", data.topValue?.kospi)}
    ${topValueCard("코스닥 거래대금 상위", data.topValue?.kosdaq)}
  `;

  const indicesSection = indexCard("국내외 지수", [
    ["코스피", data.indices?.kospi],
    ["코스닥", data.indices?.kosdaq],
    ["KOSPI200 야간선물", data.indices?.kospi200Night],
    ["닛케이225", data.indices?.nikkei225],
    ["나스닥100선물", data.indices?.nasdaq100Futures],
    ["S&P500 선물", data.indices?.sp500Futures],
    ["필라델피아 반도체", data.indices?.philadelphiaSemi],
  ]);

  const ratesSection = indexCard("금리", [
    ["한국 국채 3년", data.rates?.krTreasury3y, 3],
    ["한국 국채 10년", data.rates?.krTreasury10y, 3],
    ["미국 국채 10년", data.rates?.usTreasury10y, 3],
    ["미국 국채 30년", data.rates?.usTreasury30y, 3],
  ]);

  const commoditiesSection = indexCard("원자재 · 환율", [
    ["금 선물", data.commoditiesFx?.gold],
    ["은 선물", data.commoditiesFx?.silver, 2],
    ["WTI유", data.commoditiesFx?.wti, 2],
    ["브렌트유", data.commoditiesFx?.brent, 2],
    ["달러 인덱스", data.commoditiesFx?.dxy, 2],
    ["달러/원", data.commoditiesFx?.usdkrw, 2],
  ]);

  const volCryptoSection = indexCard("변동성 · 암호화폐", [
    ["VIX", data.volatilityCrypto?.vix, 2],
    ["BTC/USD", data.volatilityCrypto?.btc, 0],
    ["ETH/USD", data.volatilityCrypto?.eth, 2],
  ]);

  app.innerHTML =
    supplySection + topValueSection + indicesSection + ratesSection + commoditiesSection + volCryptoSection;

  const updatedAt = document.getElementById("updatedAt");
  if (data.updatedAt) {
    const d = new Date(data.updatedAt);
    updatedAt.textContent = `업데이트 ${d.toLocaleTimeString("ko-KR", { hour12: false })}`;
  }
}

// Vercel은 코드가 바뀔 때만 배포되고, 데이터는 GitHub Actions가 커밋한 파일을
// GitHub에서 직접 읽어옵니다. (Vercel은 하루 배포 횟수 제한이 있어, 1분마다
// 재배포에 의존하면 금방 한도를 초과하게 됩니다.)
const DATA_URL = "https://raw.githubusercontent.com/rlgns9987-gif/trading/main/public/data/latest.json";

async function load() {
  try {
    const res = await fetch(`${DATA_URL}?ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`데이터 로드 실패: ${res.status}`);
    const data = await res.json();
    render(data);
  } catch (err) {
    console.error(err);
    document.getElementById("updatedAt").textContent = "업데이트 실패 — 잠시 후 재시도";
  }
}

load();
setInterval(load, REFRESH_MS);
