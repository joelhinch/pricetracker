import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import * as cheerio from "cheerio";
import cron from "node-cron";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const GENERIC_PRICE_SELECTORS = [
  ".price",
  "[itemprop='price']",
  ".product-price",
  "span[class*='price']",
  ".price__value",
  ".price-wrapper .price",
  "span[data-price-type='current'] .price",
  "span[data-price-type='finalPrice'] .price",
  ".price-item.price-item--regular",
  ".money",
  ".product-price.leading-6.text-2xl.tracking-wide.font-medium",
  ".price__value.price__value--special",
  ".product-page-price.product-main-price",
  ".divPriceNormal",
  ".sprice",
  ".a-price-whole"
];

const OOS_KEYWORDS = [
  "out of stock",
//  "sold out",
  "unavailable",
  "no longer available",
  "temporarily unavailable",
  "temporarily out of stock"
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// static serve
const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) app.use(express.static(publicDir));
else app.use(express.static(__dirname));

const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbFile = path.join(dataDir, "db.json");
const settingsFile = path.join(dataDir, "settings.json");

let items = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, "utf8")) : [];
let settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : [];

function saveDb() { fs.writeFileSync(dbFile, JSON.stringify(items, null, 2), "utf8"); }
function saveSettings() { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf8"); }

// ──────────────────────────────────────────────────────────────────────
//  GET SELECTOR + SCRAPER FROM settings.json
// ──────────────────────────────────────────────────────────────────────
function getSelectorForDomain(domain) {
  if (!domain) return null;
  const found = settings.find(s => s.domain === domain || domain.endsWith('.' + s.domain));
  if (!found) return null;
  return {
    selector: found.selector || null,
    scraper: found.scraper || "auto"  // "auto", "simple", "puppeteer"
  };
}

function normalizeItem(item) {
  if (!item.sites && item.urls) {
    item.sites = (item.urls || []).map(u => {
      if (typeof u === "string") return { id: uuidv4(), url: u, selector: null, history: [], historyDates: [], currentPrice: null, lastUpdated: null };
      return { id: uuidv4(), url: u.url, selector: u.selector || null, history: [], historyDates: [], currentPrice: null, lastUpdated: null };
    });
    delete item.urls;
  }
  item.sites = item.sites || [];
  item.priceHistory = item.priceHistory || [];
  item.historyDates = item.historyDates || [];
  item.minPrice = item.minPrice ?? null;
  item.maxPrice = item.maxPrice ?? null;
  item.currentPrice = item.currentPrice ?? null;
  item.bestUrl = item.bestUrl ?? null;
  item.lastUpdated = item.lastUpdated ?? null;
  if (typeof item.position !== "number") item.position = null;
  if (typeof item.imageUrl === "undefined") item.imageUrl = null;
  return item;
}

items = items.map(normalizeItem);
const missingPos = items.filter(i => i.position == null);
if (missingPos.length) {
  const max = items.reduce((m,it)=> typeof it.position === "number" ? Math.max(m,it.position): m, -1);
  let next = max + 1;
  missingPos.forEach(it => { it.position = next++; });
  saveDb();
}

function cleanPriceText(text) {
  if (!text) return null;
  const cleaned = text.toString().replace(/[^\d.,]/g, "").trim();
  if (!cleaned) return null;
  const normalized = cleaned.includes(",") && !cleaned.includes(".") ? cleaned.replace(",", ".") : cleaned.replace(/,/g, "");
  const val = parseFloat(normalized);
  return isNaN(val) ? null : val;
}

async function fetchPriceSimple(url, customSelector = null) {
  console.log(`[Simple] Fetching ${url} ${customSelector ? `(selector: ${customSelector})` : ""}`);
  try {
    const domain = new URL(url).hostname.replace(/^www\./, "");
    const res = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": `https://${domain}/`,
      },
      timeout: 25000,
      validateStatus: s => s >= 200 && s < 500
    });

    if (res.status >= 400) {
      console.log(`   Bad status: ${res.status}`);
      return { price: null, error: "bad status" };
    }
    const $ = cheerio.load(res.data);

    const bodyText = $.root().text().toLowerCase();
    if (OOS_KEYWORDS.some(kw => bodyText.includes(kw))) {
      console.log(`   Out of stock detected`);
      return { price: null, error: "out of stock" };
    }

    let text = null;

    let selectors = customSelector ? [customSelector] : GENERIC_PRICE_SELECTORS;
    console.log(`   Using selectors: ${selectors.join(', ')}`);

    for (const sel of selectors) {
      const el = $(sel).first();
      text = (el.text() || el.attr("content") || "").trim();
      if (text) {
        console.log(`   Found text from selector '${sel}': '${text}'`);
        break;
      }
    }

    if (!text) {
      console.log(`   Fallback to og:price:amount`);
      text = $("meta[property='og:price:amount']").attr("content");
      if (text) console.log(`   Found from og meta: '${text}'`);
    }

    if (!text) {
      console.log(`   Fallback to regex scan`);
      const match = $.root().text().match(/[$£€]\s?[\d.,]+/);
      if (match) {
        text = match[0];
        console.log(`   Found from regex: '${text}'`);
      }
    }

    if (!text) {
      console.log(`   No price text found`);
      return { price: null, error: "no price found" };
    }

    text = text.replace(/,/g, "");
    const val = parseFloat(text.replace(/[^\d.]/g, ""));
    console.log(`   Parsed price: $${val}`);
    return { price: isNaN(val) ? null : val, error: null };
  } catch (e) {
    console.warn(`[Simple] Failed for ${url}:`, e.message || e);
    return { price: null, error: e.message || "unknown error" };
  }
}

//begin puppeteer function 

