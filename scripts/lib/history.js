// scripts/lib/history.js
// 매 실행마다 "오늘 날짜 파일"에 현재 시각 스냅샷을 추가하고,
// 과거 파일들을 이용해 "전(영업)일 동시간 대비" / "최근 20영업일 동시간 평균 대비"를 계산합니다.
//
// 저장 위치: public/data/history/YYYY-MM-DD.json
// 파일 내용: [{ "t": "HH:MM", "values": { "kospi.index": 2650.3, ... } }, ...]
//
// values의 키는 "그룹.항목" 형태의 평평한(flat) 경로 문자열을 사용합니다.
// 예) "supply.kospi.foreign", "topValue.kospi.0.tradingValue"

import fs from "fs";
import path from "path";

const HISTORY_DIR = path.resolve("public/data/history");
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 한국거래소(KRX) 휴장일. 주말은 별도 로직으로 자동 제외되므로, 여기엔
// "평일인데 시장이 쉬는 날"만 넣으면 됩니다. 매년 초 KRX 공식 캘린더로 갱신 필요.
// 출처: KRX 개장일/휴장일 캘린더
const KR_MARKET_HOLIDAYS = new Set([
  // 2026년 (설날/대체공휴일 포함 — 2025년 12월 기준 확정된 정부 공휴일 규정 기준)
  "2026-01-01", // 신정
  "2026-02-16", // 설날 연휴(전날)
  "2026-02-17", // 설날
  "2026-02-18", // 설날 연휴(다음날)
  "2026-03-02", // 삼일절 대체공휴일 (3/1이 일요일)
  "2026-05-01", // 근로자의 날 (금융권 휴장)
  "2026-05-05", // 어린이날
  "2026-05-25", // 부처님오신날 대체공휴일 (5/24가 일요일)
  "2026-06-03", // 전국동시지방선거일 (임시공휴일)
  "2026-08-17", // 광복절 대체공휴일 (8/15가 토요일)
  "2026-09-24", // 추석 연휴
  "2026-09-25", // 추석
  "2026-10-05", // 개천절 대체공휴일 (10/3이 토요일)
  "2026-10-09", // 한글날
  "2026-12-25", // 성탄절
  "2026-12-31", // 연말 휴장일(KRX 자체 휴장)
  // 2027년 — 대체공휴일 미확정분 있어 다음 해 초 재확인 필요
  "2027-01-01", // 신정
  "2027-02-06", // 설날 연휴
  "2027-02-07", // 설날
  "2027-02-08", // 설날 연휴
  "2027-03-01", // 삼일절
  "2027-05-01", // 근로자의 날
  "2027-05-05", // 어린이날
  "2027-05-13", // 부처님오신날
  "2027-06-07", // 현충일 대체공휴일 추정 (6/6이 일요일)
  "2027-08-16", // 광복절 대체공휴일 추정 (8/15가 일요일)
  "2027-10-14", // 추석 연휴
  "2027-10-15", // 추석
  "2027-12-31", // 연말 휴장일
]);

function nowKst() {
  return new Date(Date.now() + KST_OFFSET_MS);
}

function todayDateStr() {
  return nowKst().toISOString().slice(0, 10); // YYYY-MM-DD
}

function nowTimeStr() {
  return nowKst().toISOString().slice(11, 16); // HH:MM
}

function filePath(dateStr) {
  return path.join(HISTORY_DIR, `${dateStr}.json`);
}

function loadDay(dateStr) {
  const p = filePath(dateStr);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
}

// dateStr("YYYY-MM-DD")이 국내 증시 영업일인지 (주말/공휴일 아님) 확인
function isTradingDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00+09:00`);
  const dayOfWeek = d.getUTCDay(); // 0=일, 6=토
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  if (KR_MARKET_HOLIDAYS.has(dateStr)) return false;
  return true;
}

// 보관된 모든 과거 날짜(파일 정리용, 영업일 필터 없이 전부)
function listAllPastDates(excludeToday) {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  return fs
    .readdirSync(HISTORY_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""))
    .filter((d) => d !== excludeToday)
    .sort()
    .reverse(); // 최신 날짜부터
}

// 비교 계산용: 주말/공휴일을 제외한 영업일만
function listPastTradingDates(excludeToday) {
  return listAllPastDates(excludeToday).filter(isTradingDay);
}

// 특정 날짜의 스냅샷 중 targetTime(HH:MM)과 가장 가까운(같거나 직전) 값을 찾음
function findNearest(daySnapshots, targetTime) {
  const candidates = daySnapshots.filter((s) => s.t <= targetTime);
  const pool = candidates.length > 0 ? candidates : daySnapshots;
  if (pool.length === 0) return null;
  return pool[pool.length - 1];
}

/**
 * 오늘의 현재 스냅샷을 저장합니다. flatValues는 { "supply.kospi.foreign": 123, ... } 형태.
 */
export function saveSnapshot(flatValues) {
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const dateStr = todayDateStr();
  const timeStr = nowTimeStr();
  const day = loadDay(dateStr);
  day.push({ t: timeStr, values: flatValues });
  fs.writeFileSync(filePath(dateStr), JSON.stringify(day));

  // 오래된 파일 정리: 최근 40일(달력 기준)치만 보관.
  // 주말/공휴일이 섞여도 영업일 20일치가 넉넉히 남도록 여유를 둠.
  const past = listAllPastDates(dateStr);
  past.slice(40).forEach((d) => fs.unlinkSync(filePath(d)));
}

/**
 * 주어진 flat 경로 키에 대해 전영업일 동시간 값 / 최근 20영업일 동시간 평균값을 계산합니다.
 * 주말과 KRX 공휴일은 비교 대상에서 제외됩니다.
 */
export function getComparisons(key) {
  const dateStr = todayDateStr();
  const timeStr = nowTimeStr();
  const pastTradingDates = listPastTradingDates(dateStr);

  if (pastTradingDates.length === 0) {
    return { vsYesterday: null, vs20dAvg: null };
  }

  const prevTradingDaySnap = findNearest(loadDay(pastTradingDates[0]), timeStr);
  const vsYesterday = prevTradingDaySnap?.values?.[key] ?? null;

  const window = pastTradingDates.slice(0, 20);
  const values = window
    .map((d) => findNearest(loadDay(d), timeStr)?.values?.[key])
    .filter((v) => typeof v === "number");
  const vs20dAvg =
    values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;

  return { vsYesterday, vs20dAvg };
}