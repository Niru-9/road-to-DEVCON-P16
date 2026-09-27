/**
 * The parser: messy station notice text in, clean validated JSON out.
 *
 * Meera's notices are half-structured. They come off notice boards, group
 * chats and hand-written slips, so they mix English, Hindi and Marathi, 12-
 * and 24-hour clocks, Latin and Devanagari digits, and wildly inconsistent
 * labels. This module is a set of small, independent extractors rather than
 * one clever grammar: each one either recognises its field or abstains.
 *
 * Contract: `trainNumber`, `station` and `expected` are REQUIRED. If any of
 * them cannot be read, the parse fails loudly (NoticeUnparseableError) and
 * the caller is never charged. `reason` is optional, because plenty of
 * readable notices simply do not give one.
 */
import {
  delayMinutesSchema,
  type ParsedNotice,
  reasonLanguageSchema,
} from "./schema.js";
import { NoticeUnparseableError, excerptOf, type ParseFailure } from "./errors.js";
import { MAX_NOTICE_CHARS } from "./limits.js";

/** Devanagari digits -> ASCII, so one set of regexes handles both scripts. */
const DEVANAGARI_DIGITS: Record<string, string> = {
  "०": "0", "१": "1", "२": "2", "३": "3", "४": "4",
  "५": "5", "६": "6", "७": "7", "८": "8", "९": "9",
};

function normaliseDigits(input: string): string {
  return input.replace(/[०-९]/g, (d) => DEVANAGARI_DIGITS[d] ?? d);
}

type Extraction = string | null;