async function fetchPriceWithPuppeteer(url, customSelector = null) {
  let browser;
  const domain = new URL(url).hostname.replace(/^www\./, "");

  try {
browser = await puppeteer.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--disable-infobars",
    "--window-size=1366,768",
    "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" +
      (110 + Math.floor(Math.random() * 10)) + ".0.0.0 Safari/537.36"
  ],
  defaultViewport: { width: 1366, height: 768 }
});


    const page = await browser.newPage();

    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36");
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    page.setDefaultNavigationTimeout(60000);

    try {
      await page.evaluateOnNewDocument(() => {
        try {
          Object.defineProperty(navigator, "webdriver", { get: () => false });
          Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
          Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
          window.chrome = { runtime: {} };
        } catch (e) { /* harmless */ }
      });
    } catch (e) {
      // ignore
    }

    const candidates = [];

    page.on("response", async (response) => {
      try {
        const headers = response.headers();
        const ct = headers["content-type"] || "";
        if (ct.includes("application/json")) {
          let data;
          try { data = await response.json(); } catch { return; }
          const str = JSON.stringify(data);

          const all = [
            ...str.matchAll(/"priceDisplay"\s*:\s*"?\$?([\d.,]+)/g),
            ...str.matchAll(/"salePrice"\s*:\s*"?\$?([\d.,]+)/g),
            ...str.matchAll(/"price"\s*:\s*"?\$?([\d.,]+)/g)
          ];
          for (const m of all) {
            let n = parseFloat(m[1].replace(/[^\d.]/g, ""));
            if (!isNaN(n) && n > 9999) n = n / 100;
            if (!isNaN(n) && n > 0 && n < 100000) candidates.push(n);
          }
        }
      } catch (e) {
        // swallow
      }
    });
    
    // ─────────────────────────────────────────────
// Scale Normalisation Utility (prevents inflated prices like 4900 → 49.00)
// ─────────────────────────────────────────────
function normaliseCandidateValues(values) {
  if (!Array.isArray(values)) return values;

  // Detect if most values are within normal retail range (e.g., 1–5000)
  const median = values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] || 0;

  return values.map(v => {
    // Convert prices like 4900 → 49 if they’re outliers compared to the median
    if (v > 500 && v.toString().endsWith("00") && median < 500) return v / 100;
    if (v > 1000 && v % 100 === 0 && median < 1000) return v / 100;
    if (v > 1000 && values.some(x => x < 100)) return v / 100;
    return v;
  });
}

// We'll apply this later just before final price selection too


    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 1500));

    } catch (e) {
      console.warn(`[PUPPETEER] Navigation warning for ${url}: ${e.message || e}`);
    }
    await new Promise(r => setTimeout(r, 2500));
    
    //debug2
    // ─────────────────────────────────────────────
// DEBUG: Preview what HTML Puppeteer actually got (first 500 chars)
// ─────────────────────────────────────────────
try {
  const snippet = await page.evaluate(() => document.body.innerText.slice(0, 500));
  console.log("[PUPPETEER][DEBUG] Page text preview:", snippet);
  if (/Reference\s+#\d+\./i.test(snippet) || /edgesuite\.net/i.test(snippet)) {
    console.warn("[PUPPETEER][DEBUG] ⚠️ Detected Akamai error page instead of real product page");
  }
} catch (e) {
  console.warn("[PUPPETEER][DEBUG] Could not preview page text:", e.message);
}

    //debug2

