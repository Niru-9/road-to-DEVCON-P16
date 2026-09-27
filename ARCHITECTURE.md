# Architecture

Notes on the decisions that were not obvious, and the two bugs worth knowing
about.

---

## 1. The no-charge guarantee is structural, not defensive

The product rule is "nobody pays for a notice she couldn't read". There are two
ways to get there and only one of them is honest.

**Upfront flow.** x402 verifies, settles, *then* runs the handler. Simple, and it
charges for work that may never happen. A caller whose notice was garbage would
have paid for a 422. This violates the rule.

**Authorization flow (the default).** x402 verifies, runs the handler, and
settles only if the handler succeeded. A 4xx from the handler cancels the
verified payment.

Meera uses the default. There is no `extra` block on either route in
`src/payment/x402.ts` — and `tests/rubric.test.ts` asserts its absence, because
the day someone "improves" this by adding `paymentFlow: "upfront"` the product
silently starts stealing money from people who sent garbage.

The handler's job is therefore narrow and load-bearing: **a parse failure must
surface as a 4xx, never as a 200 with nulls.** `src/http/paid-routes.ts` returns
`422` with the reasons, and never returns partial data with a 200.

```
no payment  →  402 + Payment-Required          (nothing taken)
bad payment →  402, no payment-response       (verify failed, nothing taken)
good payment, unreadable notice →  422        (released, nothing taken)
good payment, readable notice    →  200       (settled)
```

`onVerifiedPaymentCanceled` and `onAfterSettle` write both outcomes to the audit
trail, readable at `GET /v1/audit`, so the claim is checkable from outside the
process rather than taken on trust.

---

## 2. Price and recipient are unreachable from the request

`buildRoutesConfig(config)` takes a `ServerConfig` and nothing else. It cannot
see the request, because it is not given one. That is the whole defence — not a
filter, not a validation pass.

The prices are `BigInt` USDC base units (`500`, `3000`), converted to strings
only at the edge. `GET /v1/pricing` serialises them as **strings**, because
`JSON.stringify` throws on a `BigInt` and a `number` would lose precision above
2⁵³. That bug shipped once and is now covered by a test.

Tests send `price`, `amount`, `payTo` and `network` in the body, the query
string, and headers, and assert the quoted requirements are unchanged.

---

## 3. A 402 cannot be produced without the facilitator

**This is the bug that cost the most time, and it is worth writing down.**

The x402 resource server builds a 402 from the *kinds the facilitator
advertises*. It fetches those from the facilitator's `/supported` endpoint during
`initialize()`. Skip that handshake and the server does not know `exact` is
available on `eip155:11155111`, so it throws:

```
Facilitator does not support exact on eip155:11155111.
Make sure to call initialize() to fetch supported kinds from facilitators.
```

…which surfaces as **HTTP 500 on an unpaid request to a paid route**.

The original code had a `skipFacilitatorSync` flag on `buildServices`, passed
positionally into the `syncFacilitatorOnStart` argument of `paymentMiddleware`.
The names were inverses of each other, the default was `false`, and the live
server therefore never initialised. Every test passed, because the tests used
the same flag.

The lesson generalises past this bug: **a test suite that shares a configuration
flag with the code under test will happily confirm the bug.** The regression test
now stubs the facilitator, asserts it was asked what it supports, and asserts
402 rather than 500 — so a re-introduced skip fails loudly.

`tests/stub-facilitator.ts` answers `/supported` and *throws* if asked to verify
or settle. A hermetic test that accidentally reached the payment path fails
instead of passing quietly.

---

## 4. The free tier is deliberately weaker than the paid one

Meera's three commuter apps already hammer the parser for free; she wants the
*paid* calls to be worth something. So the free route answers exactly one
question — "will this API understand my notice?" — and returns no parsed
fields:

```jsonc
// POST /v1/validate, readable
{ "ok": true, "readable": true, "charged": false, "completeness": "full" }

// POST /v1/parse, paid, same notice
{ "ok": true, "charged": true, "notice": { "trainNumber": "12137", … } }
```