/** Collapse all whitespace so patterns are not defeated by line breaks. */
function flatten(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

const TRAIN_TERMS = "EXPRESS|EXP|MAIL|PASSENGER|SUPERFAST|SF|TELEGRAM|TG|INTERNATIONAL|DEMU|EMU|PASS|PAS";

/** `12137`, or a paired `12137/12138`. Bounded to exactly five digits. */
function extractTrainNumber(text: string): { number: string; paired: string | null } | null {
  const m = text.match(new RegExp(String.raw`(?<!\d)(\d{5})(?:\s*\/\s*(\d{5}))?(?!\d)`));
  if (!m || m[1] === undefined) return null;
  return { number: m[1], paired: m[2] ?? null };
}

/**
 * Words that introduce a station rather than being part of its name.
 * Marathi and Hindi labels are here too, because notices use them freely.
 */
const STATION_LABEL_PREFIX =
  /^(?:train\s*no\.?|train\s*number|train|station|stn\.?|at|from|छोडण्याची|प्रस्थान|स्टेशन|स्थान)\s+/iu;

/**
 * Blank out character ranges so a later extractor cannot read them.
 *
 * Index-based rather than string-replace based: masking the train number
 * first would make `indexOf(trainName)` fail, because the name would no
 * longer be contiguous with its surroundings.
 */
function maskRanges(text: string, ranges: readonly { at: number; length: number }[]): string {
  const chars = text.split("");
  for (const { at, length } of ranges) {
    for (let i = at; i < at + length; i += 1) {
      if (i >= 0 && i < chars.length) chars[i] = " ";
    }
  }
  return chars.join("");
}

/**
 * Word characters for station and train names.
 *
 * `\p{M}` (combining marks) is essential, not decorative: Devanagari encodes
 * consonant clusters as base letter + virama, so "जंक्शन" contains marks that
 * a `\p{L}`-only class would cut in half and yield "शन".
 */
const WORD_CHAR = String.raw`[\p{L}\p{M}][\p{L}\p{M}.'’-]*`;

/** The trailing run of word-tokens immediately before `endIndex`. */
function wordsBefore(text: string, endIndex: number, maxTokens: number): string | null {
  const window = text.slice(0, endIndex);
  // The token separator is a SINGLE space, not `\s+`. The text has already
  // been whitespace-flattened, so a multi-space run can only come from a mask
  // — and that is exactly the barrier that stops the window reaching back
  // past a masked train number to grab the word "Train".
  const pattern = new RegExp(
    String.raw`(${WORD_CHAR}(?: ${WORD_CHAR}){0,${maxTokens - 1}})\s*$`,
    "u",
  );
  const found = pattern.exec(window)?.[1]?.trim();
  if (found === undefined || found.length === 0) return null;
  return found.replace(STATION_LABEL_PREFIX, "").trim() || null;
}

/**
 * Station extraction.
 *
 * `text` must already have the train number and train name masked out —
 * otherwise "MASARINGA EXP. KSR Bengaluru (SBC)" yields the train name as
 * part of the station. Station names may be in any script, so the name
 * pattern is Unicode-aware and only the three-letter code is ASCII.
 */
function extractStation(text: string): { name: string; code: string } | null {
  const coded = /\(\s*([A-Za-z]{3,4})\s*\)/.exec(text);
  if (coded?.[1] !== undefined) {
    const code = coded[1].toUpperCase();
    const name = wordsBefore(text, coded.index, 3) ?? code;
    return { name, code };
  }

  // No parenthesised code: fall back to "at/from <Name>" up to a delimiter.
  const bare = new RegExp(
    String.raw`\b(?:at|from)\s+(${WORD_CHAR}(?:\s+${WORD_CHAR}){0,5}?)(?=\s*(?:\d{1,2}[:.]\d{2}|->|,|\||$))`,
    "u",
  ).exec(text);
  if (bare?.[1] !== undefined) {
    const name = bare[1].replace(STATION_LABEL_PREFIX, "").trim();
    if (name.length > 0) {
      const code = name.split(/\s+/).at(-1);
      if (code !== undefined && /^[A-Za-z]{3,4}$/.test(code)) {
        return { name, code: code.toUpperCase() };
      }
    }
  }
  return null;
}

type Clock = { time: string; date: string | null };

/**
 * Read a clock token.
 *
 * The meridiem may be inside the captured token ("10:15 PM") or just after it
 * in the surrounding text, so both are checked. Board-style four-digit times
 * are also accepted.
 */
function readClock(raw: string, following: string): Clock | null {
  const token = raw.trim();

  const hhmm = token.match(/^(\d{1,2})[:.](\d{2})\s*(AM|PM|am|pm)?$/);
  if (hhmm?.[1] !== undefined && hhmm[2] !== undefined) {
    return clockFrom(Number(hhmm[1]), Number(hhmm[2]), hhmm[3] ?? following);
  }

  const board = token.match(/^(\d{2})(\d{2})$/);
  if (board?.[1] !== undefined && board[2] !== undefined) {
    return clockFrom(Number(board[1]), Number(board[2]), following);
  }
  return null;
}

function clockFrom(hours: number, minutes: number, meridiemSource: string): Clock | null {
  if (minutes > 59) return null;
  const hours24 = to24h(hours, meridiemSource);
  if (hours24 === null) return null;
  return {
    time: `${String(hours24).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
    date: readDate(meridiemSource),
  };
}

function to24h(hours12: number, following: string): number | null {
  const meridiem = following.match(/\b(AM|PM|am|pm)\b/);
  if (meridiem) {
    if (hours12 < 1 || hours12 > 12) return null;
    const isPm = meridiem[1]!.toLowerCase() === "pm";
    return isPm ? (hours12 % 12) + 12 : hours12 % 12;
  }
  if (hours12 > 23) return null;
  return hours12;
}

/** `28/08`, `28-08-2026` or `2026-08-28` -> `2026-08-28`. */
function readDate(text: string): string | null {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (dmy?.[1] !== undefined && dmy[2] !== undefined) {
    const day = dmy[1].padStart(2, "0");
    const month = dmy[2].padStart(2, "0");
    if (Number(dmy[1]) > 31 || Number(dmy[2]) > 12) return null;
    const yearPart = dmy[3];
    if (yearPart === undefined) return null;
    const year = yearPart.length === 2 ? `20${yearPart}` : yearPart;
    return `${year}-${month}-${day}`;
  }
  return null;
}

/**
 * Time labels.
 *
 * The optional trailing "वेळ"/"समय" (Marathi/Hindi for "time") is part of the
 * label rather than a separator, because notices write "यशा वेळ 19:30" with a
 * word between the label and the clock.
 */
const EXPECTED_LABELS = [
  "EXPECTED(?:\\s+(?:DEPARTURE|ARRIVAL|TIME|UPDATED))?",
  "REVISED",
  "UPDATED",
  "ACTUAL",
  "PREDICTED",
  "प्रत्यक्षित(?:\\s*वेळ)?",
  "अपेक्षित(?:\\s*वेळ)?",
  "यशा(?:\\s*वेळ)?",
  "नवीन(?:\\s*वेळ)?",
].join("|");

const SCHEDULED_LABELS = [
  "SCHEDULED(?:\\s+(?:DEPARTURE|ARRIVAL|TIME))?",
  "DEP(?:ARTURE)?",
  "ARR(?:IVAL)?",
  "छोडण्याची(?:\\s*वेळ)?",
  "प्रस्थान(?:\\s*वेळ)?",
].join("|");

/** Find the labelled time for either label set, plus a bare "A -> B" pair. */
function extractLabelledTime(text: string, labels: string): Clock | null {
  const labelled = new RegExp(
    String.raw`(?:${labels})\s*[:\-–]?\s*(\d{1,2}[:.]\d{2}\s*(?:AM|PM|am|pm)?|\d{4})`,
  ).exec(text);
  if (labelled?.[1] !== undefined) {
    const hit = readClock(labelled[1], text.slice(labelled.index + labelled[0].length));
    if (hit) return hit;
  }
  return null;
}

/** `1810 -> 1930`, `18:10 to 19:30`. */
function extractArrowTime(text: string): { scheduled: Clock; expected: Clock } | null {
  const m = text.match(
    /(\d{1,2}[:.]\d{2}\s*(?:AM|PM|am|pm)?|\d{4})\s*(?:->|-->|=>|to|→)\s*(\d{1,2}[:.]\d{2}\s*(?:AM|PM|am|pm)?|\d{4})/i,
  );
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const start = m.index ?? 0;
  const afterFirst = text.slice(start + m[1].length);
  const afterSecond = text.slice(start + m[0].length);
  const scheduled = readClock(m[1], afterFirst);
  const expected = readClock(m[2], afterSecond);
  if (!scheduled || !expected) return null;
  return { scheduled, expected };
}

function extractDelayMinutes(text: string): number | null {
  // Board form "1:20 HRS" — hours and minutes joined by a colon.
  const colonHms = text.match(/(\d{1,2}):([0-5]\d)\s*(?:h|hrs?|hours?)/i);
  if (colonHms?.[1] !== undefined && colonHms[2] !== undefined) {
    return Number(colonHms[1]) * 60 + Number(colonHms[2]);
  }

  const hms = text.match(/(\d{1,2})\s*(?:h|hrs?|hours?)\s*(\d{1,2})?\s*(?:m|min|mins?|minutes?)?/i);
  if (hms?.[1] !== undefined) {
    const hours = Number(hms[1]);
    const minutes = hms[2] === undefined ? 0 : Number(hms[2]);
    return hours * 60 + minutes;
  }

  const hoursOnly = text.match(/(\d{1,2})\s*(?:h|hrs?|hours?)\b/i);
  if (hoursOnly?.[1] !== undefined) return Number(hoursOnly[1]) * 60;

  const minutes = text.match(/(\d{1,3})\s*(?:m|min|mins|minutes?)\b/i);
  if (minutes?.[1] !== undefined) return Number(minutes[1]);

  return null;
}

const REASON_LABELS = "REASON|कारण|कारणः|KRITika|কারণ";

function detectLanguage(reason: string): (typeof reasonLanguageSchema)["_output"] {
  const devanagari = /[ऀ-ॿ]/.test(reason);
  if (!devanagari) return "en";
  if (/मुळे|साठी|आहे|नाही|पाणी|साचले|सुरू|उशीर/.test(reason)) return "mr";
  if (/के\s*कारण|की\s*वजह|नहीं|गया\s*है|रहा\s*है|सिग्नल/.test(reason)) return "hi";
  return "unknown";
}

function extractReason(text: string): { text: string; language: (typeof reasonLanguageSchema)["_output"] } | null {
  const labelled = new RegExp(String.raw`(?:${REASON_LABELS})\s*[:\-–]\s*(.+?)(?=\s*(?:STATION|EXPECTED|SCHEDULED|DELAY|\d{1,2}[:.]\d{2})|$)`, "i").exec(
    text,
  );
  const body = labelled?.[1]?.trim();
  if (body !== undefined && body.length > 0) {
    return { text: body.slice(0, 400), language: detectLanguage(body) };
  }

  const english = /\b(?:due to|because of)\s+(.+?)(?=\s*(?:STATION|EXPECTED|SCHEDULED|DELAY|\d{1,2}[:.]\d{2})|$)/i.exec(
    text,
  );
  if (english?.[1] !== undefined && english[1].trim().length > 0) {
    const value = english[1].trim().slice(0, 400);
    return { text: value, language: "en" };
  }
  return null;
}

function extractTrainName(text: string, afterTrainNumber: number): string | null {
  const tail = text.slice(afterTrainNumber);
  const m = new RegExp(String.raw`\s+((?:[A-Za-z]+\s+){0,3}?(?:${TRAIN_TERMS}))\b`).exec(tail);
  const name = m?.[1]?.replace(/\s+/g, " ").trim();
  if (name === undefined || name.length === 0) return null;
  if (name.length > 120) return null;
  return name;
}

/**
 * Parse one raw notice. Throws NoticeUnparseableError when the notice cannot
 * be read — the caller must turn that into a 4xx and must not settle payment.
 */
export function parseNotice(raw: string): ParsedNotice {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw unparseable(["notice is empty"], raw);
  }
  if (raw.length > MAX_NOTICE_CHARS) {
    throw unparseable([`notice is ${raw.length} characters, over the ${MAX_NOTICE_CHARS} limit`], raw);
  }

  // Keep the original for the excerpt; normalise a copy for matching.
  const text = flatten(normaliseDigits(raw));
  const reasons: string[] = [];

  const train = extractTrainNumber(text);
  if (train === null) {
    reasons.push("no 5-digit train number found");
  }

  // Mask the train number and train name so the station extractor cannot read
  // either of them as part of the station. The train name is located in the
  // ORIGINAL text (just after the number) so that a leading "Train No" cannot
  // be swallowed into the name.
  const ranges: { at: number; length: number }[] = [];
  let trainName: string | null = null;
  if (train !== null) {
    const numberAt = text.indexOf(train.number);
    const numberLength = train.number.length + (train.paired === null ? 0 : train.paired.length + 1);
    ranges.push({ at: numberAt, length: numberLength });
    trainName = extractTrainName(text, numberAt + train.number.length);
    if (trainName !== null) {
      const nameAt = text.indexOf(trainName, numberAt);
      if (nameAt !== -1) ranges.push({ at: nameAt, length: trainName.length });
    }
  }
  const masked = maskRanges(text, ranges);

  const station = extractStation(masked);
  if (station === null) {
    reasons.push("no station name/code found");
  }

  const arrow = extractArrowTime(text);
  let expected: Clock | null = arrow?.expected ?? extractLabelledTime(text, EXPECTED_LABELS);
  let scheduled: Clock | null = arrow?.scheduled ?? extractLabelledTime(text, SCHEDULED_LABELS);

  // A notice with no time label at all: read the two times positionally, which
  // is how a two-column platform board works. Board-style times carry no
  // colons ("1810 1930"), so those are matched too.
  //
  // This must run BEFORE the unreadable check — a board line is perfectly
  // readable, it just has no labels.
  if (expected === null || scheduled === null) {
    const colonTimes = [...text.matchAll(/\b(\d{1,2}:\d{2})\b/g)].map((m) => m[1]!);
    // A bare four-digit token is only a clock if it is not part of a date.
    // Without this guard "27/08/2026" yields a phantom 20:26.
    const boardTimes = [...text.matchAll(/(?<![\d:/-])(\d{4})(?![\d:/-])/g)].map((m) => m[1]!);
    const candidates = [...colonTimes, ...boardTimes]
      .map((token) => readClock(token, ""))
      .filter((clock): clock is Clock => clock !== null);
    if (candidates.length >= 2) {
      const first = candidates[0]!;
      const last = candidates.at(-1)!;
      if (last.time > first.time) {
        scheduled ??= first;
        expected ??= last;
      }
    }
  }

  if (expected === null) {
    reasons.push("no new expected time found");
  }

  if (reasons.length > 0) {
    throw unparseable(reasons, raw);
  }

  const delayCandidate = extractDelayMinutes(text);
  const delayMinutes = delayCandidate === null ? null : delayMinutesSchema.parse(delayCandidate);
  const reason = extractReason(text);

  const notice: ParsedNotice = {
    trainNumber: train!.number,
    pairedTrainNumber: train!.paired,
    trainName,
    station: station!,
    scheduled,
    expected: expected!,
    delayMinutes,
    reason,
    completeness: scheduled !== null && reason !== null ? "full" : "partial",
  };

  return notice;
}

function unparseable(reasons: string[], raw: string): NoticeUnparseableError {
  const failure: ParseFailure = {
    kind: "parse-failure",
    reasons,
    excerpt: excerptOf(raw),
  };
  return new NoticeUnparseableError(failure);
}

/** Non-throwing variant, for bulk work where one bad notice must not abort the rest. */
export type ParseOutcome =
  | { ok: true; notice: ParsedNotice }
  | { ok: false; failure: ParseFailure };

export function safeParseNotice(raw: string): ParseOutcome {
  try {
    return { ok: true, notice: parseNotice(raw) };
  } catch (error) {
    if (error instanceof NoticeUnparseableError) {
      return { ok: false, failure: error.failure };
    }
    throw error;
  }
}
