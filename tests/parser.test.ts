/**
 * Domain tests: the parser and its declared output schema.
 *
 * These cover the "does the product actually work" half of the rubric. The
 * payment behaviour is covered in rubric.test.ts.
 */
import { describe, expect, it } from "vitest";
import { parseNotice, safeParseNotice } from "../src/domain/parser.js";
import { parsedNoticeSchema } from "../src/domain/schema.js";
import { NoticeUnparseableError } from "../src/domain/errors.js";
import { MAX_NOTICE_CHARS } from "../src/domain/limits.js";
import { BROKEN_SAMPLES, SAMPLES, WELL_FORMED_SAMPLES } from "../src/data/samples.js";

describe("sample corpus", () => {
  it("ships at least ten notices", () => {
    expect(SAMPLES.length).toBeGreaterThanOrEqual(10);
  });

  it("ships at least five well-formed and five broken notices", () => {
    expect(WELL_FORMED_SAMPLES.length).toBeGreaterThanOrEqual(5);
    expect(BROKEN_SAMPLES.length).toBeGreaterThanOrEqual(5);
  });

  it("has unique ids", () => {
    const ids = SAMPLES.map((sample) => sample.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("parseNotice over the whole corpus", () => {
  it.each(WELL_FORMED_SAMPLES.map((s) => [s.id, s.text] as const))(
    "reads %s",
    (_id, text) => {
      const notice = parseNotice(text);
      // Every well-formed sample must satisfy the declared output schema.
      expect(() => parsedNoticeSchema.parse(notice)).not.toThrow();
    },
  );

  it.each(BROKEN_SAMPLES.map((s) => [s.id, s.text] as const))(
    "rejects %s with a reason",
    (_id, text) => {
      const outcome = safeParseNotice(text);
      if (outcome.ok) {
        throw new Error("expected this notice to be unreadable");
      }
      expect(outcome.failure.reasons.length).toBeGreaterThan(0);
      expect(outcome.failure.excerpt.length).toBeLessThanOrEqual(161);
    },
  );
});

describe("field extraction", () => {
  it("reads a paired train number and a train name", () => {
    const notice = parseNotice(
      "TRAIN 12137/12138 DEEPAK EXPRESS\nSTATION: PUNE JN (PUNE)\nEXPECTED DEPARTURE: 19:30",
    );
    expect(notice.trainNumber).toBe("12137");
    expect(notice.pairedTrainNumber).toBe("12138");
    expect(notice.trainName).toBe("DEEPAK EXPRESS");
  });

  it("reads Devanagari numerals", () => {
    const notice = parseNotice(
      "गाडी क्र. १२१३७ दीपक एक्सप्रेस\nस्टेशन: पुणे जंक्शन (PUNE)\nनवीन: १९:३०",
    );
    expect(notice.trainNumber).toBe("12137");
    expect(notice.expected.time).toBe("19:30");
    expect(notice.station.name).toBe("पुणे जंक्शन");
    expect(notice.station.code).toBe("PUNE");
  });

  it("converts a 12-hour clock using the meridiem inside the token", () => {
    const notice = parseNotice(
      "Train 12955 RAJDHANI EXP at VARANASI (BSB) EXPECTED ARRIVAL 10:15 PM",
    );
    expect(notice.expected.time).toBe("22:15");
  });

  it("reads an ISO date next to the time", () => {
    const notice = parseNotice(
      "TRAIN 12137 DEEPAK EXPRESS\nSTATION: PUNE JN (PUNE)\nEXPECTED DEPARTURE: 19:30 28/08/2026",
    );
    expect(notice.expected.date).toBe("2026-08-28");
  });

  it("does not mistake a year for a board time", () => {
    const notice = parseNotice(
      "Train 12955 RAJDHANI EXP at VARANASI (BSB) SCHEDULED DEPARTURE 8:45 PM 27/08/2026 EXPECTED ARRIVAL 10:15 PM",
    );
    expect(notice.scheduled?.time).toBe("20:45");
    expect(notice.expected.time).toBe("22:15");
  });

  it("reads an unlabelled board line positionally", () => {
    const notice = parseNotice("12137 DEEPAK EXP PUNE JN (PUNE) 1810 1930 80 MINUTES LATE");
    expect(notice.scheduled?.time).toBe("18:10");
    expect(notice.expected.time).toBe("19:30");
    expect(notice.delayMinutes).toBe(80);
  });

  it("reads an arrow pair", () => {
    const notice = parseNotice(
      "12264 NDLS RAJDHANI, Station: KHAZATPUR (KZP), Dep 20:15 -> 22:05",
    );
    expect(notice.scheduled?.time).toBe("20:15");
    expect(notice.expected.time).toBe("22:05");
  });

  it.each([
    ["80 MIN", 80],
    ["1:20 hrs", 80],
    ["2h 25m late", 145],
    ["3 hours", 180],
    ["45 minutes", 45],
  ])("reads a delay of %s as %i minutes", (text, expected) => {
    const notice = parseNotice(
      `TRAIN 12137 DEEPAK EXPRESS\nSTATION: PUNE JN (PUNE)\nEXPECTED DEPARTURE: 19:30\nDELAY: ${text}`,
    );
    expect(notice.delayMinutes).toBe(expected);
  });

  it("detects the reason language", () => {
    const marathi = parseNotice(
      "गाडी क्र. 12137 दीपक एक्सप्रेस\nस्टेशन: पुणे जं. (PUNE)\nयशा वेळ 19:30\nकारण: पावसामुळे विलंब",
    );
    expect(marathi.reason?.language).toBe("mr");

    const english = parseNotice(
      "TRAIN 12137 DEEPAK EXPRESS\nSTATION: PUNE JN (PUNE)\nEXPECTED DEPARTURE: 19:30\nREASON: Waterlogging",
    );
    expect(english.reason?.language).toBe("en");
  });

  it("leaves the reason null rather than inventing one", () => {
    const notice = parseNotice(
      "TRAIN 12137 DEEPAK EXPRESS\nSTATION: PUNE JN (PUNE)\nEXPECTED DEPARTURE: 19:30",
    );
    expect(notice.reason).toBeNull();
    expect(notice.completeness).toBe("partial");
  });
});

describe("unreadable notices", () => {
  it.each([
    ["", /empty/i],
    ["   ", /empty/i],
    ["nothing useful here", /train number/i],
    ["TRAIN 12137 DEEPAK EXPRESS", /station/i],
    ["STATION: PUNE JN (PUNE) EXPECTED: 19:30", /train number/i],
  ])("rejects %j", (text, pattern) => {
    expect(() => parseNotice(text)).toThrow(NoticeUnparseableError);
    const outcome = safeParseNotice(text);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.reasons.join(" ")).toMatch(pattern);
    }
  });

  it("rejects a notice over the size cap", () => {
    const padding = "x".repeat(MAX_NOTICE_CHARS);
    const outcome = safeParseNotice(`TRAIN 12137 DEEPAK EXPRESS STATION: PUNE JN (PUNE) ${padding}`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.reasons.join(" ")).toMatch(/over the .* limit/i);
    }
  });

  it("reports every missing required field, not just the first", () => {
    const outcome = safeParseNotice("The train is late, sorry.");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.reasons).toHaveLength(3);
    }
  });
});

describe("declared output schema", () => {
  it("rejects an object with an unexpected key", () => {
    const notice = parseNotice(
      "TRAIN 12137 DEEPAK EXPRESS\nSTATION: PUNE JN (PUNE)\nEXPECTED DEPARTURE: 19:30",
    );
    const result = parsedNoticeSchema.safeParse({ ...notice, sneaky: true });
    expect(result.success).toBe(false);
  });

  it("rejects a time that is not HH:MM", () => {
    const notice = parseNotice(
      "TRAIN 12137 DEEPAK EXPRESS\nSTATION: PUNE JN (PUNE)\nEXPECTED DEPARTURE: 19:30",
    );
    const result = parsedNoticeSchema.safeParse({
      ...notice,
      expected: { time: "7:5", date: null },
    });
    expect(result.success).toBe(false);
  });
});