`completeness` is `"full"` or `"partial"` — enough for a caller to decide whether
to bother, not enough to skip paying. A test asserts the free body contains no
`notice` and no `trainNumber`.

---

## 5. Every response declares whether money moved

`charged` is present on **every** response — success, rejection, and the
internal 500. A caller should be able to check the product promise without
knowing which route or which failure path produced the response.

This started as a schema bug. `singleParseResponseSchema` declared
`{ ok, notice }` while the handler sent `{ ok, charged, notice }`, and because
the schema is `.strict()` the success path was, strictly speaking, unvalidated.
The schemas and the handlers now agree, and `rejectionResponseSchema` covers the
4xx side.

---

## 6. Rejections are all-or-nothing on purpose

`POST /v1/parse/bulk` does **not** return per-item success with a 200. One
unreadable notice fails the whole call with 422 and the whole call goes
uncharged.

The alternative — 200 with `parsed: [...]` and `failed: [...]` — looks friendlier
and is worse here. The caller cannot tell whether they were charged for the batch
without inspecting per-item outcomes, which pushes the "did I just get scammed?"
question onto every consumer. A flat 422 and an uncharged call is a promise the
caller can rely on without reading the body.

The schema still models `failed[]`, because the shape is declared in full and a
future partial-settlement route would need it.

---

## 7. Ordering inside `buildApp`

```
1. express.json({ limit: 256 KiB })   body cap, before anything reads it
2. x402 paymentMiddleware             calls next() for any path not in the config
3. free routes
4. paid route handlers
5. express.static(public/)
6. 404 handler
```

`paymentMiddleware` returns a plain `(req, res, next)` handler and calls `next()`
for paths that are not in the route config, so it is mounted at the app root and
the free routes need no skip list to keep in sync with the price table. There is
a test asserting the free routes answer 200 with no `payment-required` header.

The 256 KiB JSON cap is why an oversized *bulk* request is refused before the
handler runs, rather than being answered with a 413 from the handler.

---

## 8. Parsing: refuse rather than guess

The parser extracts a train number, a station, and a new expected time. Each is
required. If any is missing it collects a reason and the request is rejected:

```json
{ "ok": false, "charged": false, "error": "unparseable-notice",
  "reasons": ["no 5-digit train number found", "no station name/code found"],
  "excerpt": "The Mail is running late from Pune Junction…" }
```

Guessing would be worse than failing here: a wrong station code is a commuter
standing on the wrong platform, and this API charges per call. `broken-prose` in
the corpus exists to prove that prose containing train-number-shaped digits is
still rejected.

Two details worth knowing:

- **Digits are normalised before matching, not after.** Devanagari numerals are
  folded to ASCII in a copy of the input, so index arithmetic downstream is
  consistent. The original is kept for the excerpt.
- **The train number and name are masked before the station extractor runs**,
  so `DEEPAK EXPRESS STATION: PUNE` cannot have its station read out of the
  train's name.

`excerptOf()` collapses whitespace and, for whitespace-only input, returns
`(empty — 3 whitespace characters)` rather than an empty string — an error
message a human is about to read should never render as nothing.

---

## 9. Testnet only, enforced at startup

`ALLOWED_NETWORKS` is `["eip155:11155111"]` — Ethereum Sepolia, and nothing
else. `loadConfig` throws on anything else, so a mainnet identifier cannot be
introduced through an environment variable either, and a stale `.env` left over
from the previous Base-Sepolia configuration fails loudly at startup rather than
quietly reverting the migration. A test greps `src/` for `eip155:8453` (Base
mainnet) and fails if it finds one.

---

## 10. The demo UI pays nothing, and says so

`public/` is a static page with no build step and no client-side framework. It
exercises the free tier live, triggers the real 402, and displays the settlement
trail — everything it shows comes from a request the page actually made.

It does **not** pretend to pay. There is no x402 wallet in a browser here, and
signing one in is the subject of a different project. The page says so and hands
off to `npm run buy`. A demo that faked the payment step would be worse than one
that admits where it stops.
