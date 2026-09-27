# Meera's Railway Delay API

An HTTP API that turns raw Indian Railways delay notices into clean JSON, and
charges a fraction of a cent per call using **x402** on Ethereum Sepolia.

The notices Meera parses are messy half-structured text: a train number, a
station code, a new expected time, and sometimes a reason in Marathi or Hindi.
The API returns `{ train, station, expectedTime, reason? }`.

**Nobody pays for a notice Meera could not read.** An unparseable notice returns
`422` and the payment is cancelled, so the caller keeps their coin.

- **Network:** Ethereum Sepolia (`eip155:11155111`, chain id 11155111)
- **Token:** Circle USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, 6 decimals
- **Scheme:** x402 `exact`, EIP-712 domain `name: "USDC"`, `version: "2"`
- **Facilitator:** `https://facilitator.x402.rs`

## Install and run

Requires Node 20.12+ (22 LTS recommended).

```powershell
npm install
Copy-Item .env.example .env      # then set X402_PAY_TO yourself
npm start
```

Open **http://localhost:4021**. Stop with `Ctrl-C`.

`X402_PAY_TO` is the only value you must supply: a **public** Ethereum Sepolia
receiving address, `0x` followed by 40 hex characters. It is not a secret. Do not
paste it into chat; put it in your own `.env`.

The server refuses to start on any network other than `eip155:11155111`, so a
stale or wrong value fails loudly rather than quoting the wrong chain.

## Routes

Free — no payment, and the free tier never returns parsed fields:

| Route | Returns |
|---|---|
| `GET /v1/health` | liveness and the configured network |
| `GET /v1/pricing` | both prices, in base units and as dollars |
| `GET /v1/samples` | 12 sample notices (7 well-formed, 5 deliberately broken) |
| `GET /v1/samples/:id` | one sample notice |
| `GET /v1/audit` | settlements, cancellations and rejections |
| `POST /v1/validate` | `readable: true\|false` and a completeness rating |

Paid — the price and the recipient are server-owned and no request field can
change them:

| Route | Price |
|---|---|
| `POST /v1/parse` | **500 base units** = $0.0005 |
| `POST /v1/parse/bulk` | **3000 base units** = $0.003, up to 25 notices |

Prices are declared to x402 as an explicit `{ asset, amount, extra }` rather than
a dollar string, because the SDK has no default asset for Ethereum Sepolia. In
the x402 v2 wire format the amount field is `amount` (v1 called it
`maxAmountRequired`).

### Try the 402

```powershell
curl.exe -i -X POST http://localhost:4021/v1/parse `
  -H "content-type: application/json" `
  -d '{"notice":"TRAIN 12137 DEEPAK EXPRESS, STATION PUNE JN, EXPECTED DEPARTURE 19:30"}'
```

You get `402 Payment Required` with a `PAYMENT-REQUIRED` header naming the
network, the asset, the amount and the recipient.

## Tests

```powershell
npm run typecheck
npm test
```

Both were run on the code in this repository:

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | **108 / 108 passing**, 3 files |

`npm test` is hermetic: it stubs the facilitator, touches no network, and needs
no credentials. A migrated server was also started and asked for a paid route
with no payment; against the real hosted facilitator it answered `402` with
network `eip155:11155111` and asset `0x1c7D…C7238`.

## Limitations

1. **Live settlement has not been verified. No payment was ever made, so there
   is no transaction hash.** The 402 handshake is real; the settlement is not
   proven.
2. **There is no browser payment client.** The intended payer is MetaMask signing
   in the browser, but this repository does not ship that client: the demo page
   fetches the paid route and shows the real `402` it gets back rather than
   pretending to pay. To pay from a page, a client would have to read
   `PAYMENT-REQUIRED`, call `eth_signTypedData_v4` for a
   `TransferWithAuthorization` on `0x1c7D…C7238` with domain `name: "USDC"`,
   `version: "2"`, `chainId: 11155111`, then retry with a `PAYMENT-SIGNATURE`
   header. The server half is ready; the browser half is not written.
3. `npm run buy` and `npm run test:live` sign with a key from
   `EVM_PRIVATE_KEY`. They are **local throwaway-key test tools, not the
   intended payment path**, and they have not been run. The server, the free
   routes and the 402 all work with that variable left empty.
4. No browser testing was performed.

## License

MIT.
