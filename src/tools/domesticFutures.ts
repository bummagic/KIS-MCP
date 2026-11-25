/**
 * 국내 지수선물 현재가: get_domestic_futures (조회 전용).
 *
 * 한투 `선물옵션 시세` (FHMIF10000000, /uapi/domestic-futureoption/v1/quotations/inquire-price).
 *   FID_COND_MRKT_DIV_CODE: F = 지수선물(주간), CM = KRX 야간선물.
 *
 * 종목코드 체계가 개편 전후로 다르고(예: 1016C ↔ A01612) 야간 예제는 8자리(…000)를
 * 쓰므로, 근월물 코드 후보를 순서대로 시도해 가격이 나오는 첫 코드를 채택한다.
 * 채택된 코드는 isolate 메모리에 기억해 다음 호출에서 먼저 시도한다.
 *
 * 주문·잔고 엔드포인트는 사용하지 않는다 (CLAUDE.md §1.3, §5.1).
 */

import { KIS } from "../kis/endpoints.js";
import type { KisClient } from "../kis/client.js";
import { parseNum } from "../utils/downsample.js";
import { extractObjectPreferred } from "../utils/kisResponse.js";

export type FuturesProduct = "KOSPI200" | "KOSDAQ150" | "MINI_KOSPI200";
export type FuturesSession = "day" | "night" | "auto";

export interface GetDomesticFuturesInput {
  product?: FuturesProduct;
  session?: FuturesSession;
  /** 종목코드 직접 지정 (예: A01612, 1016C). 지정 시 후보 탐색 생략 */
  code?: string;
}

export interface DomesticFuturesResult {
  product: FuturesProduct;
  session: "day" | "night";
  code: string;
  name: string;
  price: number;
  change?: number;
  changeRate?: number;
  prevClose?: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  openInterest?: number;
  basis?: number;
  lastTradeDate?: string;
  underlying?: { name: string; value: number; changeRate?: number };
  fetchedAt: string;
  tried: { code: string; ok: boolean; note?: string }[];
  notes: string[];
}

interface FuturesPriceOutput {
  hts_kor_isnm?: string;
  futs_prpr?: string;
  futs_prdy_vrss?: string;
  prdy_vrss_sign?: string;
  futs_prdy_clpr?: string;
  futs_prdy_ctrt?: string;
  acml_vol?: string;
  hts_otst_stpl_qty?: string;
  futs_oprc?: string;
  futs_hgpr?: string;
  futs_lwpr?: string;
  mrkt_basis?: string;
  futs_last_tr_date?: string;
}

interface UnderlyingOutput {
  hts_kor_isnm?: string;
  bstp_nmix_prpr?: string;
  bstp_nmix_prdy_ctrt?: string;
}

const PRODUCT_NO: Record<FuturesProduct, { no: string; quarterly: boolean; label: string }> = {
  KOSPI200: { no: "01", quarterly: true, label: "코스피200 선물" },
  KOSDAQ150: { no: "06", quarterly: true, label: "코스닥150 선물" },
  MINI_KOSPI200: { no: "05", quarterly: false, label: "미니코스피200 선물" },
};

/** KRX 연도 코드 (구 체계). 2026년부터 숫자(6,7,…)를 쓴다. */
const OLD_YEAR: Record<number, string> = { 2024: "V", 2025: "W" };
const MONTH_CODE = "123456789ABC";

const resolvedCodeMemo = new Map<string, string>();

function kstNow(now = new Date()): Date {
  return new Date(now.getTime() + 9 * 3600 * 1000);
}

/** 해당 월의 둘째 목요일 (만기일) */
export function secondThursday(year: number, month1: number): number {
  const first = new Date(Date.UTC(year, month1 - 1, 1)).getUTCDay(); // 0=일
  const firstThu = 1 + ((4 - first + 7) % 7);
  return firstThu + 7;
}