// Delay out-of-stock detection until after price evaluation
let outOfStockDetected = false;
try {
  const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase() || '');
  if (OOS_KEYWORDS.some(kw => bodyText.includes(kw))) {
    outOfStockDetected = true;
  }
} catch (e) {
  console.warn(`[PUPPETEER] OOS keyword check failed: ${e.message}`);
}


    try {
      const html = await page.content();

      const pricePatterns = [
        /"priceDisplay"\s*:\s*"?\$?([\d.,]+)/gi,
        /"salePrice"\s*:\s*"?\$?([\d.,]+)/gi,
        /"price"\s*:\s*"?\$?([\d.,]+)/gi,
        /"price"\s*:\s*{\s*"amount"\s*:\s*([\d.]+)/gi,
        /"amount"\s*:\s*([\d.]+)\s*(?:,|\})/gi,
        /'priceDisplay'\s*:\s*'?\\?\$?([\d.,]+)/gi
      ];

let jsonCandidates = [];
let totalMatches = 0;

for (const pattern of pricePatterns) {
  const matches = [...html.matchAll(pattern)];
  totalMatches += matches.length;

  for (const m of matches) {
    const raw = m[1];
    const idx = m.index || 0; // character position of the match
    let n = parseFloat(raw.replace(/[^\d.]/g, ""));
    if (!isNaN(n) && n > 9999) n = n / 100;
    if (!isNaN(n) && n > 0 && n < 100000) {
      jsonCandidates.push({ price: n, index: idx });
    }
  }
}

if (totalMatches) console.log(`[PUPPETEER] Inline HTML JSON matches (nested supported): ${totalMatches}`);
// ─────────────────────────────────────────────
//  JSON-LD (structured data) price extraction — DOM + fallback
// ─────────────────────────────────────────────
try {
  //  Make sure the JSON-LD has been rendered
  try {
    await page.waitForSelector('script[type="application/ld+json"]', { timeout: 15000 });
  } catch {
    console.warn("[PUPPETEER] JSON-LD tag not found before timeout, continuing anyway");
  }

  //  Grab all JSON-LD blocks from the live DOM
  const ldBlocks = await page.$$eval('script[type="application/ld+json"]', els =>
    els.map(e => e.textContent)
  );

  //  Fallback: also extract from raw HTML (covers SSR fragments)
  if (!ldBlocks.length) {
    console.log("[PUPPETEER] No LD+JSON via DOM, using regex fallback");
    const matches = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
    ldBlocks.push(...matches.map(m => m[1]));
  }

  //  Parse and walk each block
  for (const raw of ldBlocks) {
    let text = raw
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();

    // sometimes multiple JSON objects are concatenated
    const possibleChunks = text
      .split(/}\s*{/)
      .map((chunk, i, arr) =>
        i === 0
          ? chunk + (arr.length > 1 ? "}" : "")
          : "{" + chunk + (i < arr.length - 1 ? "}" : "")
      );

    for (const chunk of possibleChunks) {
      try {
        const data = JSON.parse(chunk);

        const walk = obj => {
          if (!obj || typeof obj !== "object") return;
          if (Array.isArray(obj)) return obj.forEach(walk);

          if (obj.price && !isNaN(parseFloat(obj.price))) {
            jsonCandidates.push({ price: parseFloat(obj.price), index: 0 });
          }
          if (obj.priceSpecification && obj.priceSpecification.price) {
            const p = parseFloat(obj.priceSpecification.price);
            if (!isNaN(p)) jsonCandidates.push({ price: p, index: 0 });
          }
          if (obj.offers && typeof obj.offers === "object") walk(obj.offers);
          Object.values(obj).forEach(walk);
        };

        walk(data);
      } catch {
        /* ignore bad JSON blocks */
      }
    }
  }

  if (jsonCandidates.length) {
    console.log(
      `[PUPPETEER] Parsed ${ldBlocks.length} JSON-LD block(s); found ${jsonCandidates.length} price entries`
    );
  }
} catch (e) {
  console.warn(`[PUPPETEER] JSON-LD parse failed: ${e.message}`);
}
// ─────────────────────────────────────────────
// Conditional visible DOM price fallback — only for domains in settings.json
// ─────────────────────────────────────────────
try {
  if (!settings || !Array.isArray(settings)) {
    console.log(`[PUPPETEER] No settings loaded, skipping visible DOM scan for ${domain}`);
  } else {
    const domainAllowed = settings.some(s => s.domain && domain.includes(s.domain));
    if (!domainAllowed) {
      console.log(`[PUPPETEER] Skipping visible DOM scan — ${domain} not in settings.json`);
    } else {
      console.log(`[PUPPETEER] Running visible DOM price fallback for ${domain}`);

      try {
        await page.waitForFunction(
          () => !![...document.querySelectorAll('*')].find(el =>
            /\$\s?\d/.test(el.textContent) || /\d+\.\d{2}/.test(el.textContent)
          ),
          { timeout: 10000 }
        );
      } catch {
        console.warn(`[PUPPETEER] No visible price text detected within timeout — continuing anyway`);
      }

const domSelectors = [
  '[data-test*="price"]',
  '[data-test*="ProductPrice"]',
  '[data-test="product-price"]',
  '[data-test="price-container"]',
  '.ProductPrice__price',
  '.ProductPrice__styledPrice',
  '.product-price',
  '[class*="price"]',
  '[class*="Price"]',
  'div[data-testid*="price"]',
  'div[data-component*="Price"]',
  'div[data-test*="ProductDetails"] span',
  'div[data-test*="ProductDetails"] strong',
];


      // Locate "Add to cart" or similar for proximity weighting
      const anchorRect = await page.evaluate(() => {
        const anchor =
          document.querySelector('[data-test*="add-to-cart"]') ||
          document.querySelector('button[data-test*="add-to-cart"]') ||
          document.querySelector('button#add-to-cart') ||
          document.querySelector('button.add-to-cart') ||
          document.querySelector('button[type="submit"]') ||
          document.querySelector('[aria-label*="Add to cart"]') ||
          Array.from(document.querySelectorAll('button')).find(b => /add to cart|buy now|add to bag/i.test(b.textContent));
        if (!anchor) return null;
        const r = anchor.getBoundingClientRect();
        return { top: r.top, height: r.height };
      });

      // Gather visible elements matching likely price classes
      const elems = await page.$$eval(domSelectors.join(','), els =>
        els
          .filter(el => el.offsetParent !== null)
          .map(el => {
            const r = el.getBoundingClientRect();
            return {
              text: el.textContent.trim().replace(/\s+/g, ' '),
              top: Math.round(r.top),
              h: Math.round(r.height)
            };
          })
      ).catch(() => []);

      // Merge with span/strong/b reassembled fragments (for split prices)
      const spanElems = await page.$$eval('[data-test*="price"], [class*="Price"], [class*="price"]', els =>
        els
          .filter(el => el.offsetParent !== null)
          .map(el => {
            const r = el.getBoundingClientRect();
            const assembled = Array.from(el.querySelectorAll('span, strong, b'))
              .map(s => s.textContent.trim())
              .filter(Boolean)
              .join('');
            const text = (assembled || el.textContent || '').trim().replace(/\s+/g, ' ');
            return { text, top: Math.round(r.top), h: Math.round(r.height) };
          })
      ).catch(() => []);

let priceElements = [...elems, ...spanElems];

// Deep scan for complex React or split span prices (universal)
if (priceElements.length < 3) {
  try {
    const deepElems = await page.$$eval(
      'div[data-test*="product"], div[data-test*="details"], div[data-component*="Price"], section, article',
      els =>
        els
          .filter(el => el.offsetParent !== null)
          .flatMap(el => {
            const r = el.getBoundingClientRect();

            // Reassemble nested spans or fragments into one text string
            const assembled = Array.from(el.querySelectorAll('span, strong, b'))
              .map(s => s.textContent.trim())
              .filter(Boolean)
              .join('');

            const fullText = (assembled || el.textContent || '').trim().replace(/\s+/g, ' ');
            return [{ text: fullText, top: Math.round(r.top), h: Math.round(r.height) }];
          })
          .filter(e =>
            /\$\s?\d/.test(e.text) ||
            /\d+\.\d{2}/.test(e.text) ||
            /(?:aud|price|now|only)\s*\$?\s*\d+/i.test(e.text)
          )
    );
    if (deepElems.length) {
      console.log(`[PUPPETEER] Deep scan added ${deepElems.length} reassembled price candidates`);
      priceElements.push(...deepElems);
    }
  } catch (e) {
    console.warn(`[PUPPETEER] Deep scan failed: ${e.message}`);
  }
}

// Post-process: try to merge loose “$” and numeric fragments into full prices
try {
  const merged = [];
  for (let i = 0; i < priceElements.length - 1; i++) {
    const a = priceElements[i].text;
    const b = priceElements[i + 1].text;
    if (/^\$?$/.test(a.trim()) && /^\d/.test(b.trim())) {
      merged.push({
        text: a.trim() + b.trim(),
        top: priceElements[i].top,
        h: priceElements[i].h,
      });
    }
  }
  if (merged.length) {
    console.log(`[PUPPETEER] Merged ${merged.length} fragmented price spans`);
    priceElements.push(...merged);
  }
} catch (e) {
  console.warn(`[PUPPETEER] Fragment merge failed: ${e.message}`);
}

      // fallback: scan entire visible DOM if still empty
      if (!priceElements.length) {
        priceElements = await page.$$eval('*', els => {
          return els
            .filter(el => {
              const tag = el.tagName.toLowerCase();
              const visible = !!(el.offsetParent !== null);
              return visible && tag !== 'script' && tag !== 'style';
            })
            .map(el => {
              const r = el.getBoundingClientRect();
              const spanText = Array.from(el.querySelectorAll('span, strong, b'))
                .map(s => s.textContent.trim())
                .filter(Boolean)
                .join('');
              const text = (spanText || el.textContent || '').trim().replace(/\s+/g, ' ');
              return { text, top: Math.round(r.top), h: Math.round(r.height) };
            })
            .filter(e =>
              /\$\s?\d/.test(e.text) ||
              /\d+\.\d{2}/.test(e.text) ||
              /(?:aud|price|now|only)\s*\$?\s*\d+/i.test(e.text)
            );
        });
      }

      // deduplicate visible entries
      priceElements = priceElements.filter(
        (p, i, arr) => arr.findIndex(x => x.text === p.text && x.top === p.top) === i
      );
      
      //debug
      // --- DEBUG & aggressive reassembly (insert here, before numeric extraction) ---
try {
  // 1) Quick log of what we found so far (first 30)
  try {
    console.log('[PUPPETEER][DEBUG] initial priceElements sample:', priceElements.slice(0, 30).map(p => `${p.text.substring(0,100)} @${p.top}`));
  } catch(e) {
    console.warn('[PUPPETEER][DEBUG] failed to log priceElements sample:', e.message);
  }

  // 2) Aggressive neighbor reassembly: join with previous/next sibling text for split spans
  const reassembled = await page.evaluate(() => {
    const out = [];
    const els = Array.from(document.querySelectorAll('*')).filter(el => el.offsetParent !== null);
    // We'll focus on elements that contain either $ or a decimal-looking number
    const candidates = els.filter(el => /\$\s?\d/.test(el.textContent) || /\d+\.\d{2}/.test(el.textContent) || /\d{1,3}(?:,\d{3})/.test(el.textContent));
    for (const el of candidates) {
      try {
        const r = el.getBoundingClientRect();
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
        // previous & next sibling text (to catch split $ + number)
        const prev = el.previousElementSibling ? (el.previousElementSibling.textContent || '').trim().replace(/\s+/g,' ') : '';
        const next = el.nextElementSibling ? (el.nextElementSibling.textContent || '').trim().replace(/\s+/g,' ') : '';
        // parent combined (sometimes price pieces are siblings inside a parent)
        const parent = el.parentElement ? (Array.from(el.parentElement.querySelectorAll('span, strong, b')).map(s => s.textContent.trim()).filter(Boolean).join('')) : '';
        out.push({ text, combinedPrevNext: (prev + ' ' + text + ' ' + next).trim(), parent, top: Math.round(r.top), h: Math.round(r.height) });
      } catch(e) {
        // ignore element
      }
    }
    return out;
  });

  if (Array.isArray(reassembled) && reassembled.length) {
    console.log(`[PUPPETEER][DEBUG] reassembled candidates found: ${reassembled.length}`);
    // push unique ones into priceElements (avoid exact text+top dupes)
    for (const r of reassembled) {
      const exists = priceElements.some(pe => pe.text === r.text || pe.text === r.combinedPrevNext || pe.top === r.top);
      if (!exists) priceElements.push({ text: r.combinedPrevNext || r.parent || r.text, top: r.top, h: r.h });
    }
  }

  // 3) Scan attributes/meta/aria/title for price-looking strings within product-scoped containers
  try {
    const attrPrices = await page.evaluate(() => {
      const results = [];
      // meta tags
      const metaSel = ['meta[itemprop="price"]', 'meta[property="product:price:amount"]', 'meta[name="og:price:amount"]', 'meta[name="twitter:data1"]'];
      for (const s of metaSel) {
        const m = document.querySelector(s);
        if (m && m.content) results.push({ text: m.content.trim(), top: 0, h: 0 });
      }
      // attributes like data-price, aria-label, title, data-analytics-price across likely containers
      const attrEls = Array.from(document.querySelectorAll('[data-price], [data-analytics-price], [data-price-amount], [aria-label], [title]'))
        .filter(e => e.offsetParent !== null);
      for (const e of attrEls) {
        const attrs = [];
        if (e.getAttribute('data-price')) attrs.push(e.getAttribute('data-price'));
        if (e.getAttribute('data-analytics-price')) attrs.push(e.getAttribute('data-analytics-price'));
        if (e.getAttribute('data-price-amount')) attrs.push(e.getAttribute('data-price-amount'));
        if (e.getAttribute('aria-label')) attrs.push(e.getAttribute('aria-label'));
        if (e.getAttribute('title')) attrs.push(e.getAttribute('title'));
        const combined = attrs.filter(Boolean).join(' ').trim();
        if (combined) {
          // keep short preview
          results.push({ text: combined, top: Math.round(e.getBoundingClientRect().top || 0), h: Math.round(e.getBoundingClientRect().height || 0) });
        }
      }
      return results;
    });

    if (Array.isArray(attrPrices) && attrPrices.length) {
      console.log(`[PUPPETEER][DEBUG] attribute/meta-derived price fragments: ${attrPrices.map(p => p.text.substring(0,80)).slice(0,20)}`);
      for (const a of attrPrices) {
        const exists = priceElements.some(pe => pe.text === a.text && pe.top === a.top);
        if (!exists) priceElements.push({ text: a.text, top: a.top, h: a.h });
      }
    }
  } catch (e) {
    console.warn('[PUPPETEER][DEBUG] attribute/meta scan failed:', e.message);
  }

  // 4) Final log of expanded set
  try {
    console.log('[PUPPETEER][DEBUG] expanded priceElements sample:', priceElements.slice(0, 60).map(p => `${p.text.substring(0,120)} @${p.top}`));
  } catch(e) { /* ignore logging errors */ }

} catch (e) {
  console.warn('[PUPPETEER][DEBUG] aggressive reassembly failed:', e.message);
}
// --- end debug & reassembly ---

      //debug

      // Extract numeric price values with positions
      const candidatesWithPos = [];
      for (const el of priceElements) {
        const t = el.text || '';
        if (/off|save|each|month|kg|g|ml|pack|bundle|from|was|afterpay|zip/i.test(t)) continue;
        const matches = (t.match(/\d[\d,]*(?:\.\d{1,2})?/g) || [])
          .map(x => parseFloat(x.replace(/,/g, '')))
          .filter(v => v && v > 0 && v < 100000);
        for (const v of matches) candidatesWithPos.push({ value: v, top: el.top, h: el.h });
      }

      if (!candidatesWithPos.length) {
        console.log(`[PUPPETEER] No visible DOM price text found for ${domain}`);
      } else {
        const anchorY = anchorRect ? (anchorRect.top + (anchorRect.height || 0) / 2) : null;

        // Group by numeric value and weight by frequency + proximity
        const freq = {};
        for (const c of candidatesWithPos) {
          const key = Math.round((c.value + Number.EPSILON) * 100) / 100;
          if (!freq[key]) freq[key] = { count: 0, dist: [] };
          freq[key].count++;
          if (anchorY !== null) {
            const mid = (c.top || 0) + (c.h || 0) / 2;
            freq[key].dist.push(Math.abs(mid - anchorY));
          }
        }

        const scored = Object.entries(freq).map(([k, v]) => {
          const avgDist = v.dist.length ? v.dist.reduce((a, b) => a + b, 0) / v.dist.length : 9999;
          const score = v.count * (1 / Math.max(1, avgDist / 300));
          return { value: parseFloat(k), score };
        });

        scored.sort((a, b) => b.score - a.score);
        const allVals = scored.map(s => s.value);

        console.log(`[PUPPETEER] Visible DOM price candidates: ${allVals.join(", ")}`);

        // push all visible prices for unified selection later
        for (const s of scored) candidates.push(s.value);
      }
    }
  }
} catch (e) {
  console.warn(`[PUPPETEER] Conditional visible DOM scan failed: ${e.message}`);
}


// ─────────────────────────────────────────────
// NEW SMART JSON PRICE SELECTION LOGIC (enhanced cross-source confidence)
// ─────────────────────────────────────────────
if (jsonCandidates.length) {
  console.log(`[PUPPETEER] Inline HTML JSON matches (with positions): ${jsonCandidates.length}`);

  // Sort by order of appearance in the HTML
  jsonCandidates.sort((a, b) => a.index - b.index);
  console.log(`[PUPPETEER] JSON price order by position:`, jsonCandidates.slice(0, 10));

  // Normalise JSON values
  for (const c of jsonCandidates) {
    let n = c.price;
    if (n > 9999) n = n / 100;
    n = Math.round((n + Number.EPSILON) * 100) / 100;
    c.price = n;
  }

  // Group near-duplicates (e.g. 49 and 49.00)
  const EPS = 0.05;
  const grouped = [];
  for (const c of jsonCandidates) {
    const existing = grouped.find(g => Math.abs(g.price - c.price) < EPS);
    if (existing) {
      existing.count++;
      existing.indices.push(c.index);
    } else {
      grouped.push({ price: c.price, count: 1, indices: [c.index] });
    }
  }

  // Sort by earliest occurrence
  grouped.sort((a, b) => a.indices[0] - b.indices[0]);

  // Log frequency data for visibility
  console.log(`[PUPPETEER] JSON grouped frequency:`, grouped.map(g => `${g.price} (${g.count}×)`));

  // Find most frequent JSON value(s)
  const maxCount = Math.max(...grouped.map(g => g.count));
  const mostFrequentJSON = grouped.filter(g => g.count === maxCount);

  let jsonLikelyPrice = mostFrequentJSON[0]?.price ?? null;

  // If overwhelmingly dominant (3× more frequent), lock it in
  const sortedCounts = [...grouped].sort((a, b) => b.count - a.count);
  if (sortedCounts.length > 1 && sortedCounts[0].count >= sortedCounts[1].count * 3) {
    jsonLikelyPrice = sortedCounts[0].price;
    console.log(`[PUPPETEER] JSON overwhelming repetition detected (${sortedCounts[0].count}× vs ${sortedCounts[1].count}×)`);
  }

  // Cross-check: does this JSON price appear frequently in inline/DOM candidates?
  const matchInOtherSources = candidates.filter(v => Math.abs(v - jsonLikelyPrice) < 0.05).length;
  if (jsonLikelyPrice && matchInOtherSources > 0) {
    console.log(`[PUPPETEER] JSON price $${jsonLikelyPrice} also found ${matchInOtherSources}× in HTML/network candidates — boosting confidence.`);
  }

  // If JSON and HTML agree or JSON is dominant, use it preferentially
  if (jsonLikelyPrice && (mostFrequentJSON.length > 1 || matchInOtherSources > 0)) {
    console.log(`[PUPPETEER] ✅ Selecting JSON-derived price due to consistency: $${jsonLikelyPrice}`);
    candidates.push(jsonLikelyPrice);
  } else if (jsonLikelyPrice) {
    console.log(`[PUPPETEER] JSON positional preferred price: $${jsonLikelyPrice}`);
    candidates.push(jsonLikelyPrice);
  }
}
// ─────────────────────────────────────────────
// END NEW SMART JSON PRICE SELECTION LOGIC
// ─────────────────────────────────────────────




// merge into your existing candidates array for unified selection later
for (const c of jsonCandidates) candidates.push(c.price);


      const deepMatches = [
        ...html.matchAll(/"price"\s*"\s*[{:,"']+[^}{"']*?([\d.]+)[^}]*?}/gi),
        ...html.matchAll(/"amount"\s*[:=]\s*"?([\d.,]+)"?/gi)
      ];
      for (const m of deepMatches) {
        let n = parseFloat(m[1].replace(/[^\d.]/g, ""));
        if (!isNaN(n) && n > 9999) n = n / 100;
        if (!isNaN(n) && n > 0 && n < 100000) candidates.push(n);
      }
      totalMatches += deepMatches.length;

      if (totalMatches) console.log(`[PUPPETEER] Inline HTML JSON matches (nested supported): ${totalMatches}`);
    } catch (e) {
      console.warn(`[PUPPETEER] Inline HTML scan failed: ${e.message || e}`);
    }

    if (customSelector) {
      let usedCustomSelector = true;
      let customSelectorSuccess = false;

      try {
        const selList = customSelector.split(",").map(s => s.trim()).filter(Boolean);
        for (const sel of selList) {
          try {
            let el = await page.$(sel);
            if (!el) {
              console.log(`[PUPPETEER] Custom selector '${sel}' not found, retrying after 10s...`);
              await new Promise(r => setTimeout(r, 10000));
              el = await page.$(sel);
              if (!el) {
                console.log(`[PUPPETEER] Custom selector '${sel}' still not found after retry`);
                continue;
              }
            }

            const txt = await page.$eval(sel, el => (el.innerText || el.textContent || "").trim());
            if (!txt) {
              console.log(`[PUPPETEER] Custom selector '${sel}' found but empty`);
              continue;
            }

            // Improved parsing: treat the entire text as one potential price, removing non-digits/dots
            const cleaned = txt.replace(/[^0-9.]/g, '');
            if (!cleaned) continue;

            let n = parseFloat(cleaned);
            const hasDecimalInRaw = cleaned.includes('.');
            if (!hasDecimalInRaw && n > 9999) n /= 100;
            n = Math.round((n + Number.EPSILON) * 100) / 100;

            if (!isNaN(n) && n > 0 && n < 100000) {
              console.log(`[PUPPETEER] Custom selector '${sel}' yielded price $${n} (cleaned: '${cleaned}')`);
              customSelectorSuccess = true;
              await browser.close().catch(() => {});
              return { price: n, error: null };
            } else {
              console.log(`[PUPPETEER] Custom selector '${sel}' cleaned to invalid price: '${cleaned}'`);
            }
          } catch (e) {
            console.warn(`[PUPPETEER] Error checking custom selector '${sel}': ${e.message || e}`);
          }
        }
      } catch (e) {
        console.warn(`[PUPPETEER] Custom selector scan failed: ${e.message || e}`);
      }

      if (usedCustomSelector && !customSelectorSuccess) {
        console.warn(`[PUPPETEER] Custom selector '${customSelector}' was defined but failed to yield a price`);
      }
    }

    if (!settings) settings = [];
    try {
      const domainKey = typeof selectorMap !== "undefined"
        ? Object.keys(selectorMap).find(k => domain.endsWith(k))
        : null;
      const selectors = domainKey ? selectorMap[domainKey] : (GENERIC_PRICE_SELECTORS || []);
      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (!el) continue;
          const txt = await page.$eval(sel, el => (el.innerText || el.textContent || "").trim());
          if (!txt) continue;
          const found = (txt.match(/[$£€]?\s?[\d\.,]+/g) || [])
            .map(t => {
              let n = parseFloat(t.replace(/[^0-9.]/g, ""));
              if (!isNaN(n) && n > 9999) n = n / 100;
              return n;
            })
            .filter(n => n && n > 0 && n < 100000);
          if (found.length) {
            candidates.push(...found);
            console.log(`[PUPPETEER] Selector ${sel} gave candidates: ${found.join(", ")}`);
            break;
          }
        } catch {}
      }
    } catch (e) {
      // ignore
    }

    // Always attempt reassembly, even if candidates exist, to capture split prices
    try {
      for (const sel of GENERIC_PRICE_SELECTORS) {
        try {
          const containerSel = sel.replace(/ .*$/, "");
          const container = await page.$(containerSel);
          if (!container) continue;
          const assembled = await container.evaluate(p =>
            Array.from(p.querySelectorAll("span"))
              .map(s => s.textContent.trim())
              .filter(t => /[\d,$.,]/.test(t))
              .join("")
          );
          if (assembled && /\d/.test(assembled)) {
            const n = parseFloat(assembled.replace(/[^\d.]/g, ""));
            if (!isNaN(n) && n > 0 && n < 100000) {
              candidates.push(n);
              console.log(`[PUPPETEER] Reassembled price from ${containerSel}: ${n} (assembled: '${assembled}')`);
            }
          }
        } catch {}
      }
    } catch (e) { /* ignore */ }

    try {
      if (candidates.length === 0) {
        const bodyText = await page.evaluate(() => document.body.innerText || "");
        const matches = (bodyText.match(/[$£€]\s?[\d\.,]+/g) || []).filter(
          t => !/off|save|discount|coupon|month|\/|per|afterpay|zip|shipping|delivery/i.test(t)
        );
        const values = matches
          .map(t => parseFloat(t.replace(/[^0-9.]/g, "")))
          .filter(v => v && v > 0 && v < 100000);
        candidates.push(...values);
        if (values.length) console.log(`[PUPPETEER] Full-text candidates: ${values.join(", ")}`);
      }
    } catch (e) {
      // ignore
    }

