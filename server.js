const express = require('express');
const path = require('path');
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

// ── Serve index.html ──────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Health check ──────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, apiKey: !!ANTHROPIC_API_KEY, version: 'FasalEx 2.0' });
});

// ── IDENTIFY — AI produce identification from image ───
app.post('/api/identify', async (req, res) => {
  const { imageBase64 } = req.body;
  if (!imageBase64) {
    return res.json({ produce: 'Unknown', sector: 'agri', confidence: 0, emoji: '❓', note: 'No image provided' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.json(demoIdentify());
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 }
            },
            {
              type: 'text',
              text: `You are an agricultural produce identification AI. Look at this image carefully and identify the agricultural produce shown.

Respond ONLY with valid JSON in this exact format:
{
  "produce": "exact produce name (e.g. Wheat, Tomato, Green Gram, Potato)",
  "sector": "one of: agri, horti, flori, api, ah, med, fish",
  "confidence": 85,
  "emoji": "single emoji representing this produce",
  "note": "one short sentence about what you see in the image"
}

Sector mapping:
- agri: grains, cereals, pulses, oilseeds, cotton, sugarcane
- horti: fruits, vegetables
- flori: flowers, ornamental plants
- api: honey, bee products
- ah: dairy, meat, eggs (animal husbandry)
- med: medicinal herbs, spices
- fish: fish, seafood, aquaculture

Be specific about what you actually see in the image. If the image is unclear, use your best judgment.`
            }
          ]
        }]
      })
    });
    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);
    res.json(result);
  } catch (e) {
    console.error('Identify error:', e);
    res.json(demoIdentify());
  }
});

function demoIdentify() {
  return { produce: 'Wheat', sector: 'agri', confidence: 72, emoji: '🌾', note: 'Demo mode — API key not configured' };
}

// ── ANALYZE — Full AI grading ─────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { produce, sector, qty, unit, notes, language, farmerName, farmerState, farmerDistrict, gps, imageBase64 } = req.body;

  if (!ANTHROPIC_API_KEY) {
    return res.json(buildDemoReport({ produce, sector, qty, unit, farmerName, gps, language }));
  }

  try {
    // Build the message content
    const messageContent = [];

    // Add image if available
    if (imageBase64) {
      messageContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 }
      });
    }

    // Build sector-specific grading prompt
    const sectorStandards = {
      agri: 'AGMARK Grain/Pulse Grading Rules, FCI Standards, FSS Regulations 2011',
      horti: 'AGMARK Fruit & Vegetable Grading Rules, APEDA standards, EU Reg 543/2011',
      flori: 'National Horticulture Board standards, APEDA Floriculture guidelines',
      api: 'FSSAI Honey Standards, BIS IS:4941, Codex Stan 12-1981',
      ah: 'FSSAI Dairy Standards, BIS IS:1479, Codex Stan 206-1999, PFA Act',
      med: 'AYUSH standards, FSSAI regulations for herbs and spices',
      fish: 'MPEDA export standards, EIC guidelines, HACCP, EU Reg 854/2004'
    };

    const localLang = {
      hi: 'Hindi', kn: 'Kannada', te: 'Telugu', ta: 'Tamil', mr: 'Marathi', en: 'English'
    }[language] || 'English';

    const prompt = `You are DeepGazerAI, an expert agricultural grading AI for Indian markets. You are analyzing ${produce} for a farmer named ${farmerName || 'Farmer'} from ${[farmerDistrict, farmerState].filter(Boolean).join(', ') || 'India'}.

${imageBase64 ? `CRITICAL: You have been provided with an actual photograph of this ${produce}. Analyze the VISUAL qualities you can observe in this specific image — color, texture, uniformity, visible defects, size, moisture signs, etc. Your grade must reflect what you actually see.` : `No image provided. Use general knowledge about ${produce} quality for this analysis.`}

Produce: ${produce}
Sector: ${sector}
Quantity: ${qty} ${unit}
Applicable Standards: ${sectorStandards[sector] || sectorStandards.agri}
${notes ? `Farmer notes: ${notes}` : ''}
${gps?.lat ? `GPS Location: ${gps.lat}°N ${gps.lon}°E` : ''}

Based on your visual analysis${imageBase64 ? ' of the image' : ''}, provide a complete grading report.

Respond ONLY with valid JSON:
{
  "produce": "${produce}",
  "sector": "${sector}",
  "overallGrade": "A or B or C or D",
  "gradeLabel": "e.g. Premium Quality / Good Quality / Fair Average Quality / Below Standard",
  "confidence": 85,
  "shelfLife": "e.g. 7-10 days or 60-90 days",
  "estimatedRevenue": "e.g. ₹2,000-2,400 per quintal",
  "bestAction": "one of: sell_now / store_wait / process_add_value / partial_sell",
  "grades": {
    "A": {"label": "Premium", "pct": 20, "priceRange": "₹2,400-2,600/qtl"},
    "B": {"label": "Good", "pct": 60, "priceRange": "₹2,000-2,400/qtl"},
    "C": {"label": "Fair", "pct": 15, "priceRange": "₹1,600-2,000/qtl"},
    "D": {"label": "Reject", "pct": 5, "priceRange": "Below ₹1,600/qtl"}
  },
  "aiRemark": "2-3 sentences describing what you see. Be specific about the actual quality observed — color, defects, size uniformity, moisture, etc.",
  "aiRemarkLocal": "Same remark in ${localLang} language if not English, else empty string",
  "marketInsight": "One sentence about current market conditions for this produce",
  "expertTip": "One practical tip to improve grade or get better price",
  "parameters": [
    {"name": "Parameter name", "standard": "AGMARK spec", "found": "What you measured/observed", "pass": true}
  ],
  "marketPrices": [
    {"market": "Nearby mandi name", "price": "₹X,XXX/qtl"},
    {"market": "Another mandi", "price": "₹X,XXX/qtl"},
    {"market": "State capital mandi", "price": "₹X,XXX/qtl"}
  ],
  "buyers": [
    {"name": "Buyer name", "role": "APMC Trader", "dist": "5 km", "phone": "+91 98765 43210", "rating": "4.5", "offer": "₹X,XXX/qtl", "verified": true},
    {"name": "Buyer 2", "role": "Wholesale", "dist": "12 km", "phone": "+91 87654 32109", "rating": "4.2", "offer": "₹X,XXX/qtl", "verified": true},
    {"name": "Exporter", "role": "Exporter", "dist": "25 km", "phone": "+91 76543 21098", "rating": "4.0", "offer": "₹X,XXX/qtl", "verified": false}
  ]
}

Make ALL numbers and prices realistic for current Indian markets (2026). Parameters array should have 4-6 relevant quality checks for ${produce} per ${sectorStandards[sector] || 'AGMARK'} standards.`;

    messageContent.push({ type: 'text', text: prompt });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1500,
        messages: [{ role: 'user', content: messageContent }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();

    let report;
    try {
      report = JSON.parse(clean);
    } catch (parseErr) {
      // Try to extract JSON from response
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        report = JSON.parse(match[0]);
      } else {
        throw new Error('Failed to parse AI response');
      }
    }

    // Add metadata
    report.farmerName = farmerName || 'Farmer';
    report.qty = `${qty} ${unit}`;
    report.date = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    report.gps = gps;

    res.json(report);

  } catch (e) {
    console.error('Analyze error:', e);
    res.json(buildDemoReport({ produce, sector, qty, unit, farmerName, gps, language }));
  }
});

