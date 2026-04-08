'use strict';
const express  = require('express');
const path     = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app  = express();
const PORT = process.env.PORT || 3000;
const KEY  = process.env.ANTHROPIC_API_KEY || '';

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ── CORS (allow any origin for local dev) ── */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ── Serve app — injects patched handleScanFile at runtime ── */
const fs2 = require('fs');
app.get('/', (req, res) => {
  try {
    let html = fs2.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const fix = `<script>
/* PATCHED handleScanFile — injected by server */
function handleScanFile(e){
  var file = e.target.files && e.target.files[0];
  if(!file){ return; }
  toast('Loading image...');
  var reader = new FileReader();
  reader.onerror = function(){ toast('Cannot read file','#E74C3C'); };
  reader.onload = function(ev){
    var img = new Image();
    img.onerror = function(){ toast('Cannot decode image','#E74C3C'); };
    img.onload = function(){
      try {
        var MAX = 1024;
        var w = img.width, h = img.height;
        if(w > MAX){ h = Math.round(h*MAX/w); w = MAX; }
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        var dataURL = cv.toDataURL('image/jpeg', 0.85);
        S.scan.imageBase64 = dataURL.split(',')[1];
        S.scan.grainMeasure = null;
        showScanPreview(dataURL);
        try { triggerAIDetectionFromFile(); } catch(ex){ console.warn(ex); }
        toast('Image ready — tap Grade!');
      } catch(err){ toast('Error: '+err.message,'#E74C3C'); }
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  try{ e.target.value=''; }catch(ex){}
}
<\/script>`;
    html = html.replace('</body>', fix + '\n</body>');
    res.send(html);
  } catch(e) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

/* ── Health ── */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, apiKey: !!KEY, version: '2.1.0', ts: new Date().toISOString() });
});

/* ── Market Prices ── */
app.get('/api/market', (req, res) => {
  res.json([
    { name:'Wheat',          sector:'agri',  price:'₹2,450/qtl', chg:'+1.2%', up:true  },
    { name:'Rice / Paddy',   sector:'agri',  price:'₹3,100/qtl', chg:'+0.8%', up:true  },
    { name:'Maize',          sector:'agri',  price:'₹1,920/qtl', chg:'-0.5%', up:false },
    { name:'Tomato',         sector:'agri',  price:'₹1,800/qtl', chg:'+3.1%', up:true  },
    { name:'Onion',          sector:'agri',  price:'₹1,400/qtl', chg:'-2.0%', up:false },
    { name:'Potato',         sector:'agri',  price:'₹1,100/qtl', chg:'+0.4%', up:true  },
    { name:'Soybean',        sector:'agri',  price:'₹4,600/qtl', chg:'+1.5%', up:true  },
    { name:'Green Gram',     sector:'agri',  price:'₹8,200/qtl', chg:'+2.1%', up:true  },
    { name:'Chilli',         sector:'agri',  price:'₹9,500/qtl', chg:'+0.9%', up:true  },
    { name:'Cow Milk',       sector:'dairy', price:'₹38/L',      chg:'+0.5%', up:true  },
    { name:'Buffalo Milk',   sector:'dairy', price:'₹52/L',      chg:'0.0%',  up:true  },
    { name:'Ghee (Buffalo)', sector:'dairy', price:'₹550/kg',    chg:'+1.0%', up:true  },
    { name:'Paneer',         sector:'dairy', price:'₹320/kg',    chg:'-0.8%', up:false },
    { name:'Tiger Prawn',    sector:'fish',  price:'₹650/kg',    chg:'+2.4%', up:true  },
    { name:'Rohu',           sector:'fish',  price:'₹180/kg',    chg:'+0.6%', up:true  },
    { name:'Hilsa',          sector:'fish',  price:'₹900/kg',    chg:'+3.0%', up:true  },
    { name:'Vannamei Shrimp',sector:'fish',  price:'₹420/kg',    chg:'+1.8%', up:true  },
  ]);
});