let finalPrice = null;
if (candidates.length > 0) {
  // Normalise all candidate values before picking final price
  const normalisedCandidates = normaliseCandidateValues(candidates);
  candidates.length = 0;
  candidates.push(...normalisedCandidates);

  const counts = {};
  for (const v of candidates) {
    // Round to 2 decimals for counting to avoid floating point issues
    const rounded = Math.round((v + Number.EPSILON) * 100) / 100;
    counts[rounded] = (counts[rounded] || 0) + 1;
  }

  const sorted = Object.entries(counts).sort((a, b) => {
    const freqDiff = b[1] - a[1];
    if (freqDiff !== 0) return freqDiff;

    const valA = parseFloat(a[0]);
    const valB = parseFloat(b[0]);

    // Prefer values with fractional parts (e.g., 67.23 over 67 or 23)
    const fracA = Math.abs(valA % 1) > 0.001 ? 1 : 0;
    const fracB = Math.abs(valB % 1) > 0.001 ? 1 : 0;
    const fracDiff = fracB - fracA;
    if (fracDiff !== 0) return fracDiff;

    // If tie, prefer smaller value (assuming sale/current price is lower)
    return valA - valB;
  });

  finalPrice = parseFloat(sorted[0][0]);
  console.log(`[PUPPETEER] Candidates: ${[...new Set(candidates)].join(", ")} → chosen: $${finalPrice}`);
} else {
  console.log(`[PUPPETEER] No price candidates found for ${url}`);
}

