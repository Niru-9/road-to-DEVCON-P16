/**
 * Meera demo controller.
 *
 * The browser cannot pay — there is no x402 wallet here, and P3 is the project
 * that handles identity. So this page does the honest thing: it exercises the
 * free tier live, it triggers the real 402 handshake live, and it shows the
 * settlement trail as the server reports it. Anything it displays comes from
 * a request the page actually made.
 */

const $ = (id) => document.getElementById(id);

const els = {
  networkLabel: $("network-label"),
  networkBadge: $("network-badge"),
  pricingBadge: $("pricing-badge"),
  priceStrip: $("price-strip"),
  sampleButtons: $("sample-buttons"),
  notice: $("notice"),
  noticeCount: $("notice-count"),
  checkBtn: $("check-btn"),
  clearBtn: $("clear-btn"),
  verdict: $("verdict"),
  paywallBtn: $("paywall-btn"),
  handshake: $("handshake"),
  hsStatus: $("hs-status"),
  hsPrice: $("hs-price"),
  hsNetwork: $("hs-network"),
  hsPayTo: $("hs-payto"),
  hsNote: $("hs-note"),
  buyCommand: $("buy-command"),
  ledger: $("ledger"),
};

const MAX_CHARS = 4000;

/* ------------------------------------------------------------------ net -- */

async function loadConfig() {
  try {
    const response = await fetch("/v1/pricing");
    if (!response.ok) throw new Error(`pricing returned ${response.status}`);
    const pricing = await response.json();

    els.networkLabel.textContent = pricing.network;
    els.networkBadge.title =
      "This build refuses to start on a non-testnet network. Prices are in USDC base units.";

    els.priceStrip.replaceChildren(
      ...pricing.routes.map((route) => {
        const li = document.createElement("li");
        const price = document.createElement("b");
        price.textContent = route.price;
        const what = document.createElement("span");
        what.textContent = `${route.route.replace("POST ", "")} — ${route.summary.toLowerCase()}`;
        li.append(price, what);
        return li;
      }),
    );
    return pricing;
  } catch {
    els.networkLabel.textContent = "server offline";
    els.pricingBadge.textContent = "start the server to see live data";
    return null;
  }
}

/* -------------------------------------------------------------- samples -- */

async function loadSamples() {
  try {
    const response = await fetch("/v1/samples");
    const { samples } = await response.json();

    els.sampleButtons.replaceChildren(
      ...samples.map((sample) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = sample.kind === "broken" ? "chip chip--broken" : "chip";
        button.textContent = sample.id;
        button.title = `${sample.label} — ${sample.reason ?? ""}`;
        button.setAttribute("aria-pressed", "false");
        button.addEventListener("click", () => {
          els.notice.value = sample.text;
          for (const other of els.sampleButtons.children) {
            other.setAttribute("aria-pressed", String(other === button));
          }
          syncCount();
          els.notice.focus();
          runValidate();
        });
        return button;
      }),
    );
  } catch {
    els.sampleButtons.replaceChildren(
      Object.assign(document.createElement("p"), {
        className: "ledger__empty",
        textContent: "samples unavailable — is the server running?",
      }),
    );
  }
}

/* ---------------------------------------------------------------- input -- */

function syncCount() {
  const length = els.notice.value.length;
  els.noticeCount.textContent = `${length} / ${MAX_CHARS} characters`;
  const over = length > MAX_CHARS;
  els.noticeCount.classList.toggle("field__count--over", over);
  els.notice.setAttribute("aria-invalid", String(over));
}

function clearPressed() {
  for (const chip of els.sampleButtons.children) chip.setAttribute("aria-pressed", "false");
}

els.notice.addEventListener("input", () => {
  clearPressed();
  syncCount();
});

/* ------------------------------------------------------------- validate -- */

function setVerdict(kind, headline, detail, extras) {
  els.verdict.className = `verdict verdict--${kind}`;
  els.verdict.replaceChildren();

  const h = document.createElement("p");
  h.className = "verdict__headline";
  h.textContent = headline;

  const d = document.createElement("p");
  d.className = "verdict__detail";
  d.textContent = detail;

  els.verdict.append(h, d);

  if (extras?.reasons?.length) {
    const ul = document.createElement("ul");
    ul.className = "verdict__list";
    for (const reason of extras.reasons) {
      const li = document.createElement("li");
      li.textContent = reason;
      ul.append(li);
    }
    els.verdict.append(ul);
  }

  if (extras?.promise) {
    const p = document.createElement("p");
    p.className = "verdict__promise";
    p.append(document.createTextNode("If you had sent this to "));
    const code = document.createElement("code");
    code.textContent = extras.route;
    const strong = document.createElement("strong");
    strong.textContent = extras.promise;
    p.append(code, document.createTextNode(", it would have returned a 4xx and "), strong);
    els.verdict.append(p);
  }
}

