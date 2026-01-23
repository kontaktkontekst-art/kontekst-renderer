import express from "express";
import { chromium } from "playwright";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "5mb" }));

const TEMPLATE_HTML = fs.readFileSync(new URL("./template.html", import.meta.url), "utf8");

app.get("/health", (req, res) => res.status(200).json({ ok: true }));

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) browserPromise = chromium.launch({ args: ["--no-sandbox"] });
  return browserPromise;
}

app.post("/render", async (req, res) => {
  let rr = req.body;
  if (Array.isArray(rr)) rr = rr[0];

  if (!rr?.template_id) {
    return res.status(400).json({ error: "Missing template_id" });
  }

  if (rr.template_id !== "KONTEKST_CAROUSEL_V1_SLIDE_1_HOOK") {
    return res.status(422).json({ error: "Unsupported template_id" });
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
    if (browserLogs.length > 200) browserLogs.shift();
  };

  page.on("console", (msg) => pushLog(`console.${msg.type()}`, msg.text()));
  page.on("pageerror", (err) => pushLog("pageerror", err?.stack || String(err)));
  page.on("requestfailed", (req) =>
    pushLog("requestfailed", `${req.method()} ${req.url()} -> ${req.failure()?.errorText || "unknown"}`)
  );

  try {
    await page.addInitScript({
      content: `window.__RENDER_REQUEST__ = ${JSON.stringify(rr)};`,
    });

    await page.setContent(TEMPLATE_HTML, { waitUntil: "domcontentloaded" });

    await page.waitForFunction(
      () => window.__RENDERED__ === true || (typeof window.__RENDER_ERROR__ === "string" && window.__RENDER_ERROR__.length > 0),
      null,
      { timeout: 8000 }
    );

    const renderError = await page.evaluate(() => window.__RENDER_ERROR__ || "");
    if (renderError) throw new Error(`TemplateError: ${renderError}`);

    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
    });

    const png = await page.locator("#canvas").screenshot({ type: "png" });

    res.setHeader("Content-Type", "image/png");
    res.status(200).send(png);
  } catch (e) {
    res.status(500).json({
      error: "Render failed",
      message: String(e?.message || e),
      browserLogs,
    });
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});

// ✅ KLUCZ: Render musi widzieć port z env PORT
const PORT = Number(process.env.PORT || 10000);

// NIE podajemy hosta — minimalizujemy ryzyko złego bindu
app.listen(PORT, () => {
  console.log(`Renderer listening on ${PORT} (env PORT=${process.env.PORT ?? "undefined"})`);
});
