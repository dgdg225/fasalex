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
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('Claude API timeout')); });
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
    req.on('data', chunk => { body += chunk; if (body.length > 10e6) req.destroy(); });
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
    'Access-Control-Allow-Origin': '*',
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
Evaluate each visible parameter against these thresholds.
For each parameter state: measured value, spec threshold, PASS/FAIL/BORDERLINE.
Also provide size_measurements with avg_unit_size_mm measured from image.`
      : `Use your knowledge of AGMARK grading standards for ${produce}.`;

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

Analyse the image carefully if provided. Generate a precise grading report.
IMPORTANT — Size measurement: Estimate the real-world size of individual units in mm from the image.
If a reference object is visible (SIM card, ruler, battery, ID card), use it for precise calibration.
Otherwise provide visual estimate. Always populate size_measurements field.
Respond ONLY with valid JSON (no markdown):
{
  "produce": "${produce}",
  "sector": "${sector}",
  "qty": "${qty} ${unit}",
  "unit": "${unit}",
  "farmerName": "${farmerName || 'Farmer'}",
  "overallGrade": "A|B|C|D",
  "gradeLabel": "Grade description",
  "confidence": 85,
  "shelfLife": "X–Y days/months",
  "estimatedRevenue": "₹X,XXX–Y,YYY",
  "marketRate": "₹X,XXX/qtl APMC",
  "bestAction": "sell_now|store_wait|partial_sell",
  "expertTip": "Actionable tip for the farmer",
  "aiRemark": "2-3 sentence quality analysis",
  "aiRemarkNative": "2-3 sentences in ${language || 'English'} for the farmer",
  "marketInsight": "1 sentence on current market conditions",
  "grades": {
    "A": {"label": "Premium", "pct": 20, "priceRange": "₹X–Y"},
    "B": {"label": "Good",    "pct": 65, "priceRange": "₹X–Y"},
    "C": {"label": "Fair",    "pct": 12, "priceRange": "₹X–Y"},
    "D": {"label": "Below",   "pct": 3,  "priceRange": "Processing"}
  },
  "size_measurements": {
    "method": "visual_estimate",
    "avg_unit_size_mm": "e.g. 4.5mm",
    "size_range_mm": "e.g. 4.0-5.2mm",
    "size_uniformity_pct": 75,
    "agmark_size_spec": "e.g. >4.0mm for Grade 1",
    "size_grade_result": "PASS|BORDERLINE|FAIL",
    "note": "DeepGazerAI spatial measurement — add reference object for ±0.3mm accuracy"
  },
  "parameters": [
    {"name": "Visual Appearance", "standard": "AGMARK spec", "found": "Good", "pass": true},
    {"name": "Moisture Content",  "standard": "≤12%",        "found": "11%",  "pass": true},
    {"name": "Size / Weight",     "standard": "Bold, uniform","found": "Meets spec", "pass": true},
    {"name": "Foreign Matter",    "standard": "NIL",          "found": "None", "pass": true},
    {"name": "Damage / Defects",  "standard": "<2%",          "found": "1.2%", "pass": true}
  ],
  "buyers": [
    {"name": "Local Trader",    "role": "Wholesaler",  "dist": "8 km",  "phone": "+91 98765 43210", "offer": "₹X,XXX/qtl", "rating": "4.7", "verified": true},
    {"name": "Regional Buyer",  "role": "APMC Agent",  "dist": "22 km", "phone": "+91 87654 32109", "offer": "₹X,XXX/qtl", "rating": "4.5", "verified": true},
    {"name": "Export Partner",  "role": "Exporter",    "dist": "45 km", "phone": "+91 76543 21098", "offer": "₹X,XXX/qtl", "rating": "4.8", "verified": true}
  ],
  "exportCerts": ["AGMARK", "FSSAI"],
  "gps": {"lat": "${gps?.lat || '21.1458'}", "lon": "${gps?.lon || '79.0882'}"},
  "date": "${new Date().toLocaleDateString('en-IN')}"
}`
        }
      ],
    }], 2000);

    const text = result.content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON in response');

    const report = JSON.parse(m[0]);

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
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const { pathname } = url.parse(req.url);

  try {
    if (pathname === '/api/prices'          && req.method === 'GET')  return await handlePrices(req, res);
    if (pathname === '/api/health'          && req.method === 'GET')  return handleHealth(req, res);
    if (pathname === '/api/identify'        && req.method === 'POST') return await handleIdentify(req, res);
    if (pathname === '/api/analyze'         && req.method === 'POST') return await handleAnalyze(req, res);
    if (pathname === '/api/refresh-prices'  && req.method === 'GET')  return await handleRefreshPrices(req, res);
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
