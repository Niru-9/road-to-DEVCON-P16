/**
 * Declared output schema.
 *
 * The parser's result is validated against this BEFORE it is written to the
 * response body. If validation fails, the request fails — the API never
 * returns a half-filled object with a 200.
 */
import { z } from "zod";

/** HH:MM, 24-hour clock. */
export const timeStringSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "expected HH:MM on a 24-hour clock");

/** ISO calendar date, YYYY-MM-DD. */
export const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** Indian Railways station code: three letters, e.g. PUNE, PUNE, KYP. */
export const stationCodeSchema = z
  .string()
  .regex(/^[A-Z]{3,4}$/, "expected a 3-4 letter station code");

/** Five-digit train number. */
export const trainNumberSchema = z
  .string()
  .regex(/^\d{5}$/, "expected a 5-digit train number");

/** The language a reason line was written in, as detected from script. */
export const reasonLanguageSchema = z.enum(["en", "hi", "mr", "unknown"]);

/** Delay in whole minutes. Never a float — money and time are integers. */
export const delayMinutesSchema = z.number().int().min(0).max(60 * 72);

export const stationSchema = z.object({
  name: z.string().min(1).max(120),
  code: stationCodeSchema,
});

export const expectedTimeSchema = z.object({
  time: timeStringSchema,
  date: dateStringSchema.nullable(),
});

/**
 * The single declared shape of a parsed notice.
 * `.strict()` means an unexpected key is a validation failure, not a silent pass.
 */
export const parsedNoticeSchema = z
  .object({
    trainNumber: trainNumberSchema,
    /** Running partner of a paired train, e.g. 12137/12138. */
    pairedTrainNumber: trainNumberSchema.nullable(),
    trainName: z.string().min(1).max(120).nullable(),
    station: stationSchema,
    scheduled: expectedTimeSchema.nullable(),
    expected: expectedTimeSchema,
    /** Minutes late. Absent when the notice does not state a delay. */
    delayMinutes: delayMinutesSchema.nullable(),
    reason: z
      .object({
        text: z.string().min(1).max(400),
        language: reasonLanguageSchema,
      })
      .nullable(),
    /**
     * How much of the notice the rules actually understood.
     * "low" still validates, but callers can route on it.
     */
    completeness: z.enum(["full", "partial"]),
  })
  .strict();

export type ParsedNotice = z.infer<typeof parsedNoticeSchema>;

/** A notice that failed to parse, with the specific reasons why. */
export const parseFailureDetailSchema = z
  .object({
    noticeIndex: z.number().int().min(0),
    reasons: z.array(z.string().min(1)).min(1),
    /** Short, safe echo of the input so a caller can see what we choked on. */
    excerpt: z.string().max(160),
  })
  .strict();

/**
 * Every response this API sends declares whether money moved.
 *
 * It is not decoration. The product promise is "nobody pays for a notice she
 * could not read", and a caller should be able to check that on any response
 * without knowing which route or which failure path produced it.
 */
export const chargedFlagSchema = z.literal(true);

/** Body of a single-notice successful response. */
export const singleParseResponseSchema = z
  .object({
    ok: z.literal(true),
    charged: chargedFlagSchema,
    notice: parsedNoticeSchema,
  })
  .strict();

/** Body of a bulk response. All-or-nothing, so `failed` is empty on success. */
export const bulkParseResponseSchema = z
  .object({
    ok: z.literal(true),
    charged: chargedFlagSchema,
    parsed: z.array(parsedNoticeSchema),
    failed: z.array(parseFailureDetailSchema),
  })
  .strict();

/**
 * Body of a rejected request, on any route.
 *
 * `charged` is always `false` here. There is no code path in this server that
 * takes money and then answers 4xx — the `exact` scheme's authorization flow
 * releases the verified payment instead of settling it.
 */
export const rejectionResponseSchema = z
  .object({
    ok: z.literal(false),
    charged: z.literal(false),
    error: z.string().min(1),
    detail: z.string().min(1),
    reasons: z.array(z.string().min(1)).optional(),
    excerpt: z.string().optional(),
  })
  .strict();