/* ── Identify Produce ── */
app.post('/api/identify', async (req, res) => {
  if (!KEY) return res.json({ produce:'Unknown', sector:'agri', confidence:0, _demo:true });

  const { imageBase64, sector } = req.body;
  if (!imageBase64) return res.json({ produce:'Unknown', sector:'agri', confidence:0 });

  try {
    const client  = new Anthropic({ apiKey: KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text',  text: `Identify the agricultural produce in this image. Sector hint: ${sector||'agri'}.
Return ONLY valid JSON (no markdown):
{"produce":"<name>","sector":"agri|dairy|fish","confidence":<0-100>,"notes":"<one line>"}` }
        ]
      }]
    });
    const raw  = message.content[0].text.replace(/```json?|```/g,'').trim();
    const data = JSON.parse(raw);
    res.json(data);
  } catch(e) {
    console.error('[identify]', e.message);
    res.json({ produce:'Unknown', sector:'agri', confidence:0, error: e.message });
  }
});

/* ── Analyze / Grade ── */
app.post('/api/analyze', async (req, res) => {
  const { produce, sector, qty, unit, farmerName, language, gps, imageBase64, grainMeasure } = req.body;

  if (!KEY) return res.json(demoReport(req.body));

  try {
    const client = new Anthropic({ apiKey: KEY });

    const grainNote = grainMeasure
      ? `\nCANVAS GRAIN MEASUREMENT: ${JSON.stringify(grainMeasure)}\nUse avgGrainSizeMm from canvas analysis if available.`
      : '';

    const imgBlock = imageBase64
      ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } }]
      : [];

    const prompt = `You are FarEX AI — an expert agricultural produce grader trained on AGMARK, FSSAI, MPEDA, EU, and Codex standards.

Farmer: ${farmerName||'Farmer'}
Produce: ${produce}
Sector: ${sector}
Quantity: ${qty} ${unit}
GPS: ${gps ? gps.lat+'°N '+gps.lon+'°E' : 'India'}
Language: ${language||'English'}
${grainNote}

${imageBase64 ? 'Analyze the image carefully — assess colour, texture, uniformity, damage, foreign matter, moisture signs.' : 'No image provided — use typical characteristics for this produce.'}

Return ONLY valid JSON (no markdown, no explanation outside JSON):
{
  "produce": "${produce}",
  "localName": "<local aliases e.g. हरा चना / Green Gram / Moong>",
  "sector": "${sector}",
  "qty": "${qty} ${unit}",
  "farmerName": "${farmerName||'Farmer'}",
  "gps": ${JSON.stringify(gps||{lat:'21.1458',lon:'79.0882'})},
  "date": "${new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}",
  "overallGrade": "A|B|C|D",
  "gradeLabel": "Premium|Good|Fair|Poor",
  "confidence": <60-97>,
  "shelfLife": "<e.g. 12–15 days>",
  "estimatedRevenue": "<e.g. ₹18,000–22,000>",
  "marketRate": "<e.g. ₹1,800–2,200/qtl>",
  "bestAction": "sell_now|store_wait|process_add_value|partial_sell",
  "expertTip": "<one practical sentence>",
  "avgGrainSizeMm": <number or null>,
  "grainSizeGrade": "<Grade 1 Bold|Grade 1|Grade 2|Grade 3 or null>",
  "grainSizeAGMARK": "<e.g. 4.8mm — Grade 1 Bold (AGMARK) or null>",
  "coinDetected": false,
  "grades": {
    "A": { "label":"Premium Export", "pct":<0-100>, "priceRange":"<e.g. ₹2,200+/qtl>" },
    "B": { "label":"Domestic Grade 1","pct":<0-100>, "priceRange":"<e.g. ₹1,800–2,200/qtl>" },
    "C": { "label":"Processing Grade", "pct":<0-100>, "priceRange":"<e.g. ₹1,200–1,800/qtl>" },
    "D": { "label":"Reject / Waste",   "pct":<0-100>, "priceRange":"<e.g. Below ₹1,200/qtl>" }
  },
  "parameters": [
    { "name":"Moisture Content",  "standard":"<AGMARK limit>","found":"<estimated %>", "pass":<true|false> },
    { "name":"Foreign Matter",    "standard":"<limit>",        "found":"<estimated %>", "pass":<true|false> },
    { "name":"Damaged Kernels",   "standard":"<limit>",        "found":"<estimated %>", "pass":<true|false> },
    { "name":"Colour Uniformity", "standard":"Uniform",        "found":"<assessment>",  "pass":<true|false> },
    { "name":"Grain Size",        "standard":"<AGMARK spec>",  "found":"<estimated mm>","pass":<true|false> }
  ],
  "buyers": [
    { "name":"<name>", "role":"Trader|Exporter|Processor|APMC", "dist":"<X km>", "phone":"+91 XXXXX XXXXX", "offer":"<₹/unit>", "rating":"4.2", "verified":true },
    { "name":"<name>", "role":"Trader|Exporter|Processor|APMC", "dist":"<X km>", "phone":"+91 XXXXX XXXXX", "offer":"<₹/unit>", "rating":"4.0", "verified":true },
    { "name":"<name>", "role":"Trader|Exporter|Processor|APMC", "dist":"<X km>", "phone":"+91 XXXXX XXXXX", "offer":"<₹/unit>", "rating":"3.8", "verified":false }
  ],
  "aiRemark": "<2–3 sentences: quality assessment, what was observed, recommendation>",
  "aiRemarkLocal": "<same in ${language||'English'} if not English, else empty string>",
  "marketInsight": "<one sentence market trend>",
  "exportCerts": ["<cert1>","<cert2>"]
}

RULES:
- grades A+B+C+D pct must sum to exactly 100
- If image provided, base grade percentages on actual visual quality
- buyers must have realistic Indian names and phone numbers for region near GPS coords
- exportCerts: relevant certifications (APEDA, FSSAI, EIC, MPEDA, etc.)`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [...imgBlock, { type:'text', text: prompt }]
      }]
    });

    const raw    = message.content[0].text.replace(/```json?|```/g,'').trim();
    const report = JSON.parse(raw);
    res.json(report);

  } catch(e) {
    console.error('[analyze]', e.message);
    // Fall back to demo so app never crashes
    const demo = demoReport(req.body);
    demo._error = e.message;
    res.json(demo);
  }
});

/* ── Demo Report (no API key / error fallback) ── */
function demoReport({ produce='Wheat', sector='agri', qty='10', unit='qtl', farmerName='Farmer', gps }) {
  const g = gps || { lat:'21.1458', lon:'79.0882' };
  return {
    produce, localName: produce, sector, qty:`${qty} ${unit}`, farmerName,
    gps: g,
    date: new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}),
    overallGrade:'B', gradeLabel:'Good', confidence:72,
    shelfLife:'10–14 days',
    estimatedRevenue:'₹20,000–24,000',
    marketRate:'₹2,000–2,400/qtl',
    bestAction:'sell_now',
    expertTip:'Clean and bag in moisture-proof sacks before transport.',
    avgGrainSizeMm:null, grainSizeGrade:null, grainSizeAGMARK:null, coinDetected:false,
    grades:{
      A:{ label:'Premium Export',  pct:20, priceRange:'₹2,400+/qtl'        },
      B:{ label:'Domestic Grade 1',pct:50, priceRange:'₹2,000–2,400/qtl'   },
      C:{ label:'Processing Grade',pct:22, priceRange:'₹1,400–2,000/qtl'   },
      D:{ label:'Reject / Waste',  pct:8,  priceRange:'Below ₹1,400/qtl'   },
    },
    parameters:[
      { name:'Moisture Content', standard:'Max 14%',     found:'13.2%', pass:true  },
      { name:'Foreign Matter',   standard:'Max 1%',      found:'0.8%',  pass:true  },
      { name:'Damaged Kernels',  standard:'Max 6%',      found:'5.1%',  pass:true  },
      { name:'Colour Uniformity',standard:'Uniform',     found:'Mostly uniform', pass:true  },
      { name:'Grain Size',       standard:'Bold >7mm',   found:'~6.8mm',pass:false },
    ],
    buyers:[
      { name:'Ramesh Agro Traders', role:'Trader',   dist:'4 km',  phone:'+91 98765 43210', offer:'₹2,350/qtl', rating:'4.5', verified:true  },
      { name:'Nagpur Grain Depot',  role:'APMC',     dist:'9 km',  phone:'+91 91234 56789', offer:'₹2,280/qtl', rating:'4.2', verified:true  },
      { name:'Shree Export House',  role:'Exporter', dist:'22 km', phone:'+91 87654 32109', offer:'₹2,400/qtl', rating:'3.9', verified:false },
    ],
    aiRemark:'Produce is in good condition with moderate uniformity. Minor foreign matter detected within acceptable limits. Recommend prompt sale to capture current market prices.',
    aiRemarkLocal:'',
    marketInsight:'Wheat prices trending up 1.2% this week — good time to sell Grade A stock.',
    exportCerts:['APEDA','FSSAI','AGMARK'],
    _demo: true,
  };
}

app.listen(PORT, () => {
  console.log(`\n✅ FarEX Server running on http://localhost:${PORT}`);
  console.log(`   API Key: ${KEY ? '✓ Set (' + KEY.slice(0,8) + '...)' : '✗ Missing — running in DEMO mode'}`);
  console.log(`   Place your index.html in the /public folder\n`);
});
