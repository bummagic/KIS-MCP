import { describe, expect, it } from "vitest";
import { candidateCodes, nearestContract, secondThursday } from "../src/tools/domesticFutures.js";

describe("domesticFutures", () => {
  it("둘째 목요일", () => {
    expect(secondThursday(2026, 12)).toBe(10);
    expect(secondThursday(2027, 3)).toBe(11);
  });
  it("근월물 산출 (분기물)", () => {
    expect(nearestContract(true, new Date("2026-11-25T13:00:00Z"))).toEqual({ year: 2026, month: 12 });
    // 만기일 야간(12/10 22:00 KST) → 2027년 3월물
    expect(nearestContract(true, new Date("2026-12-10T13:00:00Z"))).toEqual({ year: 2027, month: 3 });
    expect(nearestContract(false, new Date("2026-11-25T13:00:00Z"))).toEqual({ year: 2026, month: 12 });
  });
  it("후보 코드", () => {
    expect(candidateCodes("KOSPI200", "night", { year: 2026, month: 12 })).toEqual([
      "A01612",
      "1016C000",
      "1016C",
      "A0161200",
    ]);
    expect(candidateCodes("KOSDAQ150", "day", { year: 2027, month: 3 })[0]).toBe("A06703");
  });
});
