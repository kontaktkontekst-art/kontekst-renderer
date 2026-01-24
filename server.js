import express from "express";
import { chromium } from "playwright";
import fs from "fs";

const app = express();

// =====================
// Config
// =====================
const PORT = Number(process.env.PORT || 10000);
const JSON_LIMIT = process.env.JSON_LIMIT || "10mb"; // masz duże payloady (svg, itp.)
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 1); // ważne dla 512MB
const VIEWPORT = { width: 1080, height: 1350 };
const DEVICE_SCALE_FACTOR = Number(process.env.DSF || 2);
const DEFAULT_TIMEOUT_MS = Number(process.env.DEFAULT_TIMEOUT_MS || 60000);
const RENDER_SIGNAL_TIMEOUT_MS = Number(process.env.RENDER_SIGNAL_TIMEOUT_MS || 20000);

// =====================
// Middleware
// =====================
app.use(
  express.json({
    limit: JSON_LIMIT,
    verify: (req, _res, buf) => {
      req.rawBody = buf?.toString("utf8") || "";
    },
  })
);

const TEMPLATE_HTML_RAW = fs.readFileSync(
  new URL("./template.html", import.meta.url),
  "utf8"
);

app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// =====================
// Browser singleton
// =====================
let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage", // często pomaga na małych instancjach
        "--disable-gpu",
      ],
    });
  }
  return browserPromise;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// =====================
// Concurrency limiter
// =====================
let inFlight = 0;

function tooBusy() {
  return inFlight >= MAX_CONCURRENCY;
}

// =====================
// Input normalization
// =====================
// Accept:
// - { input: {...} }
// - {...} (root)
// - [ {...}, {...} ] (use first)
// - [ { input: {...} } ] (use first, unwrap)
// Returns: { rr, source } where source tells where we found payload
function normalizeRequestBody(body) {
  let rr = body;
  let source = "body";

  if (Array.isArray(rr)) {
    rr = rr[0];
    source = "array[0]";
  }

  // unwrap { input: ... }
  if (rr && typeof rr === "object" && rr.input && typeof rr.input === "object") {
    rr = rr.input;
    source = source + ".input";
  }

  return { rr, source };
}

// =====================
// Route
// =====================
app.post("/render", async (req, res) => {
  // Hard concurrency guard to prevent OOM on 512MB
  if (tooBusy()) {
    return res.status(429).json({
      error: "Busy",
      message: `Renderer is at capacity (MAX_CONCURRENCY=${MAX_CONCURRENCY}). Try again.`,
    });
  }

  inFlight++;

  let context = null;
  let page = null;

  // keep some logs from the browser to help debug template issues
  const browserLogs = [];
  const pushLog = (type, msg) => {
    const line = `[${type}] ${msg}`;
    browserLogs.push(line);
    if (browserLogs.length > 300) browserLogs.shift();
  };

  try {
    const { rr, source } = normalizeRequestBody(req.body);

    const templateId = rr?.template_id ?? rr?.templateId ?? null;
    if (!templateId) {
      return res.status(400).json({
        error: "Missing template_id",
        debug: {
          where: source,
          contentType: req.headers["content-type"] || null,
          bodyType: typeof req.body,
          isArray: Array.isArray(req.body),
          rawBodyFirst200: (req.rawBody || "").slice(0, 200),
          keysTopLevel: req.body && typeof req.body === "object" ? Object.keys(req.body) : null,
        },
      });
    }

    // Validate supported templates (expand here when you add more)
    if (templateId !== "KONTEKST_CAROUSEL_V1_SLIDE_1_HOOK") {
      return res.status(422).json({
        error: "Unsupported template_id",
        got: templateId,
        supported: ["KONTEKST_CAROUSEL_V1_SLIDE_1_HOOK"],
      });
    }

    const browser = await getBrowser();

    context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
    });

    context.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);

    page = await context.newPage();

    page.on("console", (msg) => pushLog(`console.${msg.type()}`, msg.text()));
    page.on("pageerror", (err) => pushLog("pageerror", err?.stack || String(err)));
    page.on("requestfailed", (r) =>
      pushLog(
        "requestfailed",
        `${r.method()} ${r.url()} -> ${r.failure()?.errorText || "unknown"}`
      )
    );

    // Inject RR as JSON into template.html
    const rrJson = escapeHtml(JSON.stringify(rr));
    const rrScript = `<script id="__RR__" type="application/json">${rrJson}</script>`;
    const html = TEMPLATE_HTML_RAW.replace("<body>", `<body>\n  ${rrScript}`);

    // Use domcontentloaded (lighter than networkidle)
    await page.setContent(html, { waitUntil: "domcontentloaded" });

    // Wait for template to set __RENDERED__ or __RENDER_ERROR__
    await page.waitForFunction(
      () =>
        window.__RENDERED__ === true ||
        (typeof window.__RENDER_ERROR__ === "string" && window.__RENDER_ERROR__.length > 0),
      null,
      { timeout: RENDER_SIGNAL_TIMEOUT_MS }
    );

    const renderError = await page.evaluate(() => window.__RENDER_ERROR__ || "");
    if (renderError) throw new Error(`TemplateError: ${renderError}`);

    // Ensure canvas exists
    await page.waitForSelector("#canvas", { state: "attached", timeout: RENDER_SIGNAL_TIMEOUT_MS });

    const el = await page.$("#canvas");
    if (!el) throw new Error("Missing #canvas element handle");

    // Screenshot element (more stable than page.screenshot for your case)
    const png = await el.screenshot({ type: "png", timeout: DEFAULT_TIMEOUT_MS });

    res.setHeader("Content-Type", "image/png");
    res.status(200).send(png);
  } catch (e) {
    const message = String(e?.message || e);

    // Attempt to collect minimal debug safely
    let debug = {};
    try {
      debug = {
        url: page?.url?.() ?? null,
        hasCanvas: page
          ? await page.evaluate(() => !!document.querySelector("#canvas")).catch(() => null)
          : null,
        now: Date.now(),
        inFlight,
        maxConcurrency: MAX_CONCURRENCY,
      };
    } catch {
      debug = { now: Date.now(), inFlight, maxConcurrency: MAX_CONCURRENCY };
    }

    res.status(500).json({
      error: "Render failed",
      message,
      browserLogs,
      debug,
    });
  } finally {
    // Cleanup aggressively to reduce memory
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});

    inFlight--;
  }
});

app.listen(PORT, () => {
  console.log(
    `Renderer listening on ${PORT} (env PORT=${process.env.PORT ?? "undefined"}) | MAX_CONCURRENCY=${MAX_CONCURRENCY}`
  );
});
