/**
 * FasalEx · DeepGazerAI
 * server.js — Production Server
 * 
 * Features:
 *   /api/analyze     — AI grading via Claude
 *   /api/identify    — Produce identification
 *   /api/prices      — Live global price intelligence
 *   /api/health      — Health + price freshness check
 *   Background job   — Daily price refresh (all sources)
 * 
 * Price Sources:
 *   USDA AMS         — USA wholesale (free, no auth)
 *   World Bank       — Global commodity pinksheet (free)
 *   EU AGRI          — EU farm gate prices (free)
 *   FAO GIEWS        — World food price index (free)
 *   Exchange rates   — INR conversion (free)
 * 
 * Patent: K = D_known/D_px · DeepGazerAI Vision Engine
 * © 2026 H DoddanaGouda · Hospet, Karnataka · Patent Pending
 */

'use strict';

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const url     = require('url');

const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CACHE_FILE = path.join(__dirname, 'price_cache.json');

// ═══════════════════════════════════════════════════════════════
//  PRICE CACHE — in-memory + file backed
// ═══════════════════════════════════════════════════════════════

let priceCache = {
  lastUpdated: null,
  lastAttempt: null,
  sources: {},
  exchange: { USD_INR: 83.5, EUR_INR: 90.2, GBP_INR: 106.0 },
  commodities: {},
  status: 'initialising',
};

function loadCacheFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      priceCache = { ...priceCache, ...data };
      console.log('[PRICES] Cache loaded from disk — last updated:', priceCache.lastUpdated);
    }
  } catch (e) {
    console.warn('[PRICES] Could not load cache from disk:', e.message);
  }
}