let error = null;
if (finalPrice === null) {
  error = "no price found";
}

await browser.close().catch(() => {});

if (outOfStockDetected) {
  // Only treat as out of stock if price is missing or changed
  if (!finalPrice) {
    console.log(`[PUPPETEER] Out of stock detected and no price found`);
    return { price: null, error: "out of stock" };
  } else {
    console.log(`[PUPPETEER] Out of stock text detected but price still available ($${finalPrice}) — ignoring`);
  }
}

return { price: finalPrice || null, error };


  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.warn(`[PUPPETEER] Failed for ${url}: ${err.message || err}`);
    return { price: null, error: err.message || "unknown error" };
  }
}


// end of puppeteer price function 


async function fetchTitleWithPuppeteer(url) {
  const domain = new URL(url).hostname.replace(/^www\./, "");
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
try {
  await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
} catch (err) {
  console.warn(`[${url}] Navigation warning: ${err.message}`);
}
await new Promise(r => setTimeout(r, 4000)); // let dynamic pages settle


    // Try the regular title tag first
    let title = await page.title();

    // For dynamic sites, try the H1 product name
    if (!title || title.trim().length < 3) {
      title = await page.evaluate(() => {
        const selectors = [
          "h1.product-title",
          "h1[itemprop='name']",
          "h1[data-testid='product-name']",
          "meta[property='og:title']",
        ];
        for (const s of selectors) {
          const el = document.querySelector(s);
          if (el) return el.textContent.trim();
        }
        const meta = document.querySelector("meta[property='og:title']");
        return meta ? meta.getAttribute("content") : "";
      });
    }

    await browser.close();
    if (title && title.length > 0) return title;
    return domain; // fallback
  } catch (e) {
    if (browser) try { await browser.close(); } catch {}
    console.warn(`Title fetch failed for ${url}:`, e.message || e);
    return domain;
  }
}


