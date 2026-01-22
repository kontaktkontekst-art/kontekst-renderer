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
    deviceScaleFactor: 2
  });
  const page = await context.newPage();

  try {
    // Wstrzyknięcie danych PRZED załadowaniem HTML
    await page.addInitScript((data) => {
      window.__RENDER_REQUEST__ = data;
    }, rr);

    await page.setContent(TEMPLATE_HTML, { waitUntil: "domcontentloaded" });

    // Poczekaj aż template skończy wstawiać treści (ustawia window.__RENDERED__ = true)
    await page.waitForFunction(() => window.__RENDERED__ === true, null, { timeout: 8000 });

    // Fonts ready (best effort)
    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
    });

    const canvas = page.locator("#canvas");
    const png = await canvas.screenshot({ type: "png" });

    res.setHeader("Content-Type", "image/png");
    res.status(200).send(png);
  } catch (e) {
    res.status(500).json({
      error: "Render failed",
      message: String(e?.message || e)
    });
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Renderer running on port ${PORT}`);
});