function saveCacheToDisk() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(priceCache, null, 2));
  } catch (e) {
    console.warn('[PRICES] Could not save cache:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  HTTP HELPER — fetch JSON from any URL
// ═══════════════════════════════════════════════════════════════

function fetchJSON(targetUrl, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(targetUrl, {
      headers: {
        'User-Agent': 'FasalEx-PriceFetcher/1.0 (fasalex.com)',
        'Accept': 'application/json',
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ═══════════════════════════════════════════════════════════════
//  SOURCE 1 — WORLD BANK COMMODITY PRICES (Pinksheet)
//  Free · No auth · Monthly updates
//  Covers: Wheat, Rice, Maize, Soybean, Palm Oil, Sugar, Coffee
// ═══════════════════════════════════════════════════════════════

async function fetchWorldBank() {
  // World Bank API — commodity price data (USD per metric tonne)
  const commodities = {
    'WHEAT_US_HRW': 'Wheat',
    'RICE_05_VNM':  'Rice / Paddy',
    'MAIZE_US':     'Maize / Corn',
    'SOYBEANS':     'Soybean',
    'SUGAR_WLD':    'Sugarcane',
    'GRNUT_US':     'Groundnut',
  };

  const results = {};
  for (const [indicator, name] of Object.entries(commodities)) {
    try {
      const data = await fetchJSON(
        `https://api.worldbank.org/v2/en/indicator/${indicator}?downloadformat=json&mrv=1&format=json`
      );
      // World Bank returns array [meta, data]
      const val = Array.isArray(data) && data[1]?.[0]?.value;
      if (val) {
        const usdPerTonne = parseFloat(val);
        const inrPerQtl = Math.round(usdPerTonne * priceCache.exchange.USD_INR / 10); // tonne→qtl
        results[name] = {
          usd_per_tonne: usdPerTonne,
          inr_per_qtl: inrPerQtl,
          source: 'World Bank Pinksheet',
          date: data[1]?.[0]?.date || 'Latest',
        };
      }
    } catch (e) {
      // silently skip failed commodities
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
//  SOURCE 2 — USDA AMS MARKET NEWS (free, no auth)
//  Covers: Grains, Fruits, Vegetables — USA wholesale
// ═══════════════════════════════════════════════════════════════

async function fetchUSDA() {
  const results = {};
  try {
    // USDA AMS MARS API — grain prices
    const grainData = await fetchJSON(
      'https://marsapi.ams.usda.gov/services/v1.2/reports/2172?q=commodity=Wheat&allSections=true'
    );
    if (grainData?.results?.[0]) {
      const r = grainData.results[0];
      // Convert USD/bushel to INR/qtl (1 bushel wheat = 27.2kg)
      const usdBushel = parseFloat(r.price || r.avg_price || 5.5);
      const inrQtl = Math.round(usdBushel * 3.674 * priceCache.exchange.USD_INR); // bushel→qtl conversion
      results['Wheat'] = {
        usd_per_bushel: usdBushel,
        inr_per_qtl: inrQtl,
        source: 'USDA AMS',
        market: 'US Wholesale',
        date: r.report_date || new Date().toISOString().slice(0,10),
      };
    }
  } catch (e) {}

  // USDA commodity spot prices
  try {
    const spotData = await fetchJSON(
      'https://marsapi.ams.usda.gov/services/v1.2/reports/1234?allSections=true'
    );
    if (spotData?.results) {
      spotData.results.slice(0, 5).forEach(r => {
        if (r.commodity_name && r.price) {
          const inrQtl = Math.round(parseFloat(r.price) * 100 * priceCache.exchange.USD_INR / 100);
          results[r.commodity_name] = {
            source: 'USDA AMS',
            inr_per_qtl: inrQtl,
            date: r.report_date,
          };
        }
      });
    }
  } catch (e) {}

  return results;
}

// ═══════════════════════════════════════════════════════════════
//  SOURCE 3 — EU AGRI MARKET DATA
//  Free REST API · Weekly updates
// ═══════════════════════════════════════════════════════════════

async function fetchEUAgri() {
  const results = {};
  try {
    // EU Agricultural Markets Information System (AMIS)
    const data = await fetchJSON(
      'https://agridata.ec.europa.eu/api/DataSets/AgriCommodityPrices?$top=20&$format=json'
    );
    if (data?.value) {
      data.value.forEach(item => {
        if (item.CommodityName && item.AveragePrice) {
          const eurPerTonne = parseFloat(item.AveragePrice);
          const inrPerQtl = Math.round(eurPerTonne * priceCache.exchange.EUR_INR / 10);
          results[item.CommodityName] = {
            eur_per_tonne: eurPerTonne,
            inr_per_qtl: inrPerQtl,
            source: 'EU AGRI Portal',
            date: item.MarketDate || new Date().toISOString().slice(0,10),
          };
        }
      });
    }
  } catch (e) {}
  return results;
}

// ═══════════════════════════════════════════════════════════════
//  SOURCE 4 — FAO FOOD PRICE INDEX
//  Free REST · Monthly — overall food inflation indicator
// ═══════════════════════════════════════════════════════════════

async function fetchFAO() {
  const results = { index: {} };
  try {
    const data = await fetchJSON(
      'https://www.fao.org/giews/food-prices/api/v1/priceSeries/?currencyCode=INR&commodityCode=WHEAT&marketCode=1'
    );
    if (data?.data?.[0]) {
      results.index.wheat_inr = data.data[0].price;
      results.index.source = 'FAO GIEWS';
      results.index.date = data.data[0].date;
    }
  } catch (e) {}

  // FAO Food Price Index (monthly composite)
  try {
    const fpi = await fetchJSON(
      'https://www.fao.org/giews/food-prices/api/v1/foodPriceIndex/?months=1'
    );
    if (fpi?.data?.[0]) {
      results.foodPriceIndex = {
        value: fpi.data[0].value,
        change: fpi.data[0].change,
        date: fpi.data[0].date,
        source: 'FAO Food Price Index',
      };
    }
  } catch (e) {}

  return results;
}

// ═══════════════════════════════════════════════════════════════
//  SOURCE 5 — EXCHANGE RATES (free, no auth)
// ═══════════════════════════════════════════════════════════════

async function fetchExchangeRates() {
  try {
    const data = await fetchJSON(
      'https://open.er-api.com/v6/latest/USD'
    );
    if (data?.rates) {
      const rates = data.rates;
      priceCache.exchange = {
        USD_INR: rates.INR || 83.5,
        EUR_INR: (rates.INR / rates.EUR) || 90.2,
        GBP_INR: (rates.INR / rates.GBP) || 106.0,
        AED_INR: (rates.INR / rates.AED) || 22.7,
        updated: new Date().toISOString(),
      };
      console.log('[PRICES] Exchange rates updated — USD/INR:', priceCache.exchange.USD_INR.toFixed(2));
      return true;
    }
  } catch (e) {
    console.warn('[PRICES] Exchange rate fetch failed:', e.message);
  }
  return false;
}


// ══════════════════════════════════════════════════
//  AGMARK VISUAL THRESHOLDS (server-side)
//  Injected into AI grading prompt per commodity
// ══════════════════════════════════════════════════
const AGMARK_SRV = {
  'Wheat':         { gr1:'Bold >2.5mm, <1% damage, <0.25% FM, golden colour', gr2:'<2% damage, <0.5% FM', moisture:'≤12%' },
  'Rice / Paddy':  { gr1:'Long grain >6mm, <1% broken, <0.25% FM, white/cream', gr2:'<3% broken, <0.5% FM', moisture:'≤14%' },
  'Maize / Corn':  { gr1:'Kernel >8mm, <1% damage, <0.5% FM, yellow/white', gr2:'<2% damage, <1% FM', moisture:'≤14%' },
  'Moong (Whole)': { gr1:'Bold >4mm, <1% damage, <0.25% FM, bright green shiny', gr2:'<2% damage, <0.5% FM', moisture:'≤12%' },
  'Toor Dal':      { gr1:'Round >5mm, <1% damage, <0.25% FM, yellow/cream', gr2:'<2% damage, <0.5% FM', moisture:'≤12%' },
  'Chana Dal':     { gr1:'Bold >6mm, <1% damage, <0.25% FM, uniform yellow', gr2:'<2% damage, <0.5% FM', moisture:'≤12%' },
  'Chana':         { gr1:'Kabuli >8mm Desi >6mm, <2% damage, <0.5% FM', gr2:'<3% damage, <1% FM', moisture:'≤12%' },
  'Soybean':       { gr1:'Uniform >6mm no split, <1% damage, <0.5% FM', gr2:'<2% damage, <1% FM', moisture:'≤12%' },
  'Groundnut':     { gr1:'Bold kernels >12mm, <1% damage, <0.5% FM', gr2:'<2% damage, <1% FM', moisture:'≤8%' },
  'Tomato':        { gr1:'65-85mm dia >90% red, <2% damage, no FM', gr2:'50-65mm dia >75% red', moisture:'—' },
  'Onion':         { gr1:'45-60mm dia dry outer skin, <2% damage, no FM', gr2:'35-45mm dia', moisture:'≤80%' },
  'Potato':        { gr1:'>45mm dia no greening, <2% damage, no FM', gr2:'35-45mm dia', moisture:'≤85%' },
  'Chilli':        { gr1:'Uniform 6-8cm >90% red ASTA, <2% damage, <0.5% FM', gr2:'<3% damage, <1% FM', moisture:'≤10%' },
  'Turmeric':      { gr1:'Bold fingers >40mm bright yellow, <1% damage, <0.5% FM', gr2:'<2% damage, <1% FM', moisture:'≤8%' },
  'Mango':         { gr1:'>65mm dia uniform colour, <1% damage', gr2:'55-65mm dia', moisture:'—' },
  'Tiger Prawn':   { gr1:'21-30 count/kg >15g each, uniform pink-grey, no damage', gr2:'31-40 count/kg', moisture:'—' },
  'Cow Milk':      { gr1:'FAT ≥3.5% SNF ≥8.5% white uniform no sediment', gr2:'FAT ≥3.0% SNF ≥8.0%', moisture:'—' },
  'Ghee (Cow)':    { gr1:'Granular structure golden yellow clear no sediment', gr2:'Semi-granular', moisture:'≤0.3%' },
};

// ═══════════════════════════════════════════════════════════════
//  STATIC FALLBACK PRICES — always valid even if APIs fail
//  Based on March 2026 benchmarks
// ═══════════════════════════════════════════════════════════════

const STATIC_FALLBACK = {
  'Wheat':         { domestic: 2180, dubai: 2650, eu: 2890, usda: 3100 },
  'Rice / Paddy':  { domestic: 3640, dubai: 4800, eu: 5200, usda: 4950 },
  'Maize / Corn':  { domestic: 1890, dubai: 2100, eu: 2280, usda: 2450 },
  'Moong (Whole)': { domestic: 9200, dubai:12800, eu:13500, usda:11900 },
  'Toor Dal':      { domestic: 7700, dubai:10200, eu: 9800, usda: 9500 },
  'Chana Dal':     { domestic: 5200, dubai: 7100, eu: 7800, usda: 6900 },
  'Soybean':       { domestic: 4500, dubai: 5100, eu: 5600, usda: 6200 },
  'Groundnut':     { domestic: 5500, dubai: 7200, eu: 8100, usda: 7600 },
  'Tomato':        { domestic: 1600, dubai: 3200, eu: 2800, usda: 2600 },
  'Onion':         { domestic: 2100, dubai: 3800, eu: 3200, usda: 3100 },
  'Chilli':        { domestic:12000, dubai:18500, eu:16200, usda:17800 },
  'Turmeric':      { domestic:14000, dubai:22000, eu:24500, usda:21000 },
  'Ginger':        { domestic: 5800, dubai: 9200, eu:10800, usda: 9500 },
  'Mango':         { domestic: 4200, dubai: 8500, eu: 9800, usda: 7200 },
  'Banana':        { domestic: 2200, dubai: 3600, eu: 3200, usda: 3400 },
  'Grapes':        { domestic: 6000, dubai:10200, eu:12500, usda:11000 },
  'Tiger Prawn':   { domestic:  650, dubai: 1100, eu: 1280, usda: 1350 },
  'Tuna':          { domestic:  240, dubai:  580, eu:  720, usda:  820  },
  'Pomfret':       { domestic:  420, dubai:  780, eu:  680, usda:  650  },
};

// Build commodity map from live + fallback data
function buildCommodityPrices(liveData) {
  const result = {};
  const ex = priceCache.exchange;

  for (const [name, fallback] of Object.entries(STATIC_FALLBACK)) {
    const live = liveData[name] || {};

    // Prefer live data, fall back to static
    const domestic = live.inr_domestic || fallback.domestic;
    const dubai    = live.inr_dubai    || Math.round(fallback.dubai * (ex.USD_INR / 83.5));
    const eu       = live.inr_eu       || Math.round(fallback.eu    * (ex.EUR_INR / 90.2));
    const usda     = live.inr_usda     || Math.round(fallback.usda  * (ex.USD_INR / 83.5));

    const all = { domestic, dubai, eu, usda };
    const bestRoute = Object.entries(all).reduce((a, b) => b[1] > a[1] ? b : a)[0];

    result[name] = {
      domestic: `₹${domestic.toLocaleString('en-IN')}/qtl`,
      dubai:    `₹${dubai.toLocaleString('en-IN')}/qtl`,
      eu:       `₹${eu.toLocaleString('en-IN')}/qtl`,
      usda:     `₹${usda.toLocaleString('en-IN')}/qtl`,
      bestRoute,
      premiumPct: Math.round(((Math.max(dubai, eu, usda) - domestic) / domestic) * 100),
      source: live.source || 'FasalEx Benchmark',
      raw: { domestic, dubai, eu, usda },
    };
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
//  MAIN PRICE REFRESH — runs daily
// ═══════════════════════════════════════════════════════════════

async function refreshPrices() {
  console.log('[PRICES] Starting daily price refresh —', new Date().toISOString());
  priceCache.lastAttempt = new Date().toISOString();
  priceCache.status = 'fetching';

  const liveData = {};

  // 1. Exchange rates first (needed for conversions)
  await fetchExchangeRates();

  // 2. Fetch all sources in parallel
  const [wb, usda, eu, fao] = await Promise.allSettled([
    fetchWorldBank(),
    fetchUSDA(),
    fetchEUAgri(),
    fetchFAO(),
  ]);

  const sourceStatus = {};

  if (wb.status === 'fulfilled') {
    Object.assign(liveData, wb.value);
    sourceStatus.worldbank = { ok: true, count: Object.keys(wb.value).length };
    console.log('[PRICES] World Bank OK —', Object.keys(wb.value).length, 'commodities');
  } else {
    sourceStatus.worldbank = { ok: false, error: wb.reason?.message };
    console.warn('[PRICES] World Bank failed:', wb.reason?.message);
  }

  if (usda.status === 'fulfilled') {
    Object.assign(liveData, usda.value);
    sourceStatus.usda = { ok: true, count: Object.keys(usda.value).length };
    console.log('[PRICES] USDA AMS OK —', Object.keys(usda.value).length, 'commodities');
  } else {
    sourceStatus.usda = { ok: false, error: usda.reason?.message };
    console.warn('[PRICES] USDA failed:', usda.reason?.message);
  }

  if (eu.status === 'fulfilled') {
    Object.assign(liveData, eu.value);
    sourceStatus.eu = { ok: true, count: Object.keys(eu.value).length };
    console.log('[PRICES] EU AGRI OK —', Object.keys(eu.value).length, 'commodities');
  } else {
    sourceStatus.eu = { ok: false, error: eu.reason?.message };
    console.warn('[PRICES] EU AGRI failed:', eu.reason?.message);
  }

  if (fao.status === 'fulfilled') {
    priceCache.fao = fao.value;
    sourceStatus.fao = { ok: true };
    console.log('[PRICES] FAO OK');
  } else {
    sourceStatus.fao = { ok: false, error: fao.reason?.message };
  }

  // 3. Build unified commodity map
  priceCache.commodities  = buildCommodityPrices(liveData);
  priceCache.sources      = sourceStatus;
  priceCache.lastUpdated  = new Date().toISOString();
  priceCache.status       = 'ok';

  const liveCount = Object.values(sourceStatus).filter(s => s.ok).length;
  console.log(`[PRICES] Refresh complete — ${liveCount}/4 sources live, ${Object.keys(priceCache.commodities).length} commodities`);

  saveCacheToDisk();
}

// Schedule daily refresh at 06:00 IST (00:30 UTC)
function scheduleDailyRefresh() {
  const now       = new Date();
  const next      = new Date();
  next.setUTCHours(0, 30, 0, 0); // 06:00 IST = 00:30 UTC
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  console.log(`[PRICES] Next refresh scheduled in ${Math.round(msUntil/3600000)}h`);
  setTimeout(() => {
    refreshPrices();
    setInterval(refreshPrices, 24 * 60 * 60 * 1000); // then every 24h
  }, msUntil);
}

// ═══════════════════════════════════════════════════════════════
//  ANTHROPIC API CALL
// ═══════════════════════════════════════════════════════════════

function callClaude(messages, maxTokens = 1800) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      messages,
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(40000, () => { req.destroy(); reject(new Error('Claude API timeout')); });
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
//  REQUEST HANDLERS
// ═══════════════════════════════════════════════════════════════

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 2e6) { req.destroy(); } });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://www.fasalex.com',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

// ── /api/prices ────────────────────────────────────────────────
async function handlePrices(req, res) {
  const q = url.parse(req.url, true).query;
  const produce = q.produce || null;

  const data = {
    status: priceCache.status,
    lastUpdated: priceCache.lastUpdated,
    lastAttempt: priceCache.lastAttempt,
    exchange: priceCache.exchange,
    sources: priceCache.sources,
    fao: priceCache.fao,
  };

  if (produce && priceCache.commodities[produce]) {
    data.commodity = priceCache.commodities[produce];
    data.commodity.name = produce;
  } else {
    data.commodities = priceCache.commodities;
  }

  sendJSON(res, 200, data);
}

// ── /api/health ────────────────────────────────────────────────
function handleHealth(req, res) {
  const hoursOld = priceCache.lastUpdated
    ? Math.round((Date.now() - new Date(priceCache.lastUpdated)) / 3600000)
    : null;

  sendJSON(res, 200, {
    status: 'ok',
    app: 'FasalEx',
    version: '6.0',
    priceCache: {
      status: priceCache.status,
      lastUpdated: priceCache.lastUpdated,
      hoursOld,
      commodityCount: Object.keys(priceCache.commodities).length,
      sourcesOk: Object.values(priceCache.sources).filter(s => s.ok).length,
    },
    apiKey: API_KEY ? 'configured' : 'missing',
    timestamp: new Date().toISOString(),
  });
}

// ── /api/identify ──────────────────────────────────────────────
async function handleIdentify(req, res) {
  if (!API_KEY) return sendJSON(res, 503, { error: 'API key not configured' });
  try {
    const { imageBase64, sector } = await parseBody(req);
    if (!imageBase64) return sendJSON(res, 400, { error: 'imageBase64 required' });

    const result = await callClaude([{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: `You are DeepGazerAI, an expert agricultural produce identification system.

Identify this produce image precisely.
Sector hint: ${sector||'agri'}

Respond ONLY with valid JSON (no markdown, no extra text):
{
  "produce": "exact produce name matching: Wheat / Rice / Paddy / Maize / Moong (Whole) / Moong Dal / Toor Dal / Chana Dal / Soybean / Groundnut / Tomato / Onion / Potato / Chilli / Turmeric / Ginger / Mango / Banana / Grapes / Tiger Prawn / Rohu / Pomfret / Cow Milk / Buffalo Milk / Paneer / Ghee (Cow) / or closest match",
  "sector": "agri|dairy|fish",
  "tag": "grain|pulse|oilseed|veggie|fruit|spice|liquid|seafood",
  "confidence": 85,
  "description": "1 sentence: colour, texture, visible quality",
  "size_spec": "typical size range e.g. 4-6mm diameter / 60-80mm length",
  "agmark_grade_hint": "A|B|C based on visible quality",
  "reference_objects_detected": ["list any ISO/IEC/BIS objects visible: SIM card / ruler / battery / A4 paper / ID card / none"]
}` },
      ],
    }], 400);

    const text = result.content?.[0]?.text || '';
    const clean = text.replace(/\`\`\`json|\`\`\`/g,'').trim();
    const m = clean.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON in response');
    const identified = JSON.parse(m[0]);

    // Log if reference objects detected (patent evidence)
    if(identified.reference_objects_detected?.length &&
       !identified.reference_objects_detected.includes('none')) {
      console.log('[IDENTIFY] Reference objects detected:', identified.reference_objects_detected.join(', '));
    }

    sendJSON(res, 200, identified);
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}

// ── /api/analyze ───────────────────────────────────────────────
async function handleAnalyze(req, res) {
  if (!API_KEY) return sendJSON(res, 503, { error: 'API key not configured' });

  try {
    const { produce, sector, qty, unit, language, farmerName, gps, imageBase64 } = await parseBody(req);
    if (!produce) return sendJSON(res, 400, { error: 'produce required' });

    // Inject live price data for this commodity
    const livePrice = priceCache.commodities[produce];
    const priceContext = livePrice
      ? `Live prices for ${produce}: Domestic ₹${livePrice.raw?.domestic}/qtl, Dubai ₹${livePrice.raw?.dubai}/qtl, EU ₹${livePrice.raw?.eu}/qtl, USA ₹${livePrice.raw?.usda}/qtl. Best route: ${livePrice.bestRoute} (+${livePrice.premiumPct}% premium). Exchange rates: USD/INR=${priceCache.exchange.USD_INR}, EUR/INR=${priceCache.exchange.EUR_INR}.`
      : `Use your knowledge of current Indian market prices for ${produce}.`;

    // AGMARK thresholds for this commodity
    const agmarkSpec = AGMARK_SRV[produce];
    const agmarkContext = agmarkSpec
      ? `AGMARK Grade Standards for ${produce}:
Grade 1 (visual): ${agmarkSpec.gr1}
Grade 2 (visual): ${agmarkSpec.gr2}
Moisture spec: ${agmarkSpec.moisture}

CRITICAL STEP — Reference Object K-Calibration:
Scan the image for: credit/debit card (85.6x54mm ISO/IEC 7810), SIM packet (25x15mm), ruler, AAA battery (44.5mm), A4 paper (210mm width).
If found: (1) estimate card/object pixel width as card_px integer, (2) estimate average grain pixel width as grain_px integer.
Compute: k_value = known_mm / card_px, grain_mm = grain_px * k_value.
Set ref_object.detected=true and populate all fields accurately.
If not found: set ref_object.detected=false.
Also evaluate each AGMARK parameter with measured value, spec, PASS/FAIL/BORDERLINE.`
      : `Use your AGMARK knowledge for ${produce}. Detect reference objects for K-calibration.`;

    // Post-process: server-side K computation from Claude's pixel measurements
    function computeKFromReport(report) {
      const ro = report?.ref_object;
      if(!ro || !ro.detected || !ro.card_px || !ro.grain_px) return report;
      const knownDims = {bank_card:85.6, credit_card:85.6, debit_card:85.6, sim_packet:25.0, ruler:10.0, battery_aaa:44.5, a4_paper:210.0};
      const D_known = ro.known_width_mm || knownDims[ro.type] || 85.6;
      const K = D_known / ro.card_px;
      const grain_mm = (ro.grain_px * K).toFixed(2);
      report.ref_object.k_value = Math.round(K*10000)/10000;
      report.ref_object.grain_mm_calibrated = grain_mm + 'mm';
      report.ref_object.method = 'k_calibrated_server';
      // Update size_measurements with K-calibrated value
      if(report.size_measurements) {
        report.size_measurements.avg_unit_size_mm = grain_mm + 'mm';
        report.size_measurements.method = 'k_calibrated';
        report.size_measurements.note = 'K-calibrated from '+ro.type+' ('+D_known+'mm known dimension)';
      }
      console.log('[K-CAL] '+produce+': K='+K.toFixed(4)+' grain='+grain_mm+'mm from '+ro.type);
      return report;
    }

    const langPrompt = language && language !== 'English'
      ? `IMPORTANT: Write aiRemark, aiRemarkNative, marketInsight, expertTip in ${language}. Also provide "aiRemarkNative" field with 2-3 sentences in ${language} for the farmer.`
      : '';

    const imageContent = imageBase64
      ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } }]
      : [];

    const result = await callClaude([{
      role: 'user',
      content: [
        ...imageContent,
        {
          type: 'text',
          text: `You are FasalEx DeepGazerAI, an expert grading system for agricultural produce.

Produce: ${produce}
Sector: ${sector}
Quantity: ${qty} ${unit}
Farmer: ${farmerName || 'Farmer'}
GPS: ${gps?.lat}°N ${gps?.lon}°E
Date: ${new Date().toLocaleDateString('en-IN')}
${priceContext}
${langPrompt}

Analyse the image carefully. Grade against AGMARK standards.
${agmarkContext}
Estimate grain/unit SIZE in mm from the image. If SIM card/ruler/battery visible use it for calibration.
Respond ONLY with compact JSON (no markdown):
{
  "produce": "${produce}",
  "sector": "${sector}",
  "qty": "${qty} ${unit}",
  "unit": "${unit}",
  "farmerName": "${farmerName || 'Farmer'}",
  "overallGrade": "A|B|C|D",
  "gradeLabel": "Grade description",
  "confidence": 85,
  "shelfLife": "X-Y days/months",
  "estimatedRevenue": "₹X,XXX-Y,YYY",
  "marketRate": "₹X,XXX/qtl APMC",
  "bestAction": "sell_now|store_wait|partial_sell",
  "expertTip": "Tip in 1 sentence",
  "aiRemark": "2 sentence quality analysis",
  "aiRemarkNative": "2 sentences in ${language || 'English'}",
  "marketInsight": "1 sentence market conditions",
  "size_measurements": {"avg_unit_size_mm": "4.5mm", "size_range_mm": "4.0-5.2mm", "size_uniformity_pct": 75, "agmark_size_spec": ">4.0mm Grade 1", "size_grade_result": "PASS", "method": "visual_estimate"},
  "grades": {"A": {"label": "Premium", "pct": 20, "priceRange": "₹X-Y"}, "B": {"label": "Good", "pct": 65, "priceRange": "₹X-Y"}, "C": {"label": "Fair", "pct": 12, "priceRange": "₹X-Y"}, "D": {"label": "Below", "pct": 3, "priceRange": "Processing"}},
  "parameters": [
    {"name": "Size/Weight", "standard": "per AGMARK spec", "found": "4.5mm avg", "pass": true},
    {"name": "Colour/Texture", "standard": "Uniform characteristic", "found": "Good uniform", "pass": true},
    {"name": "Damage/Defects", "standard": "<2%", "found": "1.2%", "pass": true},
    {"name": "Foreign Matter", "standard": "<0.25%", "found": "None", "pass": true},
    {"name": "Moisture (visual)", "standard": "≤12% (lab needed)", "found": "Normal sheen", "pass": true}
  ],
  "buyers": [
    {"name": "Local Trader",    "role": "Wholesaler",  "dist": "8 km",  "phone": "+91 98765 43210", "offer": "₹X,XXX/qtl", "rating": "4.7", "verified": true},
    {"name": "Regional Buyer",  "role": "APMC Agent",  "dist": "22 km", "phone": "+91 87654 32109", "offer": "₹X,XXX/qtl", "rating": "4.5", "verified": true},
    {"name": "Export Partner",  "role": "Exporter",    "dist": "45 km", "phone": "+91 76543 21098", "offer": "₹X,XXX/qtl", "rating": "4.8", "verified": true}
  ],
  "exportCerts": ["AGMARK", "FSSAI"],
  "ref_object": {"detected": false, "type": "none", "card_px": 0, "grain_px": 0, "k_value": 0, "grain_mm_calibrated": "visual_est", "known_width_mm": 85.6},
  "gps": {"lat": "${gps?.lat || '21.1458'}", "lon": "${gps?.lon || '79.0882'}"},
  "date": "${new Date().toLocaleDateString('en-IN')}"
}`
        }
      ],
    }], 2000);

    const text = result.content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON in response');

    let report = JSON.parse(m[0]);
    // Apply server-side K calibration if reference object detected
    report = computeKFromReport(report);

    // Inject live prices into report if available
    if (livePrice) {
      report._livePrices = {
        domestic: livePrice.domestic,
        dubai:    livePrice.dubai,
        eu:       livePrice.eu,
        usda:     livePrice.usda,
        bestRoute: livePrice.bestRoute,
        premiumPct: livePrice.premiumPct,
        source:    livePrice.source,
        asOf:      priceCache.lastUpdated,
      };
    }

    sendJSON(res, 200, report);

  } catch (e) {
    console.error('[ANALYZE]', e.message);
    sendJSON(res, 500, { error: e.message });
  }
}

// ── /api/refresh-prices (manual trigger) ──────────────────────
async function handleRefreshPrices(req, res) {
  // Simple auth: secret param
  const q = url.parse(req.url, true).query;
  if (q.secret !== (process.env.REFRESH_SECRET || 'fasalex2026')) {
    return sendJSON(res, 403, { error: 'Forbidden' });
  }
  sendJSON(res, 202, { status: 'refresh_started', timestamp: new Date().toISOString() });
  refreshPrices(); // async — don't await
}

// ═══════════════════════════════════════════════════════════════
//  STATIC FILE SERVER
// ═══════════════════════════════════════════════════════════════

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
};

function serveStatic(req, res) {
  let filePath = req.url.split('?')[0];
  if (filePath === '/' || !path.extname(filePath)) filePath = '/index.html';
  const fullPath = path.join(__dirname, 'public', filePath);

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(fullPath);
    const mime = MIME[ext] || 'application/octet-stream';
    const maxAge = ext === '.html' ? 0 : 86400;
    // Force no-cache on HTML — always serve fresh
    if(ext === '.html'){
      res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma','no-cache');
      res.setHeader('Expires','0');
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': `public, max-age=${maxAge}`,
    });
    res.end(data);
  });
}

// ═══════════════════════════════════════════════════════════════
//  MAIN HTTP SERVER
// ═══════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': 'https://www.fasalex.com',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // Rate limiting — 30 requests per minute per IP
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (!rateLimit(clientIP, 30)) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://www.fasalex.com' });
    return res.end(JSON.stringify({ error: 'Too many requests. Please wait.' }));
  }
  const { pathname } = url.parse(req.url);

  try {
    if (pathname === '/api/prices'          && req.method === 'GET')  return await handlePrices(req, res);
    if (pathname === '/api/health'          && req.method === 'GET')  return handleHealth(req, res);
    if (pathname === '/api/identify'        && req.method === 'POST') return await handleIdentify(req, res);
    if (pathname === '/api/analyze'         && req.method === 'POST') return await handleAnalyze(req, res);
    if (pathname === '/api/refresh-prices'  && req.method === 'GET')  return await handleRefreshPrices(req, res);
    if (pathname === '/api/certificate'         && req.method === 'POST') return await handleCertificate(req, res);
    return serveStatic(req, res);
  } catch (e) {
    console.error('[SERVER ERROR]', e.message);
    sendJSON(res, 500, { error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════════════════════

loadCacheFromDisk();

server.listen(PORT, () => {
  console.log('');
  console.log('  🌿 FasalEx · DeepGazerAI');
  console.log('  📜 Certificate: Puppeteer server-side generation');
  console.log('  ─────────────────────────────');
  console.log(`  Server  : http://localhost:${PORT}`);
  console.log(`  API Key : ${API_KEY ? '✓ configured' : '✗ MISSING — set ANTHROPIC_API_KEY'}`);
  console.log(`  Prices  : ${priceCache.lastUpdated ? 'cached (' + priceCache.lastUpdated + ')' : 'not yet fetched'}`);
  console.log('');

  // Fetch prices immediately on startup if cache is stale (>6 hours)
  const stale = !priceCache.lastUpdated ||
    (Date.now() - new Date(priceCache.lastUpdated)) > 6 * 3600 * 1000;

  if (stale) {
    console.log('[PRICES] Cache stale — fetching now...');
    refreshPrices();
  } else {
    console.log('[PRICES] Cache fresh — next refresh scheduled');
  }

  scheduleDailyRefresh();
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} in use — try PORT=3001 node server.js`);
  } else {
    console.error('[SERVER]', e.message);
  }
  process.exit(1);
});

process.on('uncaughtException', e => console.error('[UNCAUGHT]', e.message));
process.on('unhandledRejection', e => console.error('[UNHANDLED]', e));

// ═══════════════════════════════════════════════════════════════
//  RATE LIMITING — Simple IP-based (no dependencies)
// ═══════════════════════════════════════════════════════════════

const _ratemap = new Map();
function rateLimit(ip, maxPerMin = 20) {
  const now = Date.now();
  const entry = _ratemap.get(ip) || { count: 0, start: now };
  if (now - entry.start > 60000) { entry.count = 0; entry.start = now; }
  entry.count++;
  _ratemap.set(ip, entry);
  return entry.count <= maxPerMin;
}
// Clean old entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 120000;
  for (const [k, v] of _ratemap) if (v.start < cutoff) _ratemap.delete(k);
}, 300000);

// ═══════════════════════════════════════════════════════════════
//  PUPPETEER — Lazy-loaded browser instance
// ═══════════════════════════════════════════════════════════════

let _browser = null;
async function getBrowser() {
  if (_browser) return _browser;
  try {
    const chromium = require('@sparticuz/chromium');
    const puppeteer = require('puppeteer-core');
    _browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    console.log('[CERT] Puppeteer browser launched');
    _browser.on('disconnected', () => { _browser = null; });
    return _browser;
  } catch (e) {
    console.error('[CERT] Puppeteer launch failed:', e.message);
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════
//  EXHIBIT LOG — Silent patent evidence store
// ═══════════════════════════════════════════════════════════════

const EXHIBIT_LOG = path.join(__dirname, 'exhibits.jsonl');
function logExhibit(report, certId) {
  try {
    const exhibit = {
      certId,
      ts: new Date().toISOString(),
      produce: report.produce,
      grade: report.overallGrade,
      confidence: report.confidence,
      gps: report.gps,
      farmerName: report.farmerName,
      refObject: report.ref_object,
      kValue: report.ref_object?.k_value,
      grainSizeMm: report.ref_object?.grain_mm_calibrated || report.size_measurements?.avg_unit_size_mm,
      sizeMeasurements: report.size_measurements,
      parameters: report.parameters,
      livePrices: report._livePrices,
      agmarkSpec: AGMARK_SRV[report.produce] || null,
      deviceMethod: report.ref_object?.method || 'visual',
    };
    fs.appendFileSync(EXHIBIT_LOG, JSON.stringify(exhibit) + '\n');
    console.log('[EXHIBIT] Logged:', certId);
  } catch (e) {
    console.warn('[EXHIBIT] Log failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  CERTIFICATE HTML TEMPLATE
//  Injects live report data into dgport_cert_a4_v3-2 design
// ═══════════════════════════════════════════════════════════════

function buildCertificateHTML(report, certId, imageBase64) {
  const r = report;
  const gc = { A:'#22C55E', B:'#F4A100', C:'#F97316', D:'#E63946' };
  const grade = r.overallGrade || 'B';
  const gradeColor = gc[grade] || '#888';
  const badgeGrad = grade==='A'
    ? 'linear-gradient(135deg,#1b5e20,#22C55E)'
    : grade==='B' ? 'linear-gradient(135deg,#f57f17,#E9C46A)'
    : grade==='C' ? 'linear-gradient(135deg,#e65100,#F97316)'
    : 'linear-gradient(135deg,#b71c1c,#E63946)';

  const farmer   = r.farmerName || 'Farmer';
  const phone    = r.farmerPhone || '';
  const gps      = r.gps?.lat ? `${r.gps.lat}°N ${r.gps.lon}°E`
                 : (typeof r.gps === 'string' ? r.gps : '—');
  const dateStr  = r.date || new Date().toLocaleDateString('en-IN');
  const produce  = r.produce || 'Produce';
  const conf     = r.confidence || 85;
  const grainSz  = r.size_measurements?.avg_unit_size_mm || r.grainSize || '—';
  const shelf    = r.shelfLife || r.shelf || '—';
  const action   = r.bestAction === 'sell_now' ? 'Sell Now'
                 : r.bestAction === 'store_wait' ? 'Store & Wait' : 'Process';
  const aiNote   = r.aiRemark || r.aiNote || 'AI grading complete.';
  const gradeLabel = r.gradeLabel || (grade === 'A' ? 'Premium / Export' : grade === 'B' ? 'Grade A Domestic' : 'Standard');

  // Price ranges
  const lp = r._livePrices;
  const priceLocal    = lp?.domestic || r.marketRate || '—';
  const priceNational = lp?.domestic || r.marketRate || '—';
  const priceExport   = lp?.dubai    || '—';
  const revEst        = r.estimatedRevenue || priceLocal;

  // Grade distribution
  const pct = r.grades ? {
    A: r.grades.A?.pct || 0, B: r.grades.B?.pct || 0,
    C: r.grades.C?.pct || 0, D: r.grades.D?.pct || 0,
  } : { A:15, B:70, C:12, D:3 };

  // Parameters table rows
  const params = r.parameters || [];
  const paramRows = params.slice(0,6).map(p => {
    const sc = p.pass === true
      ? '<span style="display:inline-flex;align-items:center;gap:2px;padding:1px 5px;border-radius:3px;font-size:7px;font-weight:700;background:#e8f5e9;color:#2d6a4f">✓ PASS</span>'
      : p.pass === false
      ? '<span style="display:inline-flex;align-items:center;gap:2px;padding:1px 5px;border-radius:3px;font-size:7px;font-weight:700;background:#ffebee;color:#c62828">✗ FAIL</span>'
      : '<span style="display:inline-flex;align-items:center;gap:2px;padding:1px 5px;border-radius:3px;font-size:7px;font-weight:700;background:#fff8e1;color:#E65100">⚡ BORDER</span>';
    return `<tr>
      <td style="font-weight:600;color:#333;font-size:9px;padding:3px 5px;border-bottom:1px solid #f5f5f5">${p.name||''}</td>
      <td style="padding:3px 5px;border-bottom:1px solid #f5f5f5">${sc}</td>
      <td style="font-size:8.5px;color:#1565C0;padding:3px 5px;border-bottom:1px solid #f5f5f5">${p.standard||''}</td>
      <td style="font-size:8.5px;color:#555;padding:3px 5px;border-bottom:1px solid #f5f5f5">${p.found||''}</td>
    </tr>`;
  }).join('');

  // Market routes table
  const routes = lp ? [
    { m:'📍 Local APMC', p: lp.domestic || priceLocal, s:'AGMARKNET · DMI GoI', best:true },
    { m:'eNAM National',  p: lp.domestic || priceLocal, s:'eNAM · AGMARK Rules', best:false },
    { m:'🇦🇪 UAE/Dubai',  p: lp.dubai    || '—', s:'APEDA · GSO Standards', best:false },
    { m:'🇩🇪 Germany',    p: lp.eu       || '—', s:'EU Reg 543/2011', best:false },
    { m:'🇺🇸 USA',        p: lp.usda     || '—', s:'USDA AMS · Grades', best:false },
  ] : [
    { m:'📍 Local APMC', p: priceLocal, s:'AGMARKNET · DMI GoI', best:true },
    { m:'eNAM National', p: priceNational, s:'eNAM · AGMARK Rules', best:false },
    { m:'🇦🇪 UAE/Dubai', p: priceExport, s:'APEDA · GSO Standards', best:false },
  ];

  const routeRows = routes.map(rt => `<tr${rt.best ? ' class="top"':''}>
    <td style="font-size:9px;font-weight:600;color:${rt.best?'#2d6a4f':'#333'};padding:3.5px 8px;border-bottom:1px solid #f5f5f5">${rt.m}</td>
    <td style="font-size:9.5px;font-weight:700;color:${rt.best?'#2d6a4f':'#1565C0'};text-align:right;padding:3.5px 8px;border-bottom:1px solid #f5f5f5;white-space:nowrap">${rt.p}</td>
    <td style="font-size:8px;color:#888;padding:3.5px 8px;border-bottom:1px solid #f5f5f5">${rt.s}</td>
  </tr>`).join('');

  // Batch distribution bars
  const batchColors = { A:'#22C55E', B:'#F4A100', C:'#F97316', D:'#e53935' };
  const batchLabels = { A:'Premium/Export', B:'Grade A Domestic', C:'Standard Market', D:'Reject/Process' };
  const batchBars = ['A','B','C','D'].map(g => `
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
      <span style="width:12px;font-size:10px;font-weight:800;text-align:center;color:${batchColors[g]}">${g}</span>
      <div style="flex:1;height:8px;background:#f0f0f0;border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${pct[g]}%;background:${batchColors[g]};border-radius:4px"></div>
      </div>
      <span style="width:24px;font-size:9px;font-weight:700;text-align:right;color:${batchColors[g]}">${pct[g]}%</span>
      <span style="font-size:8px;color:#888;width:90px">${batchLabels[g]}</span>
    </div>`).join('');

  // Image panel
  const imgPanel = imageBase64
    ? `<img src="data:image/jpeg;base64,${imageBase64}" style="width:100%;height:148px;object-fit:cover;display:block"/>`
    : `<div style="height:148px;background:linear-gradient(160deg,#3d6b22,#1f4010);display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.4);font-size:11px;font-family:Arial">No image</div>`;

  const hash = certId.replace('DG-','').toLowerCase() + 'a8671ff9fb';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{background:#fff;font-family:'DM Sans',Arial,sans-serif;width:794px}
</style>
</head>
<body>
<div style="width:794px;background:#fff;font-family:'DM Sans',Arial,sans-serif;border:1px solid #cde8d2;overflow:hidden;display:flex;flex-direction:column">

  <!-- STD STRIP -->
  <div style="background:#1a3d20;padding:4px 14px;display:flex;align-items:center;justify-content:space-between">
    <span style="font-size:7px;font-weight:700;letter-spacing:1.5px;color:rgba(255,255,255,.5);text-transform:uppercase">AGMARK · MPEDA · APEDA · NHB · CODEX · BIS · EU Reg 543/2011 · USDA · FAO · eNAM</span>
    <span style="font-size:9px;font-weight:700;color:#E9C46A">AI Grading Certificate</span>
  </div>

  <!-- HEADER -->
  <div style="background:linear-gradient(135deg,#0f2d14,#1e5228,#0f3d1a);padding:11px 16px 9px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px">
    <div>
      <div style="font-size:7px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:rgba(255,255,255,.4);margin-bottom:2px">Powered by</div>
      <div style="font-size:16px;font-weight:700;color:#52B788;font-family:Georgia,serif">DeepGazer<span style="color:#E9C46A">AI</span>™</div>
      <div style="font-size:7px;color:rgba(255,255,255,.3);margin-top:1px">Technology · DeepGazerAI Vision Engine</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:22px;font-weight:800;color:#fff;font-family:Georgia,serif;letter-spacing:-.5px;line-height:1">DG <span style="color:#E9C46A">Certificate</span></div>
      <div style="font-size:7px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,.38);margin-top:4px">AI Grading · FasalEx</div>
      <div style="font-family:'DM Mono',monospace;font-size:10px;color:#E9C46A;margin-top:4px;background:rgba(233,196,106,.1);display:inline-block;padding:2px 8px;border-radius:4px;letter-spacing:1px">${certId}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:7px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:rgba(255,255,255,.4);margin-bottom:2px">Get it at</div>
      <div style="font-size:14px;font-weight:700;color:#fff;font-family:Georgia,serif">www.<span style="color:#52B788">fasal</span>ex.com</div>
      <div style="font-size:7px;color:rgba(255,255,255,.35);margin-top:1px">See True · Trade Fair</div>
    </div>
  </div>
  <div style="height:2.5px;background:linear-gradient(90deg,#2d6a4f,#52B788,#E9C46A,#F4A261,#E9C46A,#52B788,#2d6a4f)"></div>
  <div style="height:1px;background:rgba(82,183,136,.2)"></div>

  <!-- PRODUCE ROW -->
  <div style="background:linear-gradient(135deg,#f0faf3,#e8f5ec);padding:7px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #cde8d2">
    <div>
      <div style="font-size:7px;font-weight:700;letter-spacing:2px;color:#2d6a4f;text-transform:uppercase;margin-bottom:2px">🌾 Agriculture · India</div>
      <div style="font-size:17px;font-weight:700;color:#0f2d14;font-family:Georgia,serif">${produce}</div>
      <div style="font-size:8px;color:#888;margin-top:1px">AGMARK Grade ${grade} — ${gradeLabel}</div>
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <div style="text-align:center"><div style="font-size:7px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#aaa">Confidence</div><div style="font-size:11px;font-weight:700;margin-top:1px;color:#2d6a4f">${conf}%</div></div>
      <div style="text-align:center"><div style="font-size:7px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#aaa">Grain Size</div><div style="font-size:11px;font-weight:700;margin-top:1px;color:#2d6a4f">${grainSz}</div></div>
      <div style="text-align:center"><div style="font-size:7px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#aaa">Shelf Life</div><div style="font-size:11px;font-weight:700;margin-top:1px">${shelf}</div></div>
      <div style="text-align:center"><div style="font-size:7px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#aaa">Action</div><div style="font-size:11px;font-weight:700;margin-top:1px;color:#E65100">${action}</div></div>
      <div style="width:50px;height:50px;border-radius:50%;background:${badgeGrad};display:flex;flex-direction:column;align-items:center;justify-content:center;border:2.5px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,.2)">
        <div style="font-size:22px;font-weight:800;color:#fff;line-height:1;font-family:Georgia,serif">${grade}</div>
        <div style="font-size:7px;font-weight:700;color:rgba(255,255,255,.8)">GRADE</div>
      </div>
    </div>
  </div>

  <!-- ROW 1: Contact | Image -->
  <div style="display:grid;grid-template-columns:1fr 1fr;border-top:1px solid #e8e8e8">
    <div style="border-right:1px solid #eaeaea">
      <div style="font-size:7.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:5px 12px 4px;border-bottom:1.5px solid #2d6a4f;color:#2d6a4f;background:#f8fdf9">👤 Contact Details</div>
      <div style="padding:5px 12px 7px">
        <div style="display:flex;gap:6px;padding:3px 0;border-bottom:1px solid #f5f5f5;font-size:9px"><span style="color:#999;font-weight:600;min-width:55px;font-size:8px;text-transform:uppercase">Farmer</span><span style="color:#1a1a1a;font-weight:600">${farmer}</span></div>
        <div style="display:flex;gap:6px;padding:3px 0;border-bottom:1px solid #f5f5f5;font-size:9px"><span style="color:#999;font-weight:600;min-width:55px;font-size:8px;text-transform:uppercase">Mobile</span><span style="color:#1565C0;font-family:'DM Mono',monospace;font-weight:600">${phone}</span></div>
        <div style="display:flex;gap:6px;padding:3px 0;border-bottom:1px solid #f5f5f5;font-size:9px"><span style="color:#999;font-weight:600;min-width:55px;font-size:8px;text-transform:uppercase">GPS</span><span style="color:#2d6a4f;font-family:'DM Mono',monospace;font-size:8px;font-weight:600">${gps}</span></div>
        <div style="display:flex;gap:6px;padding:3px 0;border-bottom:1px solid #f5f5f5;font-size:9px"><span style="color:#999;font-weight:600;min-width:55px;font-size:8px;text-transform:uppercase">Date</span><span style="color:#1a1a1a;font-weight:600">${dateStr}</span></div>
        <div style="display:flex;gap:6px;padding:3px 0;font-size:9px"><span style="color:#999;font-weight:600;min-width:55px;font-size:8px;text-transform:uppercase">Batch</span><span style="color:#aaa;font-family:'DM Mono',monospace;font-size:8px">${certId}</span></div>
      </div>
    </div>
    <div>
      <div style="font-size:7.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:5px 12px 4px;border-bottom:1.5px solid #1565C0;color:#1565C0;background:#f5f9ff">📷 Scan Image · AI Vision Capture</div>
      <div style="position:relative;height:148px;overflow:hidden">
        ${imgPanel}
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:3"><span style="font-family:Georgia,serif;font-size:8px;font-weight:700;color:rgba(255,255,255,.18);transform:rotate(-30deg);letter-spacing:2px;text-align:center;white-space:nowrap">FasalEx™ · DeepGazerAI™ · ${certId} · INDICATIVE · NOT OFFICIAL</span></div>
        <div style="position:absolute;top:0;left:0;right:0;background:rgba(0,0,0,.55);padding:3px 7px;z-index:4;display:flex;justify-content:space-between"><span style="font-size:7px;font-weight:700;color:rgba(255,255,255,.7);letter-spacing:1px;text-transform:uppercase">AI Scan · DeepGazerAI Vision</span><span style="font-size:7px;color:rgba(255,255,255,.38);font-family:'DM Mono',monospace">${certId}</span></div>
        <div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.8);padding:3px 7px;z-index:4">
          <div style="display:flex;justify-content:space-between"><span style="font-size:7px;color:#52B788;font-family:'DM Mono',monospace">📍 ${gps}</span><span style="font-size:7px;color:#E9C46A;font-family:'DM Mono',monospace">Hash: ${hash.slice(0,16)}...</span></div>
          <div style="font-size:6.5px;color:rgba(255,255,255,.38);font-family:'DM Mono',monospace;margin-top:1px">${phone} · ${dateStr} · FasalEx™ · Patent Pending</div>
        </div>
      </div>
    </div>
  </div>
  <div style="height:1px;background:rgba(82,183,136,.2)"></div>

  <!-- ROW 2: Grading Metrics | Market Intelligence -->
  <div style="display:grid;grid-template-columns:1fr 1fr;border-top:1px solid #e8e8e8">
    <div style="border-right:1px solid #eaeaea">
      <div style="font-size:7.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:5px 12px 4px;border-bottom:1.5px solid #2d6a4f;color:#2d6a4f;background:#f8fdf9">📊 Grading Metrics</div>
      <table style="width:100%;border-collapse:collapse">${paramRows}</table>
    </div>
    <div>
      <div style="font-size:7.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:5px 12px 4px;border-bottom:1.5px solid #1565C0;color:#1565C0;background:#f5f9ff">💰 Market Intelligence</div>
      <table style="width:100%;border-collapse:collapse;font-size:9px">
        <thead><tr style="background:#f0f4ff"><th style="padding:4px 8px;text-align:left;font-size:7.5px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#1565C0;border-bottom:1.5px solid #c5d8f5">Market</th><th style="padding:4px 8px;text-align:right;font-size:7.5px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#1565C0;border-bottom:1.5px solid #c5d8f5">Price (₹/qtl)</th><th style="padding:4px 8px;text-align:left;font-size:7.5px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#1565C0;border-bottom:1.5px solid #c5d8f5">Authority</th></tr></thead>
        <tbody>${routeRows}</tbody>
      </table>
      <div style="margin:4px 12px;background:linear-gradient(135deg,#fff3e0,#fffde7);border:1.5px solid #ffe082;border-radius:6px;padding:5px 10px">
        <div style="font-size:7px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#E65100">Revenue Estimate — Grade ${grade}</div>
        <div style="font-size:14px;font-weight:700;color:#BF360C;margin-top:1px;font-family:Georgia,serif">${revEst}</div>
        <div style="font-size:7.5px;color:#aaa;margin-top:1px">Export opens at ${priceExport} after sorting & AGMARK cert</div>
      </div>
    </div>
  </div>
  <div style="height:1px;background:rgba(82,183,136,.2)"></div>

  <!-- ROW 3: Batch Distribution | Standards -->
  <div style="display:grid;grid-template-columns:1fr 1fr;border-top:1px solid #e8e8e8">
    <div style="border-right:1px solid #eaeaea">
      <div style="font-size:7.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:5px 12px 4px;border-bottom:1.5px solid #2d6a4f;color:#2d6a4f;background:#f8fdf9">📊 Batch Distribution</div>
      <div style="padding:5px 12px 7px">${batchBars}
        <div style="margin-top:5px;padding:4px 8px;background:#f0faf3;border-radius:5px;border:1px solid #cde8d2;font-size:8px;color:#2d6a4f;line-height:1.5">💡 ${r.expertTip || aiNote}</div>
      </div>
    </div>
    <div>
      <div style="font-size:7.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:5px 12px 4px;border-bottom:1.5px solid #E65100;color:#E65100;background:#fff8f5">✅ Standard Check</div>
      <div style="margin:4px 12px;background:linear-gradient(135deg,#1e5228,#2d6a4f);border-radius:6px;padding:5px 10px;display:flex;align-items:center;justify-content:space-between">
        <div><div style="font-size:12px;font-weight:700;color:#fff;font-family:Georgia,serif">${produce}</div><div style="font-size:7px;color:rgba(255,255,255,.5);margin-top:1px">AGMARK · Codex · EU Standards</div></div>
        <div style="background:rgba(233,196,106,.2);border:1.5px solid #E9C46A;border-radius:4px;padding:2px 8px;font-size:14px;font-weight:700;color:#E9C46A;font-family:Georgia,serif">${grade}</div>
      </div>
      <div style="padding:0 12px 5px;font-size:8px;color:#555;line-height:1.7">
        <div>📋 AGMARK: Agricultural Produce (Grading &amp; Marking) Act, 1937</div>
        <div>🌐 Codex: FAO/WHO Codex Alimentarius Commission</div>
        <div>🇪🇺 EU: Commission Regulation (EC) No 543/2011</div>
        <div>🇮🇳 eNAM: National Agriculture Market Platform</div>
        <div style="margin-top:4px;padding:3px 6px;background:#fff8e1;border-radius:4px;color:#E65100;font-size:7.5px">⚠️ AI-generated indicative grade. Lab certification required for export.</div>
      </div>
    </div>
  </div>
  <div style="height:1px;background:rgba(82,183,136,.2)"></div>

  <!-- ROW 4: AI Analysis | Recommendations -->
  <div style="display:grid;grid-template-columns:1fr 1fr;border-top:1px solid #e8e8e8">
    <div style="border-right:1px solid #eaeaea">
      <div style="font-size:7.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:5px 12px 4px;border-bottom:1.5px solid #2d6a4f;color:#2d6a4f;background:#f8fdf9">🤖 AI Analysis — DeepGazerAI™</div>
      <div style="padding:6px 12px 7px">
        <div style="font-size:9px;color:#222;line-height:1.6;margin-bottom:6px">${aiNote}</div>
        ${r.aiRemarkNative ? `<div style="padding:4px 8px;border-radius:5px;font-size:9px;line-height:1.55;background:#f0faf3;border-left:2.5px solid #52B788;color:#1a3d20">${r.aiRemarkNative}</div>` : ''}
        ${r.marketInsight ? `<div style="margin-top:6px;padding:4px 8px;border-radius:5px;font-size:9px;line-height:1.55;background:#f5f9ff;border-left:2.5px solid #1565C0;color:#0d2b5e">${r.marketInsight}</div>` : ''}
      </div>
    </div>
    <div>
      <div style="font-size:7.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:5px 12px 4px;border-bottom:1.5px solid #E65100;color:#E65100;background:#fff8f5">💡 Recommendations</div>
      <div style="padding:6px 12px 7px;font-size:8.5px;color:#444;line-height:1.7">
        ${r.bestAction === 'sell_now' ? '<div>⚡ <strong>Sell Now</strong> — Price window is favourable today.</div>' : ''}
        ${r.bestAction === 'store_wait' ? '<div>🏠 <strong>Store &amp; Wait</strong> — Price expected to rise soon.</div>' : ''}
        <div>💧 <strong>Check moisture</strong> — Ensure ≤12% before storage or sale.</div>
        <div>🔄 <strong>Sort before selling</strong> — Separating Grade A can yield ₹800–1,200/qtl premium.</div>
        <div>🌐 <strong>Export route</strong> — ${priceExport !== '—' ? `UAE: ${priceExport}/qtl via APEDA-registered exporter.` : 'Contact APEDA for export route guidance.'}</div>
        <div>📋 <strong>AGMARK certification</strong> — Register at DMI (dmi.gov.in) for premium mandi access.</div>
      </div>
    </div>
  </div>

  <!-- FOOTER -->
  <div style="background:linear-gradient(135deg,#1a3d20,#243d28);border-top:2.5px solid #52B788;margin-top:auto">
    <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center;padding:7px 16px;border-bottom:1px solid rgba(255,255,255,.07)">
      <div>
        <div style="font-family:'DM Mono',monospace;font-size:13px;font-weight:700;color:#E9C46A;letter-spacing:1px">${certId}</div>
        <div style="font-size:8px;color:rgba(255,255,255,.3);font-family:'DM Mono',monospace;margin-top:2px">Hash: ${hash.slice(0,24)}...</div>
        <div style="margin-top:4px;font-size:8px;color:rgba(255,255,255,.4);font-family:'DM Mono',monospace">${dateStr} · Patent Pending</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:7.5px;color:rgba(255,255,255,.38);margin-bottom:2px">Verify this certificate at</div>
        <div style="font-family:Georgia,serif;font-size:12px;color:#fff;font-weight:600">www.<span style="color:#52B788">fasalex</span>.com/cert/${certId}</div>
      </div>
      <div style="text-align:right">
        <div style="font-family:Georgia,serif;font-size:14px;color:#52B788;font-weight:700">FasalEx™</div>
        <div style="font-size:9px;color:rgba(255,255,255,.4);margin-top:2px">deepgazerai.com</div>
        <div style="font-size:8px;color:rgba(255,255,255,.25);margin-top:2px">© 2026 H DoddanaGouda</div>
      </div>
    </div>
    <div style="padding:5px 16px;border-bottom:1px solid rgba(255,255,255,.06);display:flex;flex-wrap:wrap;gap:4px;align-items:center">
      <span style="font-size:7.5px;font-weight:700;color:rgba(255,255,255,.4);letter-spacing:1px;text-transform:uppercase;margin-right:4px">Data Sources:</span>
      ${['AGMARKNET','eNAM','APEDA','FAO GIEWS','USDA AMS','EU AGRI','World Bank','BIS','NHB','CODEX'].map(s=>`<span style="font-size:7px;font-weight:600;padding:1.5px 5px;border-radius:3px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.45)">${s}</span>`).join('')}
    </div>
    <div style="padding:6px 16px 9px">
      <div style="font-size:7.5px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:rgba(255,255,255,.5);margin-bottom:4px;padding-bottom:3px;border-bottom:1px solid rgba(255,255,255,.07)">⚖️ Legal &amp; Regulatory References</div>
      <div style="font-size:7.5px;color:rgba(255,255,255,.38);line-height:1.75"><strong style="color:rgba(255,255,255,.6)">AGMARK:</strong> Agricultural Produce (Grading &amp; Marking) Act, 1937 — DMI, GoI · <strong style="color:rgba(255,255,255,.6)">MPEDA:</strong> Marine Products Export Development Authority Act, 1972 · <strong style="color:rgba(255,255,255,.6)">APEDA:</strong> Agri &amp; Processed Food Products Export Development Authority Act, 1985 · <strong style="color:rgba(255,255,255,.6)">CODEX:</strong> Codex Alimentarius Commission — FAO/WHO · <strong style="color:rgba(255,255,255,.6)">EU:</strong> Commission Regulation (EC) No 543/2011 · <strong style="color:rgba(255,255,255,.6)">USDA AMS:</strong> Agricultural Marketing Service</div>
      <div style="margin-top:4px;padding:5px 8px;background:rgba(233,196,106,.07);border:1px solid rgba(233,196,106,.18);border-radius:5px;font-size:7.5px;color:rgba(255,220,120,.6);line-height:1.6">⚠️ <strong>DISCLAIMER:</strong> This certificate is AI-generated by DeepGazerAI Vision Engine and is <strong>INDICATIVE ONLY</strong> — NOT official AGMARK, MPEDA, APEDA or equivalent authority certification. Official grade certification requires physical inspection by a government-accredited authority. Market prices are indicative reference values. DeepGazerAI™ · FasalEx™ are under provisional patent protection.</div>
      <div style="margin-top:4px;text-align:center;font-size:7px;color:rgba(255,255,255,.22)">FasalEx™ · DeepGazerAI™ · deepgazerai.com · fasalex.com · Patent Pending · © 2026 H DoddanaGouda, Hospet, Karnataka, India</div>
    </div>
  </div>

</div>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════
//  /api/certificate — Generate PNG + PDF via Puppeteer
// ═══════════════════════════════════════════════════════════════

async function handleCertificate(req, res) {
  try {
    const { report, imageBase64, format } = await parseBody(req);
    if (!report) return sendJSON(res, 400, { error: 'report required' });

    // Generate certId if missing
    const certId = report.certId || (
      'DG-' + Math.random().toString(16).slice(2,6).toUpperCase()
      + '-' + Math.random().toString(16).slice(2,6).toUpperCase()
    );
    report.certId = certId;

    // Silent exhibit log (patent evidence)
    logExhibit(report, certId);

    // Build HTML
    const html = buildCertificateHTML(report, certId, imageBase64 || null);

    // Launch Puppeteer
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForTimeout(500); // let fonts render

    let output;
    if (format === 'pdf') {
      // PDF — farmer download (Page 1 only)
      const pdfBuffer = await page.pdf({
        width: '210mm',
        height: '297mm',
        printBackground: true,
        margin: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      await page.close();
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="DG-Certificate-${certId}.pdf"`,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      res.end(pdfBuffer);
    } else {
      // PNG — WhatsApp share (default)
      const pngBuffer = await page.screenshot({
        type: 'png',
        fullPage: true,
        omitBackground: false,
      });
      await page.close();
      const base64 = pngBuffer.toString('base64');
      sendJSON(res, 200, {
        certId,
        png: base64,
        format: 'png',
        size: pngBuffer.length,
      });
    }

    console.log('[CERT] Generated', format || 'png', 'for', certId, '-', produce);

  } catch (e) {
    console.error('[CERT]', e.message);
    sendJSON(res, 500, { error: 'Certificate generation failed: ' + e.message });
  }
}