/** 근월물 (year, month). 만기일 15:45 이후(야간 포함)는 차근월물로 넘긴다. */
export function nearestContract(
  quarterly: boolean,
  now = new Date(),
): { year: number; month: number } {
  const k = kstNow(now);
  let y = k.getUTCFullYear();
  let m = k.getUTCMonth() + 1;
  const d = k.getUTCDate();
  const hm = k.getUTCHours() * 100 + k.getUTCMinutes();
  for (let i = 0; i < 14; i++) {
    const isContractMonth = !quarterly || m % 3 === 0;
    if (isContractMonth) {
      const exp = secondThursday(y, m);
      const sameMonth = i === 0;
      if (!sameMonth || d < exp || (d === exp && hm < 1545)) return { year: y, month: m };
    }
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return { year: y, month: m };
}

export function candidateCodes(
  product: FuturesProduct,
  session: "day" | "night",
  contract: { year: number; month: number },
): string[] {
  const { no } = PRODUCT_NO[product];
  const yDigit = String(contract.year % 10);
  const mm = String(contract.month).padStart(2, "0");
  const oldYear = OLD_YEAR[contract.year] ?? yDigit;
  const newCode = `A${no}${yDigit}${mm}`; // 개편 체계 (예: A01612)
  const oldCode = `1${no}${oldYear}${MONTH_CODE[contract.month - 1]}`; // 구 체계 (예: 1016C)
  const list =
    session === "night"
      ? [newCode, `${oldCode}000`, oldCode, `${newCode}00`]
      : [newCode, oldCode, `${oldCode}000`];
  return Array.from(new Set(list));
}

function sessionNow(now = new Date()): "day" | "night" {
  const k = kstNow(now);
  const hm = k.getUTCHours() * 100 + k.getUTCMinutes();
  // 야간 18:00 ~ 익일 06:00. 그 외는 주간(정규장 08:45~15:45, 장외 시간은 주간 종가).
  return hm >= 1800 || hm < 600 ? "night" : "day";
}

function num(v: string | undefined): number | undefined {
  const n = parseNum(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function getDomesticFutures(
  client: KisClient,
  input: GetDomesticFuturesInput = {},
): Promise<DomesticFuturesResult> {
  const product: FuturesProduct = input.product ?? "KOSPI200";
  if (!PRODUCT_NO[product]) throw new Error(`지원하지 않는 product입니다: ${String(product)}`);
  const session: "day" | "night" =
    !input.session || input.session === "auto" ? sessionNow() : input.session;
  const mrkt = session === "night" ? "CM" : "F";
  const contract = nearestContract(PRODUCT_NO[product].quarterly);

  const memoKey = `${product}:${session}:${contract.year}-${contract.month}`;
  let codes: string[];
  if (input.code) {
    const c = input.code.trim().toUpperCase();
    if (!/^[A-Z0-9]{5,12}$/.test(c)) throw new Error(`종목코드 형식이 올바르지 않습니다: ${input.code}`);
    codes = [c];
  } else {
    codes = candidateCodes(product, session, contract);
    const memo = resolvedCodeMemo.get(memoKey);
    if (memo) codes = [memo, ...codes.filter((c) => c !== memo)];
  }

  const tried: DomesticFuturesResult["tried"] = [];
  for (const code of codes) {
    try {
      const res = await client.get<FuturesPriceOutput>({
        path: KIS.domesticFuturesPrice.path,
        trId: KIS.domesticFuturesPrice.trIdReal,
        query: { fid_cond_mrkt_div_code: mrkt, fid_input_iscd: code },
      });
      const o = extractObjectPreferred<FuturesPriceOutput>(res, ["output1", "output"]);
      const price = parseNum(o.futs_prpr);
      if (!Number.isFinite(price) || price <= 0) {
        tried.push({ code, ok: false, note: "가격 없음" });
        continue;
      }
      tried.push({ code, ok: true });
      if (!input.code) resolvedCodeMemo.set(memoKey, code);

      const raw = res as unknown as { output3?: UnderlyingOutput; output2?: UnderlyingOutput };
      const u = product === "KOSDAQ150" ? raw.output2 ?? raw.output3 : raw.output3 ?? raw.output2;
      const uVal = u ? parseNum(u.bstp_nmix_prpr) : NaN;

      const sign = o.prdy_vrss_sign;
      let change = num(o.futs_prdy_vrss);
      if (change !== undefined && (sign === "4" || sign === "5") && change > 0) change = -change;
      let changeRate = num(o.futs_prdy_ctrt);
      if (changeRate !== undefined && (sign === "4" || sign === "5") && changeRate > 0) {
        changeRate = -changeRate;
      }
      const ltd = o.futs_last_tr_date;

      return {
        product,
        session,
        code,
        name: (o.hts_kor_isnm ?? PRODUCT_NO[product].label).trim(),
        price,
        change,
        changeRate,
        prevClose: num(o.futs_prdy_clpr),
        open: num(o.futs_oprc),
        high: num(o.futs_hgpr),
        low: num(o.futs_lwpr),
        volume: num(o.acml_vol),
        openInterest: num(o.hts_otst_stpl_qty),
        basis: num(o.mrkt_basis),
        lastTradeDate:
          ltd && ltd.length === 8 ? `${ltd.slice(0, 4)}-${ltd.slice(4, 6)}-${ltd.slice(6, 8)}` : undefined,
        underlying:
          u && Number.isFinite(uVal) && uVal > 0
            ? { name: (u.hts_kor_isnm ?? "").trim(), value: uVal, changeRate: num(u.bstp_nmix_prdy_ctrt) }
            : undefined,
        fetchedAt: new Date().toISOString(),
        tried,
        notes: [
          session === "night"
            ? "KRX 야간선물(시장코드 CM). 야간 거래시간 18:00~익일 06:00 (KST)."
            : "지수선물 주간(시장코드 F). 정규장 08:45~15:45 (KST).",
          "등락은 한투 응답의 전일 대비 값 그대로입니다.",
        ],
      };
    } catch (err) {
      tried.push({ code, ok: false, note: err instanceof Error ? err.message.slice(0, 120) : "오류" });
    }
  }

  throw new Error(
    `${PRODUCT_NO[product].label} ${session === "night" ? "야간" : "주간"} 시세를 찾지 못했습니다. ` +
      `시도한 코드: ${tried.map((t) => `${t.code}(${t.note ?? ""})`).join(", ")}. ` +
      `code 파라미터로 종목코드를 직접 지정해 보세요.`,
  );
}
