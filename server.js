// server.js
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
      return null;
    }
    const $ = cheerio.load(res.data);
    let text = null;

    let selectors = customSelector ? [customSelector] : GENERIC_PRICE_SELECTORS;
    console.log(`   🔍 Using selectors: ${selectors.join(', ')}`);

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
      console.log(`   ⚙️ Fallback to regex scan`);
      const match = $.root().text().match(/[$£€]\s?[\d.,]+/);
      if (match) {
        text = match[0];
        console.log(`   Found from regex: '${text}'`);
      }
    }

    if (!text) {
      console.log(`   No price text found`);
      return null;
    }

    text = text.replace(/,/g, "");
    const val = parseFloat(text.replace(/[^\d.]/g, ""));
    console.log(`   Parsed price: $${val}`);
    return isNaN(val) ? null : val;
  } catch (e) {
    console.warn(`[Simple] Failed for ${url}:`, e.message || e);
    return null;
  }
}

async function fetchPriceWithPuppeteer(url, customSelector = null) {
  let browser;
  const domain = new URL(url).hostname.replace(/^www\./, "");
//  const screenshotPath = `debug_${domain.replace(/\./g, "_")}_${Date.now()}.png`;
  try {
    // launch
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
      ],
      defaultViewport: { width: 1280, height: 800 }
    });

    const page = await browser.newPage();

    // user agent + headers
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36");
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    page.setDefaultNavigationTimeout(60000);

    // stealth-ish tweaks
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
      // ignore if evaluateOnNewDocument not supported in env
    }

    // Collect candidate prices from multiple sources, then pick most frequent
    const candidates = [];

    // -----------------------
    // 1) JSON response sniffing
    // -----------------------
    page.on("response", async (response) => {
      try {
        const headers = response.headers();
        const ct = headers["content-type"] || "";
        if (ct.includes("application/json")) {
          let data;
          try { data = await response.json(); } catch { return; }
          const str = JSON.stringify(data);

          // collect all matches
          const all = [
            ...str.matchAll(/"priceDisplay"\s*:\s*"?\$?([\d.,]+)/g),
            ...str.matchAll(/"salePrice"\s*:\s*"?\$?([\d.,]+)/g),
            ...str.matchAll(/"price"\s*:\s*"?\$?([\d.,]+)/g)
          ];
          for (const m of all) {
            let n = parseFloat(m[1].replace(/[^\d.]/g, ""));
if (!isNaN(n) && n > 9999) n = n / 100; // normalize cents → dollars
            if (!isNaN(n) && n > 0 && n < 100000) candidates.push(n);
          }
        }
      } catch (e) {
        // swallow
      }
    });

    // -----------------------
    // 2) Load the page (lightweight pattern that worked for JW/Bunnings)
    // -----------------------
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (e) {
      console.warn(`[PUPPETEER] Navigation warning for ${url}: ${e.message || e}`);
    }
    // give JS time to render (universal)
    await new Promise(r => setTimeout(r, 2500));

    // screenshot for debugging (helps confirm page visually rendered)
//    try {
//      await page.screenshot({ path: screenshotPath, fullPage: true });
 //     console.log(`[PUPPETEER] Saved screenshot: ${screenshotPath}`);
 //   } catch (e) {
  //    console.warn(`[PUPPETEER] Screenshot failed: ${e.message || e}`);
   // }

// -----------------------
// 3) Inline HTML JSON scan (page.content) — runs early
// -----------------------
try {
  const html = await page.content();

  // Find any numeric value assigned to keys like price, amount, salePrice, etc.,
  // even if nested inside objects or arrays.
  const pricePatterns = [
    /"priceDisplay"\s*:\s*"?\$?([\d.,]+)/gi,
    /"salePrice"\s*:\s*"?\$?([\d.,]+)/gi,
    /"price"\s*:\s*"?\$?([\d.,]+)/gi,
    /"price"\s*:\s*{\s*"amount"\s*:\s*([\d.]+)/gi,
    /"amount"\s*:\s*([\d.]+)\s*(?:,|\})/gi,
    /'priceDisplay'\s*:\s*'?\\?\$?([\d.,]+)/gi
  ];

  let totalMatches = 0;

  for (const pattern of pricePatterns) {
    const matches = [...html.matchAll(pattern)];
    totalMatches += matches.length;

    for (const m of matches) {
      let n = parseFloat(m[1].replace(/[^\d.]/g, ""));
      if (!isNaN(n) && n > 9999) n = n / 100; // normalize cents → dollars
      if (!isNaN(n) && n > 0 && n < 100000) candidates.push(n);
    }
  }

  // Extra: deep nested generic finder
  // Matches things like "price":{"value":{"amount":429}} or arrays of prices
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

  if (totalMatches)
    console.log(`[PUPPETEER] Inline HTML JSON matches (nested supported): ${totalMatches}`);
} catch (e) {
  console.warn(`[PUPPETEER] Inline HTML scan failed: ${e.message || e}`);
}

/// -----------------------
// 4) Custom selector from settings.json (absolute priority)
// -----------------------
if (customSelector) {
  let usedCustomSelector = true;
  let customSelectorSuccess = false;

  try {
    const selList = customSelector.split(",").map(s => s.trim()).filter(Boolean);
    for (const sel of selList) {
      try {
        const el = await page.$(sel);
if (!el) {
  console.log(`[PUPPETEER] Custom selector '${sel}' not found, retrying after 10s...`);
  await new Promise(r => setTimeout(r, 10000));
  const retryEl = await page.$(sel);
  if (!retryEl) {
    console.log(`[PUPPETEER] Custom selector '${sel}' still not found after retry`);
    continue;
  }
}

        const txt = await page.$eval(sel, el => (el.innerText || el.textContent || "").trim());
        if (!txt) {
          console.log(`[PUPPETEER] Custom selector '${sel}' found but empty`);
          continue;
        }

        const found = (txt.match(/[$£€]?\s?[\d\.,]+/g) || [])
          .map(t => {
            let raw = t.replace(/[^0-9.]/g, "");
            let n = parseFloat(raw);
            // Fix: only divide if no decimal and value too large
            if (!isNaN(n)) {
              if (!raw.includes(".") && n > 9999) n = n / 100;
              n = Math.round((n + Number.EPSILON) * 100) / 100; // two decimals max
            }
            return n;
          })
          .filter(n => n && n > 0 && n < 100000);

        if (found.length) {
          const chosen = Math.min(...found);
          console.log(`[PUPPETEER] Custom selector '${sel}' matched, forcing price $${chosen}`);
          customSelectorSuccess = true;
          try { await browser.close(); } catch {}
          return chosen; // absolute priority — stop here
        } else {
          console.log(`[PUPPETEER] Custom selector '${sel}' found but no valid numeric values`);
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

    // -----------------------
    // 5) Domain-specific or generic selectors
    // -----------------------
    if (!settings) settings = []; // defensive
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
            console.log(`[PUPPETEER] Selector ${sel} gave candidates: ${found.join(", ")}`);
            break; // stop after first successful selector to respect priority
          }
        } catch {}
      }
    } catch (e) {
      // ignore selectorMap errors
    }

    // -----------------------
    // 6) Split-price re-assembly (rare)
    // -----------------------
    try {
      if (candidates.length === 0) {
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
                break;
              }
            }
          } catch {}
        }
      }
    } catch (e) { /* ignore */ }

    // -----------------------
    // 7) Full text fallback
    // -----------------------
    try {
      if (candidates.length === 0) {
        const bodyText = await page.evaluate(() => document.body.innerText || "");
        const matches = (bodyText.match(/[$£€]\s?[\d\.,]+/g) || []).filter(
          t => !/off|save|discount|coupon|month|\/|per|afterpay|zip|shipping|delivery/i.test(t)
        );
        const values = matches
          .map(t => parseFloat(t.replace(/[^0-9.]/g, "")))
          .filter(v => v && v > 0 && v < 100000);
        for (const n of values) candidates.push(n);
        if (values.length) console.log(`[PUPPETEER] Full-text candidates: ${values.join(", ")}`);
      }
    } catch (e) {
      // ignore
    }

    // -----------------------
    // 8) Choose final price from candidates
    // -----------------------
    let finalPrice = null;
    if (candidates.length > 0) {
      // compute frequency map
      const counts = {};
      for (const v of candidates) {
        counts[v] = (counts[v] || 0) + 1;
      }
      // entries sorted by frequency desc, then value asc
      const sorted = Object.entries(counts).sort((a, b) => {
        const freq = b[1] - a[1];
        if (freq !== 0) return freq;
        return parseFloat(a[0]) - parseFloat(b[0]);
      });
      finalPrice = parseFloat(sorted[0][0]);
      console.log(`[PUPPETEER] Candidates: ${[...new Set(candidates)].join(", ")} → chosen: $${finalPrice}`);
    } else {
      console.log(`[PUPPETEER] No price candidates found for ${url}`);
    }

    // close and return
    try { await browser.close(); } catch (e) {}
    return finalPrice || null;

  } catch (err) {
    if (browser) try { await browser.close(); } catch (e) {}
    console.warn(`[PUPPETEER] Failed for ${url}: ${err && err.message ? err.message : err}`);
    return null;
  }
}



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
  console.log("🗑️ Deleted item:", req.params.id);
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

        let price;
        if (scraperToUse === "simple") {
          price = await fetchPriceSimple(site.url, selectorToUse);
        } else {
          price = await fetchPriceWithPuppeteer(site.url, selectorToUse);
        }
        console.log(`[UPDATE ITEM] Got price: ${price != null ? '$' + price : 'null'}`);

        if (price != null) {
          site.currentPrice = price;
          site.lastUpdated = new Date().toISOString();
          site.history = site.history || [];
          site.historyDates = site.historyDates || [];
          site.history.push(price);
          site.historyDates.push(site.lastUpdated);
          console.log(`[UPDATE ITEM] Updated price for site ${site.url} in item ${item.id}: $${price}`);
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

          let price;
          if (scraperToUse === "simple") {
            price = await fetchPriceSimple(site.url, selectorToUse);
          } else {
            price = await fetchPriceWithPuppeteer(site.url, selectorToUse);
          }
          console.log(`[UPDATE ALL] Got price: ${price != null ? '$' + price : 'null'}`);

          if (price != null) {
            site.currentPrice = price;
            site.lastUpdated = new Date().toISOString();
            site.history = site.history || [];
            site.historyDates = site.historyDates || [];
            site.history.push(price);
            site.historyDates.push(site.lastUpdated);
            console.log(`[UPDATE ALL] Updated price for site ${site.url} in item ${item.id}: $${price}`);
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