// ── MARKET PRICES ─────────────────────────────────────
app.get('/api/market-prices', async (req, res) => {
  const { produce, sector } = req.query;
  // Try data.gov.in AGMARKNET API
  const apiKey = process.env.AGMARKNET_API_KEY;
  if (apiKey && produce) {
    try {
      const url = `https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070?api-key=${apiKey}&format=json&filters[commodity]=${encodeURIComponent(produce)}&limit=5`;
      const r = await fetch(url);
      const d = await r.json();
      if (d.records?.length) {
        const prices = d.records.map(rec => ({
          market: rec.market || rec.district,
          price: `₹${parseInt(rec.modal_price).toLocaleString('en-IN')}/qtl`,
          change: Math.round(Math.random() * 200 - 100),
          up: Math.random() > 0.4
        }));
        return res.json({ prices, source: 'AGMARKNET Live' });
      }
    } catch (e) { /* fall through to AI estimates */ }
  }
  // Return AI-estimated prices
  res.json({ prices: [], source: 'unavailable', hint: 'Get free API key at data.gov.in' });
});

// ── MARKET DATA (reference prices) ───────────────────
app.get('/api/market', (req, res) => {
  res.json([
    { name: 'Wheat', sector: 'agri', price: '₹2,280/qtl', chg: '₹45', up: true },
    { name: 'Rice (Paddy)', sector: 'agri', price: '₹2,183/qtl', chg: '₹32', up: true },
    { name: 'Maize', sector: 'agri', price: '₹2,090/qtl', chg: '₹18', up: false },
    { name: 'Soybean', sector: 'agri', price: '₹4,520/qtl', chg: '₹65', up: true },
    { name: 'Chickpea', sector: 'agri', price: '₹5,440/qtl', chg: '₹120', up: true },
    { name: 'Toor Dal', sector: 'agri', price: '₹7,200/qtl', chg: '₹90', up: false },
    { name: 'Green Gram', sector: 'agri', price: '₹7,800/qtl', chg: '₹150', up: true },
    { name: 'Groundnut', sector: 'agri', price: '₹6,100/qtl', chg: '₹85', up: true },
    { name: 'Tomato', sector: 'horti', price: '₹1,820/qtl', chg: '₹58', up: true },
    { name: 'Onion', sector: 'horti', price: '₹1,850/qtl', chg: '₹35', up: false },
    { name: 'Potato', sector: 'horti', price: '₹1,450/qtl', chg: '₹20', up: true },
    { name: 'Banana', sector: 'horti', price: '₹1,200/qtl', chg: '₹15', up: true },
    { name: 'Mango', sector: 'horti', price: '₹4,500/qtl', chg: '₹200', up: true },
    { name: 'Milk', sector: 'ah', price: '₹38/litre', chg: '₹1', up: true },
    { name: 'Eggs', sector: 'ah', price: '₹6.2/piece', chg: '₹0.2', up: false },
    { name: 'Honey', sector: 'api', price: '₹280/kg', chg: '₹8', up: true },
    { name: 'Pomfret', sector: 'fish', price: '₹380/kg', chg: '₹12', up: true },
    { name: 'Prawn', sector: 'fish', price: '₹620/kg', chg: '₹25', up: true },
    { name: 'Turmeric', sector: 'med', price: '₹8,200/qtl', chg: '₹180', up: false },
    { name: 'Ginger', sector: 'med', price: '₹3,400/qtl', chg: '₹95', up: true },
  ]);
});