async function runValidate() {
  const notice = els.notice.value.trim();
  if (notice.length === 0) {
    setVerdict(
      "idle",
      "Nothing to check",
      "Paste a notice, or load one of the samples above. Checking readability is free.",
    );
    return;
  }

  els.checkBtn.disabled = true;
  setVerdict("idle", "Checking…", "Asking POST /v1/validate whether Meera can read this.");

  try {
    const response = await fetch("/v1/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notice }),
    });
    const body = await response.json();

    if (!response.ok) {
      setVerdict("bad", `Rejected — ${response.status} ${body.error ?? ""}`.trim(), body.detail ?? "");
      return;
    }

    if (body.readable) {
      setVerdict(
        "good",
        "Readable — and still free",
        `The paid route would return a complete record (${body.completeness}). This verdict leaked no parsed field, so it cannot replace the paid call.`,
      );
    } else {
      setVerdict("bad", "Not readable", "Meera could not extract the required fields.", {
        reasons: body.reasons,
      });
    }
  } catch {
    setVerdict("bad", "Request failed", "The free route did not answer. Is the server running?");
  } finally {
    els.checkBtn.disabled = false;
  }
}

/* ------------------------------------------------------------ handshake -- */

function base64ToJson(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function triggerPaywall() {
  const notice = els.notice.value.trim();
  if (notice.length === 0) {
    await loadSamples();
  }

  els.paywallBtn.disabled = true;
  els.handshake.hidden = false;
  els.hsNote.textContent = "Asking the server…";

  try {
    const response = await fetch("/v1/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        notice:
          notice.length > 0
            ? notice
            : "TRAIN 12137 DEEPAK EXPRESS, PUNE JN, EXPECTED DEPARTURE 19:30",
        price: "$0.00",
        payTo: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
    });

    els.hsStatus.textContent = `${response.status} ${response.statusText || ""}`.trim();
    els.hsStatus.className = "handshake__val handshake__val--status";

    const header = response.headers.get("payment-required");
    if (header) {
      const { accepts } = base64ToJson(header);
      const option = accepts[0];
      els.hsPrice.textContent = option.amount;
      els.hsPrice.className = "handshake__val handshake__val--price";
      els.hsNetwork.textContent = option.network;
      els.hsPayTo.textContent = option.payTo;
      els.hsNote.textContent =
        `Price and recipient are the server's, not yours — the page just asked for ` +
        `$0.00 paid to 0xdead… and still got a quote for ${option.amount} USDC base units ` +
        `going to ${option.payTo}.`;
    } else if (response.headers.get("payment-response")) {
      // A browser with an x402 wallet would land here.
      els.hsPrice.textContent = "settled";
      els.hsPrice.className = "handshake__val handshake__val--price";
      els.hsNote.textContent = "A payment was made and settled. Check GET /v1/audit below.";
      els.hsStatus.className = "handshake__val";
      els.hsStatus.textContent = "200 OK";
    } else {
      els.hsNote.textContent = response.status === 402
        ? "No Payment-Required header — the middleware is not attached to this route."
        : `Unexpected response. Body: ${JSON.stringify(await response.json()).slice(0, 200)}`;
    }
  } catch {
    els.hsNote.textContent = "Request failed. Is the server running?";
  } finally {
    els.paywallBtn.disabled = false;
  }
}

/* --------------------------------------------------------------- ledger -- */

async function loadAudit() {
  try {
    const response = await fetch("/v1/audit?limit=8");
    const { events } = await response.json();

    if (!events.length) {
      els.ledger.replaceChildren(
        Object.assign(document.createElement("li"), {
          className: "ledger__empty",
          textContent: "No payments yet. Run npm run buy -- --sample en-structured-pune",
        }),
      );
      return;
    }

    els.ledger.replaceChildren(
      ...events.map((event) => {
        const li = document.createElement("li");
        li.dataset.kind = event.kind;

        const kind = document.createElement("span");
        kind.className = "ledger__kind";
        kind.textContent = event.kind;

        const meta = document.createElement("span");
        meta.className = "ledger__meta";
        meta.textContent = describe(event);

        li.append(kind, meta);
        return li;
      }),
    );
  } catch {
    /* the trail is a nicety; a failure here must not break the page */
  }
}

function describe(event) {
  const when = new Date(event.at).toLocaleTimeString();
  switch (event.kind) {
    case "payment-settled":
      return `${when} · ${event.amount} USDC base units · from ${event.payer} · tx ${event.transaction}`;
    case "payment-canceled":
      return `${when} · verified payment released${event.responseStatus ? ` after HTTP ${event.responseStatus}` : ""} — ${event.reason}`;
    case "notice-rejected":
      return `${when} · ${event.code} — ${event.detail}`;
    default:
      return when;
  }
}

/* ----------------------------------------------------------------- init -- */

els.checkBtn.addEventListener("click", runValidate);
els.clearBtn.addEventListener("click", () => {
  els.notice.value = "";
  clearPressed();
  syncCount();
  els.notice.focus();
  setVerdict("idle", "Cleared", "Paste a notice to start again.");
});
els.paywallBtn.addEventListener("click", triggerPaywall);

// Ctrl/Cmd+Enter submits, because a 10-line textarea invites it.
els.notice.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    runValidate();
  }
});

const pricing = await loadConfig();
await loadSamples();
syncCount();
if (pricing) {
  const single = pricing.routes.find((route) => route.route.endsWith("/v1/parse"));
  els.buyCommand.textContent = `npm run buy -- --sample en-structured-pune  # ${single?.price ?? ""} per notice`;
  setInterval(loadAudit, 5000);
  loadAudit();
}
