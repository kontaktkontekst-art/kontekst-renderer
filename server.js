import express from "express";
import { chromium } from "playwright";
import fs from "fs";

const app = express();

app.use(
  express.json({
    limit: "5mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf?.toString("utf8") || "";
    },
  })
);

const TEMPLATE_HTML_RAW = fs.readFileSync(new URL("./template.html", import.meta.url), "utf8");

app.get("/health", (req, res) => res.status(200).json({ ok: true }));

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) browserPromise = chromium.launch({ args: ["--no-sandbox"] });
  return browserPromise;
}

function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

app.post("/render", async (req, res) => {
  let rr = req.body;
  if (Array.isArray(rr)) rr = rr[0];

  if (!rr?.template_id) {
    return res.status(400).json({
      error: "Missing template_id",
      debug: {
        contentType: req.headers["content-type"] || null,
        bodyType: typeof req.body,
        isArray: Array.isArray(req.body),
        rawBodyFirst200: (req.rawBody || "").slice(0, 200),
      },
    });
  }

  if (rr.template_id !== "KONTEKST_CAROUSEL_V1_SLIDE_1_HOOK") {
    return res.status(422).json({ error: "Unsupported template_id", got: rr.template_id });
  }

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1080, height: 1350 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  const browserLogs = [];
  const pushLog = (type, msg) => {
    const line = `[${type}] ${msg}`;
    browserLogs.push(line);
    if (browserLogs.length > 300) browserLogs.shift();
  };

  page.on("console", (msg) => pushLog(`console.${msg.type()}`, msg.text()));
  page.on("pageerror", (err) => pushLog("pageerror", err?.stack || String(err)));
  page.on("requestfailed", (req) =>
    pushLog("requestfailed", `${req.method()} ${req.url()} -> ${req.failure()?.errorText || "unknown"}`)
  );

  try {
    const rrJson = escapeHtml(JSON.stringify(rr));
    const rrScript = `<script id="__RR__" type="application/json">${rrJson}</script>`;
    const html = TEMPLATE_HTML_RAW.replace("<body>", `<body>\n  ${rrScript}`);

    await page.setContent(html, { waitUntil: "domcontentloaded" });

    await page.waitForFunction(
      () =>
        window.__RENDERED__ === true ||
        (typeof window.__RENDER_ERROR__ === "string" && window.__RENDER_ERROR__.length > 0),
      null,
      { timeout: 15000 }
    );

    const renderError = await page.evaluate(() => window.__RENDER_ERROR__ || "");
    if (renderError) throw new Error(`TemplateError: ${renderError}`);

    // Twarda weryfikacja: czy #canvas istnieje
    const hasCanvas = await page.evaluate(() => !!document.querySelector("#canvas"));
    if (!hasCanvas) {
      const snippet = await page.evaluate(() => document.documentElement?.outerHTML?.slice(0, 1200) || "");
      throw new Error(`Missing #canvas in DOM. HTML snippet: ${snippet}`);
    }

    const png = await page.locator("#canvas").screenshot({ type: "png", timeout: 60000 });

    res.setHeader("Content-Type", "image/png");
    res.status(200).send(png);
  } catch (e) {
    // fallback: spróbuj zrobić screenshot całej strony (debug)
    let pagePngB64 = null;
    try {
      const full = await page.screenshot({ type: "png", timeout: 10000, fullPage: true });
      pagePngB64 = full.toString("base64").slice(0, 2000); // tylko fragment, żeby nie walić wielkim JSONem
    } catch {}

    res.status(500).json({
      error: "Render failed",
      message: String(e?.message || e),
      browserLogs,
      debug: {
        hasCanvas: await page.evaluate(() => !!document.querySelector("#canvas")).catch(() => null),
        title: await page.title().catch(() => null),
        url: page.url(),
        pageScreenshotB64_first2000: pagePngB64,
      },
    });
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => {
  console.log(`Renderer listening on ${PORT} (env PORT=${process.env.PORT ?? "undefined"})`);
});