// ── DEMO REPORT ───────────────────────────────────────
function buildDemoReport({ produce, sector, qty, unit, farmerName, gps, language }) {
  const s = sector || 'agri';
  const priceMap = {
    agri: { est: '₹2,000-2,400/qtl', A: '₹2,400-2,600/qtl', B: '₹2,000-2,400/qtl', C: '₹1,600-2,000/qtl', D: 'Below ₹1,600/qtl' },
    horti: { est: '₹1,500-2,000/qtl', A: '₹2,000-2,500/qtl', B: '₹1,500-2,000/qtl', C: '₹1,000-1,500/qtl', D: 'Below ₹1,000/qtl' },
    fish: { est: '₹350-500/kg', A: '₹500-650/kg', B: '₹350-500/kg', C: '₹200-350/kg', D: 'Below ₹200/kg' },
    ah: { est: '₹35-45/litre', A: '₹45-55/litre', B: '₹35-45/litre', C: '₹25-35/litre', D: 'Below ₹25/litre' },
    api: { est: '₹250-320/kg', A: '₹320-400/kg', B: '₹250-320/kg', C: '₹180-250/kg', D: 'Below ₹180/kg' },
    med: { est: '₹180-250/kg', A: '₹250-320/kg', B: '₹180-250/kg', C: '₹120-180/kg', D: 'Below ₹120/kg' },
    flori: { est: '₹40-80/bunch', A: '₹80-120/bunch', B: '₹40-80/bunch', C: '₹20-40/bunch', D: 'Below ₹20/bunch' },
  };
  const p = priceMap[s] || priceMap.agri;
  return {
    _demo: true,
    produce: produce || 'Unknown Produce',
    sector: s,
    overallGrade: 'B',
    gradeLabel: 'Good quality with minor defects',
    confidence: 72,
    shelfLife: '7-10 days',
    estimatedRevenue: p.est,
    bestAction: 'sell_now',
    grades: {
      A: { label: 'Premium', pct: 20, priceRange: p.A },
      B: { label: 'Good', pct: 65, priceRange: p.B },
      C: { label: 'Fair', pct: 12, priceRange: p.C },
      D: { label: 'Reject', pct: 3, priceRange: p.D }
    },
    aiRemark: `This is a demo report for ${produce || 'your produce'}. To get AI-powered visual analysis, please add your Anthropic API key to the Railway environment variables.`,
    aiRemarkLocal: '',
    marketInsight: 'Market prices are stable. Good demand from local traders.',
    expertTip: 'Store in cool, dry conditions to maintain quality and shelf life.',
    parameters: [
      { name: 'Visual Quality', standard: 'Grade B spec', found: 'Good with minor defects', pass: true },
      { name: 'Size Uniformity', standard: 'Uniform', found: 'Mostly uniform', pass: true },
      { name: 'Colour', standard: 'Characteristic', found: 'Good colour', pass: true },
      { name: 'Foreign Matter', standard: '< 1%', found: '< 1%', pass: true },
    ],
    marketPrices: [
      { market: 'Hospet Mandi', price: '₹2,200/qtl' },
      { market: 'Bellary Mandi', price: '₹2,180/qtl' },
      { market: 'Hubli Mandi', price: '₹2,240/qtl' },
    ],
    buyers: [
      { name: 'Local Trader Co.', role: 'APMC Trader', dist: '5 km', phone: '+91 98765 43210', rating: '4.5', offer: '₹2,200/qtl', verified: true },
      { name: 'District Wholesale', role: 'Wholesale', dist: '12 km', phone: '+91 87654 32109', rating: '4.2', offer: '₹2,180/qtl', verified: true },
      { name: 'State Exporter', role: 'Exporter', dist: '25 km', phone: '+91 76543 21098', rating: '4.0', offer: '₹2,150/qtl', verified: false },
    ],
    farmerName: farmerName || 'Farmer',
    qty: `${qty || '?'} ${unit || 'kg'}`,
    date: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    gps: gps || null,
  };
}

app.listen(PORT, () => console.log(`FasalEx 2.0 running on port ${PORT}`));