// API endpoints

app.get("/api/items", (req, res) => {
  const list = items.slice().sort((a,b) => (a.position || 0) - (b.position || 0));
  res.json(list);
});

app.post("/api/items", async (req, res) => {
  try {
    let { name, urls = [] } = req.body;
    if (!name && urls.length) {
      const firstUrl = typeof urls[0] === 'string' ? urls[0] : urls[0].url;
      name = await fetchTitleWithPuppeteer(firstUrl) || "Unnamed Product";
      console.log(`Fetched title for new product: ${name}`);
    } else if (!name) {
      name = "Unnamed Product";
    }
    const maxPos = items.reduce((m, it) => (typeof it.position === "number" ? Math.max(m, it.position) : m), -1);
    const position = maxPos + 1;
    const newItem = {
      id: uuidv4(),
      name: name,
      sites: (urls || []).map(u => {
        const url = typeof u === "string" ? u : u.url;
        return { id: uuidv4(), url, selector: null, history: [], historyDates: [], currentPrice: null, lastUpdated: null };
      }),
      priceHistory: [],
      historyDates: [],
      currentPrice: null,
      minPrice: null,
      maxPrice: null,
      bestUrl: null,
      lastUpdated: null,
      position,
      imageUrl: null
    };
    normalizeItem(newItem);
    items.push(newItem);
    saveDb();
    res.status(201).json(newItem);
  } catch (e) {
    console.error("POST /api/items error", e);
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/items/:id", (req, res) => {
  try {
    const item = items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Not found" });
    const { name, urls, position, imageUrl } = req.body;
    if (typeof name === "string") item.name = name;
    if (typeof position !== "undefined" && Number.isFinite(Number(position))) item.position = Number(position);
    if (typeof imageUrl !== "undefined") item.imageUrl = imageUrl || null;

    if (urls) {
      const existing = item.sites || [];
      const newSites = (urls || []).map(u => {
        const url = typeof u === "string" ? u : u.url;
        const selector = typeof u === "object" ? u.selector : null;
        const found = existing.find(s => s.url === url);
        if (found) { found.selector = selector || found.selector || null; return found; }
        return { id: uuidv4(), url, selector: selector || null, history: [], historyDates: [], currentPrice: null, lastUpdated: null };
      });
      item.sites = newSites;
    }

    saveDb();
    res.json(item);
  } catch (e) {
    console.error("PUT /api/items/:id error", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/items/:id", (req, res) => {
  items = items.filter(i => i.id !== req.params.id);
  saveDb();
  console.log("Deleted item:", req.params.id);
  res.status(204).send();
});

app.post("/api/items/:id/sites", (req, res) => {
  try {
    const item = items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Item not found" });
    const { url, selector } = req.body;
    if (!url) return res.status(400).json({ error: "url required" });
    const newSite = {
      id: uuidv4(),
      url: url.trim(),
      selector: selector || null,
      history: [],
      historyDates: [],
      currentPrice: null,
      lastUpdated: null
    };
    item.sites.push(newSite);
    saveDb();
    console.log(`Added new site to item ${req.params.id}: ${url}`);
    res.json(item);
  } catch (e) {
    console.error("POST /api/items/:id/sites error", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/items/:id/sites/:siteid", (req, res) => {
  try {
    const item = items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Item not found" });
    item.sites = (item.sites || []).filter(s => s.id !== req.params.siteid);
    saveDb();
    console.log(`Deleted site ${req.params.siteid} from item ${req.params.id}`);
    res.json(item);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/items/reorder', (req, res) => {
  try {
    const { id, direction } = req.body;
    const index = items.findIndex(p => p.id === id);
    if (index === -1) return res.status(404).json({ error: 'Item not found' });

    if (direction === 'up' && index > 0) {
      // move up
      [items[index - 1], items[index]] = [items[index], items[index - 1]];
    } else if (direction === 'down' && index < items.length - 1) {
      // move down
      [items[index + 1], items[index]] = [items[index], items[index + 1]];
    } else if (direction === 'top') {
      // move to top
      const [moved] = items.splice(index, 1);
      items.unshift(moved);
    }

    // normalize positions
    items.forEach((it, i) => (it.position = i));

    saveDb(); // your existing helper

    res.json({ success: true, itemsCount: items.length });
  } catch (err) {
    console.error('Reorder failed:', err);
    res.status(500).json({ error: 'Reorder failed', details: err.message });
  }
});

app.post("/api/items/:id/update", async (req, res) => {
  try {
    const item = items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Item not found" });
    console.log(`[UPDATE ITEM] Starting for item ${item.id} – ${item.sites.length} sites`);

    for (const site of item.sites) {
      try {
        const domain = new URL(site.url).hostname.replace(/^www\./, "");
        console.log(`[UPDATE ITEM] Processing site ${site.url} (domain: ${domain})`);
        const domainSetting = getSelectorForDomain(domain) || {};
        const selectorToUse = site.selector || domainSetting.selector || null;
        const scraperToUse = site.scraper || domainSetting.scraper || "auto";
        console.log(`[UPDATE ITEM] Using scraper: ${scraperToUse}, selector: ${selectorToUse || 'none'}`);

        let result;
        if (scraperToUse === "simple") {
          result = await fetchPriceSimple(site.url, selectorToUse);
        } else {
          result = await fetchPriceWithPuppeteer(site.url, selectorToUse);
        }
        console.log(`[UPDATE ITEM] Got result: ${result.price != null ? '$' + result.price : 'null'}, error: ${result.error || 'none'}`);

        if (result.price != null && !result.error && site.currentPrice != null) {
          const oldPrice = site.currentPrice;
          const changeRatio = Math.abs(result.price - oldPrice) / oldPrice;
          if (changeRatio > 0.7) {
            console.log(`[UPDATE ITEM] Big price change detected for ${site.url}: old $${oldPrice} new $${result.price}, treating as out of stock`);
            result = { price: null, error: "out of stock" };
          }
        }

        if (result.error === "out of stock") {
          console.log(`[UPDATE ITEM] Out of stock for site ${site.url}, skipping update`);
          continue;
        }

        if (result.price != null) {
          site.currentPrice = result.price;
          site.lastUpdated = new Date().toISOString();
          site.history = site.history || [];
          site.historyDates = site.historyDates || [];
          site.history.push(result.price);
          site.historyDates.push(site.lastUpdated);
          console.log(`[UPDATE ITEM] Updated price for site ${site.url} in item ${item.id}: $${result.price}`);
        } else {
          console.log(`[UPDATE ITEM] No price found for site ${site.url}`);
        }
      } catch (e) {
        console.warn(`[UPDATE ITEM] Error fetching site ${site.url}:`, e.message || e);
      }
    }

    const valid = (item.sites || []).filter(s => s.currentPrice != null);
    if (valid.length) {
      const best = valid.reduce((a, b) => a.currentPrice < b.currentPrice ? a : b);
      item.currentPrice = best.currentPrice;
      item.bestUrl = best.url;
      item.priceHistory = item.priceHistory || [];
      item.historyDates = item.historyDates || [];
      item.priceHistory.push(best.currentPrice);
      item.historyDates.push(new Date().toISOString());
      const allPrices = item.sites.flatMap(s => (s.history || [])).filter(Boolean);
      item.minPrice = allPrices.length ? Math.min(...allPrices) : item.minPrice;
      item.maxPrice = allPrices.length ? Math.max(...allPrices) : item.maxPrice;
      item.lastUpdated = new Date().toISOString();
    } else {
      console.log(`[UPDATE ITEM] No valid prices for item ${item.id}`);
    }

    saveDb();
    console.log(`[UPDATE ITEM] Finished for item ${item.id}`);
    res.json(item);
  } catch (e) {
    console.error("[UPDATE ITEM] Global error", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/items/updateAll", async (req, res) => {
  try {
    console.log(`[UPDATE ALL] Starting – ${items.length} items found`);
    for (const item of items) {
      console.log(`[UPDATE ALL] Processing item ${item.id} – ${item.sites.length} sites`);
      for (const site of item.sites) {
        try {
          const domain = new URL(site.url).hostname.replace(/^www\./, "");
          console.log(`[UPDATE ALL] Processing site ${site.url} (domain: ${domain})`);
          const domainSetting = getSelectorForDomain(domain) || {};
          const selectorToUse = site.selector || domainSetting.selector || null;
          const scraperToUse = site.scraper || domainSetting.scraper || "auto";
          console.log(`[UPDATE ALL] Using scraper: ${scraperToUse}, selector: ${selectorToUse || 'none'}`);

          let result;
          if (scraperToUse === "simple") {
            result = await fetchPriceSimple(site.url, selectorToUse);
          } else {
            result = await fetchPriceWithPuppeteer(site.url, selectorToUse);
          }
          console.log(`[UPDATE ALL] Got result: ${result.price != null ? '$' + result.price : 'null'}, error: ${result.error || 'none'}`);

          if (result.price != null && !result.error && site.currentPrice != null) {
            const oldPrice = site.currentPrice;
            const changeRatio = Math.abs(result.price - oldPrice) / oldPrice;
            if (changeRatio > 0.5) {
              console.log(`[UPDATE ALL] Big price change detected for ${site.url}: old $${oldPrice} new $${result.price}, treating as out of stock`);
              result = { price: null, error: "out of stock" };
            }
          }

          if (result.error === "out of stock") {
            console.log(`[UPDATE ALL] Out of stock for site ${site.url}, skipping update`);
            continue;
          }

          if (result.price != null) {
            site.currentPrice = result.price;
            site.lastUpdated = new Date().toISOString();
            site.history = site.history || [];
            site.historyDates = site.historyDates || [];
            site.history.push(result.price);
            site.historyDates.push(site.lastUpdated);
            console.log(`[UPDATE ALL] Updated price for site ${site.url} in item ${item.id}: $${result.price}`);
          } else {
            console.log(`[UPDATE ALL] No price found for site ${site.url}`);
          }
        } catch (e) {
          console.warn(`[UPDATE ALL] Error updating site ${site.url}`, e.message || e);
        }
      }

      const valid = (item.sites || []).filter(s => s.currentPrice != null);
      if (valid.length) {
        const best = valid.reduce((a, b) => a.currentPrice < b.currentPrice ? a : b);
        item.currentPrice = best.currentPrice;
        item.bestUrl = best.url;
        item.priceHistory = item.priceHistory || [];
        item.historyDates = item.historyDates || [];
        item.priceHistory.push(best.currentPrice);
        item.historyDates.push(new Date().toISOString());
        const allPrices = item.sites.flatMap(s => (s.history || [])).filter(Boolean);
        item.minPrice = allPrices.length ? Math.min(...allPrices) : item.minPrice;
        item.maxPrice = allPrices.length ? Math.max(...allPrices) : item.maxPrice;
        item.lastUpdated = new Date().toISOString();
      } else {
        console.log(`[UPDATE ALL] No valid prices for item ${item.id}`);
      }
    }
    saveDb();
    console.log(`[UPDATE ALL] Finished`);
    res.json({ message: "updated all" });
  } catch (e) {
    console.error("[UPDATE ALL] Global error", e);
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/settings/domains", (req, res) => {
  res.json(settings);
});

app.get("/api/settings", (req, res) => {
  res.json(settings);
});

// Save all domain settings
app.post("/api/settings/domains", (req, res) => {
  try {
    const body = req.body;
    if (!Array.isArray(body)) return res.status(400).json({ error: "expected array" });

    const normalized = body.map(entry => ({
      domain: String(entry.domain).trim(),
      selector: entry.selector ? String(entry.selector).trim() : null,
      scraper: entry.scraper ? String(entry.scraper).trim() : "auto"
    }));

    settings = normalized.filter(e => e.domain);
    saveSettings();
    res.json(settings);
  } catch (e) {
    console.error("POST /api/settings/domains error", e);
    res.status(500).json({ error: e.message });
  }
});

// Save or update a single domain
app.post("/api/settings", (req, res) => {
  try {
    const { domain, selector, scraper } = req.body;
    if (!domain) return res.status(400).json({ error: "domain required" });

    const existing = settings.find(s => s.domain === domain);
    if (existing) {
      existing.selector = selector || null;
      existing.scraper = scraper || existing.scraper || "auto";
    } else {
      settings.push({ domain, selector: selector || null, scraper: scraper || "auto" });
    }

    saveSettings();
    res.json({ message: "saved", settings });
  } catch (e) {
    console.error("POST /api/settings error", e);
    res.status(500).json({ error: e.message });
  }
});


app.delete("/api/settings/:domain", (req, res) => {
  try {
    const domain = req.params.domain;
    settings = settings.filter(s => s.domain !== domain);
    saveSettings();
    res.json({ message: "deleted", settings });
  } catch (e) {
    console.error("DELETE /api/settings/:domain error", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true, now: new Date().toISOString() }));

cron.schedule("0 */12 * * *", async () => {
  console.log("Auto-update triggered");
  try {
    await axios.post(`http://localhost:${PORT}/api/items/updateAll`);
  } catch (e) {
    console.warn("Auto-update request failed:", e.message || e);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// Add this near the top of server.js, after your imports
const serverLogs = [];
const MAX_LOGS = 200; // Keep last 200 log entries

// Capture console.log output
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

console.log = function(...args) {
  const timestamp = new Date().toLocaleString();
  const message = `[${timestamp}] ${args.join(' ')}`;
  serverLogs.push(message);
  if (serverLogs.length > MAX_LOGS) serverLogs.shift();
  originalConsoleLog.apply(console, args);
};

console.warn = function(...args) {
  const timestamp = new Date().toLocaleString();
  const message = `[${timestamp}] ⚠️ ${args.join(' ')}`;
  serverLogs.push(message);
  if (serverLogs.length > MAX_LOGS) serverLogs.shift();
  originalConsoleWarn.apply(console, args);
};

console.error = function(...args) {
  const timestamp = new Date().toLocaleString();
  const message = `[${timestamp}] ❌ ${args.join(' ')}`;
  serverLogs.push(message);
  if (serverLogs.length > MAX_LOGS) serverLogs.shift();
  originalConsoleError.apply(console, args);
};

// Add this endpoint with your other API routes (before app.listen)
app.get("/api/logs", (req, res) => {
  res.json({ logs: serverLogs });
});
