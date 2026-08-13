// scripts/lib/history.js
// 매 실행마다 "오늘 날짜 파일"에 현재 시각 스냅샷을 추가하고,
// 과거 파일들을 이용해 "전일 동시간 대비" / "최근 20일 동시간 평균 대비"를 계산합니다.
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

function listPastDates(excludeToday) {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  return fs
    .readdirSync(HISTORY_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""))
    .filter((d) => d !== excludeToday)
    .sort()
    .reverse(); // 최신 날짜부터
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

  // 오래된 파일 정리: 최근 25일치만 보관 (20일 평균 계산 + 여유분)
  const past = listPastDates(dateStr);
  past.slice(25).forEach((d) => fs.unlinkSync(filePath(d)));
}

/**
 * 주어진 flat 경로 키에 대해 전일 동시간 값 / 최근 20일 동시간 평균값을 계산합니다.
 */
export function getComparisons(key) {
  const dateStr = todayDateStr();
  const timeStr = nowTimeStr();
  const pastDates = listPastDates(dateStr);

  if (pastDates.length === 0) {
    return { vsYesterday: null, vs20dAvg: null };
  }

  const yesterdaySnap = findNearest(loadDay(pastDates[0]), timeStr);
  const vsYesterday = yesterdaySnap?.values?.[key] ?? null;

  const window = pastDates.slice(0, 20);
  const values = window
    .map((d) => findNearest(loadDay(d), timeStr)?.values?.[key])
    .filter((v) => typeof v === "number");
  const vs20dAvg =
    values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;

  return { vsYesterday, vs20dAvg };
}
