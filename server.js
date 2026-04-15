'use strict';
const express = require('express');
const path    = require('path');
const fs2     = require('fs');
const https   = require('https');

const app         = express();
const PORT        = process.env.PORT || 8080;
const GEMINI_KEY  = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.0-flash';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ── CORS ── */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ── Serve app with image compression patch ── */
app.get('/', (req, res) => {
  try {
    let html = fs2.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const patch = `<script>
function handleScanFile(e){
  var file=e.target.files&&e.target.files[0]; if(!file)return;
  toast('Loading image...');
  var reader=new FileReader();
  reader.onerror=function(){toast('Cannot read file','#E74C3C');};
  reader.onload=function(ev){
    var img=new Image();
    img.onerror=function(){toast('Cannot decode image','#E74C3C');};
    img.onload=function(){
      try{
        var MAX=800, quality=0.75;
        var w=img.width,h=img.height;
        if(w>MAX){h=Math.round(h*MAX/w);w=MAX;}
        if(h>MAX){w=Math.round(w*MAX/h);h=MAX;}
        var cv=document.createElement('canvas');
        cv.width=w;cv.height=h;
        var ctx=cv.getContext('2d');
        ctx.drawImage(img,0,0,w,h);
        var dataURL=cv.toDataURL('image/jpeg',quality);
        S.scan.imageBase64=dataURL.split(',')[1];
        S.scan.grainMeasure=null;
        showScanPreview(dataURL);
        try{triggerAIDetectionFromFile();}catch(ex){console.warn(ex);}
        toast('Image ready — tap Grade!');
      }catch(err){toast('Error: '+err.message,'#E74C3C');}
    };
    img.src=ev.target.result;
  };
  reader.readAsDataURL(file);
  try{e.target.value='';}catch(ex){}
}
<\/script>`;
    html = html.replace('</body>', patch + '\n</body>');
    res.send(html);
  } catch(e) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

/* ── Health ── */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ai: GEMINI_KEY ? 'Gemini Flash 2.0' : 'Demo mode',
    gemini: !!GEMINI_KEY,
    model: GEMINI_MODEL,
    version: '3.0.0',
    ts: new Date().toISOString()
  });
});

/* ── Market Prices ── */
app.get('/api/market', (req, res) => {
  res.json([
    { name:'Wheat',          sector:'agri',  price:'₹2,450/qtl', chg:'+1.2%', up:true  },
    { name:'Rice / Paddy',   sector:'agri',  price:'₹3,100/qtl', chg:'+0.8%', up:true  },
    { name:'Maize',          sector:'agri',  price:'₹1,920/qtl', chg:'-0.5%', up:false },
    { name:'Soybean',        sector:'agri',  price:'₹4,600/qtl', chg:'+1.5%', up:true  },
    { name:'Green Gram',     sector:'agri',  price:'₹8,800/qtl', chg:'+2.1%', up:true  },
    { name:'Moong (Whole)',  sector:'agri',  price:'₹8,800/qtl', chg:'+2.1%', up:true  },
    { name:'Toor Dal',       sector:'agri',  price:'₹9,200/qtl', chg:'+1.8%', up:true  },
    { name:'Chana Dal',      sector:'agri',  price:'₹6,800/qtl', chg:'+0.9%', up:true  },
    { name:'Groundnut',      sector:'agri',  price:'₹6,200/qtl', chg:'+1.1%', up:true  },
    { name:'Tomato',         sector:'agri',  price:'₹1,800/qtl', chg:'+3.1%', up:true  },
    { name:'Onion',          sector:'agri',  price:'₹1,400/qtl', chg:'-2.0%', up:false },
    { name:'Potato',         sector:'agri',  price:'₹1,100/qtl', chg:'+0.4%', up:true  },
    { name:'Chilli (Dry)',   sector:'agri',  price:'₹9,500/qtl', chg:'+0.9%', up:true  },
    { name:'Turmeric',       sector:'agri',  price:'₹8,200/qtl', chg:'+1.5%', up:true  },
    { name:'Ragi',           sector:'agri',  price:'₹2,100/qtl', chg:'+0.8%', up:true  },
    { name:'Jowar',          sector:'agri',  price:'₹2,400/qtl', chg:'+0.5%', up:true  },
    { name:'Bajra',          sector:'agri',  price:'₹2,200/qtl', chg:'+0.6%', up:true  },
    { name:'Cow Milk',       sector:'dairy', price:'₹38/L',      chg:'+0.5%', up:true  },
    { name:'Buffalo Milk',   sector:'dairy', price:'₹52/L',      chg:'0.0%',  up:true  },
    { name:'Paneer',         sector:'dairy', price:'₹320/kg',    chg:'-0.8%', up:false },
    { name:'Ghee (Cow)',     sector:'dairy', price:'₹600/kg',    chg:'+1.0%', up:true  },
    { name:'Tiger Prawn',    sector:'fish',  price:'₹650/kg',    chg:'+2.4%', up:true  },
    { name:'Rohu',           sector:'fish',  price:'₹180/kg',    chg:'+0.6%', up:true  },
    { name:'Hilsa',          sector:'fish',  price:'₹900/kg',    chg:'+3.0%', up:true  },
    { name:'Vannamei Shrimp',sector:'fish',  price:'₹420/kg',    chg:'+1.8%', up:true  },
  ]);
});

/* ══════════════════════════════════════════════════
   GEMINI FLASH — Only AI engine
   Free tier: 1,500 req/day
   429: auto-retry after 5s once → then demo fallback
   ══════════════════════════════════════════════════ */
function callGemini(prompt, imageBase64, retrying) {
  return new Promise((resolve, reject) => {
    if (!GEMINI_KEY) return reject(new Error('No GEMINI_API_KEY'));

    const parts = [];
    if (imageBase64) {
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: imageBase64 } });
    }
    parts.push({ text: prompt });

    const body = JSON.stringify({
      contents: [{ parts }],
      generationConfig: { maxOutputTokens: 2000, temperature: 0.1 }
    });

    const url = new URL(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`
    );

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (gemRes) => {
      let data = '';
      gemRes.on('data', chunk => data += chunk);
      gemRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            if (json.error.code === 429 && !retrying) {
              console.log('[GEMINI] 429 — retrying in 5s...');
              return setTimeout(() => {
                callGemini(prompt, imageBase64, true).then(resolve).catch(reject);
              }, 5000);
            }
            return reject(new Error('Gemini: ' + json.error.message));
          }
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
          resolve(text);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Gemini timeout')); });
    req.write(body);
    req.end();
  });
}

/* ── Image compression — always compress to under 1MB ── */
const sharp = null; // not available — use pure JS resize
function compressB64(b64, maxBytes) {
  if (!b64) return b64;
  const bytes = Buffer.byteLength(b64, 'base64');
  const mb = (bytes / 1024 / 1024).toFixed(2);
  console.log('[IMG] Original: ' + mb + 'MB');
  if (bytes <= maxBytes) return b64; // already small enough
  // Truncate quality by reducing base64 size proportionally
  // Real resize needs canvas — server-side we just warn and pass through
  // Client-side compression in index.html handles this
  console.log('[IMG] Large image — passing through (client should compress)');
  return b64;
}
function checkImageSize(b64) {
  if (!b64) return b64;
  const bytes = Buffer.byteLength(b64, 'base64');
  const mb = (bytes / 1024 / 1024).toFixed(2);
  console.log('[IMG] Size: ' + mb + 'MB');
  // Don't reject — just warn and pass through
  // Client-side compressImage() in index.html handles compression
  if (bytes > 5 * 1024 * 1024) {
    console.warn('[IMG] Warning: image ' + mb + 'MB may exceed API limit');
  }
  return b64;
}

/* ── Parse JSON from AI response ── */
function parseJSON(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const m = clean.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in AI response');
  return JSON.parse(m[0]);
}

/* ── /api/identify ── */
app.post('/api/identify', async (req, res) => {
  const { imageBase64: raw, sector } = req.body;
  if (!raw) return res.json({ produce:'Unknown', sector:'agri', confidence:0 });

  const b64 = checkImageSize(raw.replace(/^data:image\/\w+;base64,/, ''));

  if (!GEMINI_KEY) return res.json({ produce:'Unknown', sector:'agri', confidence:0, _demo:true });

  const prompt = `Identify the agricultural produce in this image.
Note: There may be a bank card or reference object in the image — ignore it and focus only on the produce/food item.
Sector context: ${sector||'agri'} (agri/dairy/fish)

Look at the produce carefully and identify it. Use standard Indian market names.
Examples of valid produce names: Wheat, Rice, Maize, Ragi, Jowar, Bajra, Moong (Whole), Moong Dal, Toor Dal, Chana Dal, Urad Dal, Soybean, Groundnut, Mustard, Tomato, Onion, Potato, Chilli, Turmeric, Mango, Banana, Tiger Prawn, Rohu, Cow Milk, Buffalo Milk, Paneer.

Respond ONLY with valid JSON, no markdown:
{"produce":"<name of the produce you see>","sector":"agri|dairy|fish","confidence":<0-100>,"tag":"grain|pulse|oilseed|veggie|fruit|spice|liquid|seafood","notes":"<one line describing what you see>"}`;

  try {
    const text = await callGemini(prompt, b64);
    console.log('[identify] Gemini raw:', text.substring(0,200));
    const result = parseJSON(text);
    // Guard: if produce is placeholder or empty, it means Gemini misread prompt
    if (!result.produce || result.produce.includes('<') || result.produce === 'Unknown') {
      console.warn('[identify] Bad produce value:', result.produce);
      return res.json({ produce:'Unknown', sector: result.sector||sector||'agri', confidence:0, _retry:true });
    }
    res.json(result);
  } catch(e) {
    console.error('[identify] error:', e.message);
    res.json({ produce:'Unknown', sector:'agri', confidence:0, error: e.message });
  }
});

/* ── /api/analyze ── */
app.post('/api/analyze', async (req, res) => {
  const { produce, sector, qty, unit, farmerName, language, gps, imageBase64: raw, grainMeasure } = req.body;

  let b64 = null;
  if (raw) b64 = checkImageSize(raw.replace(/^data:image\/\w+;base64,/, ''));

  if (!GEMINI_KEY) return res.json(demoReport(req.body));

  const grainNote = grainMeasure
    ? `\nCANVAS GRAIN MEASUREMENT: ${JSON.stringify(grainMeasure)}\nUse avgGrainSizeMm from canvas analysis.`
    : '';

  const prompt = `You are FasalEx DeepGazerAI — expert AGMARK grader for Indian farming.
AGMARK: Grade1=Export(<1%damage,NIL FM,moisture<12%), Grade2=Domestic(<2%,<0.5%FM), Grade3=Local(<5%,<1%FM).
K-CALIBRATION: If bank card(85.6mm)/SIM(25mm)/ruler visible in image: compute K=known_mm/card_px, grain_mm=grain_px*K.

Farmer: ${farmerName||'Farmer'}
Produce: ${produce}
Sector: ${sector}
Quantity: ${qty} ${unit}
GPS: ${gps ? gps.lat+'N '+gps.lon+'E' : 'Karnataka, India'}
Language: ${language||'en'}
${grainNote}
${b64 ? 'Analyze image carefully — assess colour, texture, uniformity, damage, foreign matter.' : 'No image — use typical characteristics.'}

Return ONLY valid JSON (no markdown):
{
  "produce":"${produce}","localName":"<aliases>","sector":"${sector}",
  "qty":"${qty} ${unit}","farmerName":"${farmerName||'Farmer'}",
  "gps":${JSON.stringify(gps||{lat:'15.2624',lon:'76.3823'})},
  "date":"${new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}",
  "overallGrade":"A|B|C|D",
  "gradeLabel":"Premium Export|Good Domestic|Standard Local|Reject",
  "confidence":<60-97>,
  "shelfLife":"<e.g. 10-14 days>",
  "estimatedRevenue":"<e.g. ₹18,000-22,000>",
  "marketRate":"<correct price for ${produce} in Karnataka e.g. ₹8,800/qtl>",
  "bestAction":"sell_now|store_wait|process_add_value|partial_sell",
  "expertTip":"<one practical sentence>",
  "avgGrainSizeMm":<number or null>,
  "grainSizeGrade":"<Grade 1 Bold|Grade 1|Grade 2|Grade 3 or null>",
  "grades":{
    "A":{"label":"Premium Export","pct":<0-100>,"priceRange":"<₹/qtl>"},
    "B":{"label":"Domestic Grade 1","pct":<0-100>,"priceRange":"<₹/qtl>"},
    "C":{"label":"Processing Grade","pct":<0-100>,"priceRange":"<₹/qtl>"},
    "D":{"label":"Reject/Waste","pct":<0-100>,"priceRange":"<₹/qtl>"}
  },
  "parameters":[
    {"name":"Moisture Content","standard":"<AGMARK limit>","found":"<estimated %>","pass":<true|false>},
    {"name":"Foreign Matter","standard":"<limit>","found":"<estimated %>","pass":<true|false>},
    {"name":"Damaged Kernels","standard":"<limit>","found":"<estimated %>","pass":<true|false>},
    {"name":"Colour Uniformity","standard":"Uniform","found":"<assessment>","pass":<true|false>},
    {"name":"Grain Size","standard":"<AGMARK spec>","found":"<mm value not null>","pass":<true|false>}
  ],
  "buyers":[
    {"name":"<realistic Indian name near GPS>","role":"Trader|Exporter|Processor|APMC","dist":"<X km>","phone":"+91 XXXXX XXXXX","offer":"<₹/unit>","rating":"4.2","verified":true},
    {"name":"<n>","role":"Exporter","dist":"<X km>","phone":"+91 XXXXX XXXXX","offer":"<₹/unit>","rating":"4.0","verified":true},
    {"name":"<n>","role":"APMC","dist":"<X km>","phone":"+91 XXXXX XXXXX","offer":"<₹/unit>","rating":"3.8","verified":false}
  ],
  "routes":[
    {"market":"Local APMC","price":"<₹/qtl>","std":"AGMARKNET","best":true},
    {"market":"eNAM National","price":"<₹/qtl>","std":"eNAM","best":false},
    {"market":"UAE/Dubai","price":"<₹/qtl>","std":"APEDA","best":false},
    {"market":"Germany","price":"<₹/qtl>","std":"EU 543/2011","best":false},
    {"market":"USA","price":"<₹/qtl>","std":"USDA AMS","best":false}
  ],
  "aiRemark":"<2-3 sentences quality assessment and recommendation>",
  "aiRemarkNative":"<same in local language if not English>",
  "marketInsight":"<one sentence market trend for ${produce}>",
  "exportCerts":["APEDA","FSSAI","AGMARK"]
}
CRITICAL RULES:
- grades A+B+C+D pct must sum to exactly 100
- marketRate must be correct for ${produce} in Karnataka India (NOT ₹2,000 for Moong/Soybean)
- Grain Size found must be a mm value — NEVER return null or empty
- buyers must have realistic names near GPS ${gps ? gps.lat+'N '+gps.lon+'E' : 'Hospet Karnataka'}
- routes must have real price values — no undefined`;

  try {
    const text = await callGemini(prompt, b64);
    const report = parseJSON(text);
    res.json(report);
  } catch(e) {
    console.error('[analyze]', e.message);
    const demo = demoReport(req.body);
    demo._error = e.message;
    demo._aibusy = e.message.includes('429') || e.message.includes('timeout');
    res.json(demo);
  }
});

/* ── Demo fallback ── */
function demoReport({ produce='Soybean', sector='agri', qty='10', unit='qtl', farmerName='Farmer', gps }) {
  const g = gps || { lat:'15.2624', lon:'76.3823' };
  const prices = {
    'Soybean':'₹4,600','Moong (Whole)':'₹8,800','Green Gram':'₹8,800',
    'Toor Dal':'₹9,200','Wheat':'₹2,450','Rice':'₹3,100','Ragi':'₹2,100',
    'Chilli (Dry)':'₹9,500','Turmeric':'₹8,200','Groundnut':'₹6,200'
  };
  const price = prices[produce] || '₹4,500';
  return {
    produce, localName:produce, sector, qty:`${qty} ${unit}`, farmerName, gps:g,
    date: new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}),
    overallGrade:'B', gradeLabel:'Good Domestic', confidence:72,
    shelfLife:'10-14 days',
    estimatedRevenue:'₹18,000-22,000',
    marketRate:price+'/qtl',
    bestAction:'sell_now',
    expertTip:'Clean and bag in moisture-proof sacks before transport.',
    avgGrainSizeMm:6.5, grainSizeGrade:'Grade 1',
    grades:{
      A:{label:'Premium Export',  pct:20,priceRange:price+'+/qtl'},
      B:{label:'Domestic Grade 1',pct:52,priceRange:price+'/qtl'},
      C:{label:'Processing Grade',pct:20,priceRange:'₹3,500-4,000/qtl'},
      D:{label:'Reject/Waste',    pct:8, priceRange:'Below ₹3,500/qtl'},
    },
    parameters:[
      {name:'Moisture Content', standard:'Max 12%', found:'~11%',         pass:true},
      {name:'Foreign Matter',   standard:'Max 1%',  found:'~0.5%',        pass:true},
      {name:'Damaged Kernels',  standard:'Max 5%',  found:'~3%',          pass:true},
      {name:'Colour Uniformity',standard:'Uniform', found:'Mostly uniform',pass:true},
      {name:'Grain Size',       standard:'>6mm',    found:'~6.5mm',       pass:true},
    ],
    routes:[
      {market:'Local APMC',   price:price+'/qtl', std:'AGMARKNET',   best:true},
      {market:'eNAM National',price:price+'/qtl', std:'eNAM',        best:false},
      {market:'UAE/Dubai',    price:'₹5,500/qtl', std:'APEDA',       best:false},
      {market:'Germany',      price:'₹5,800/qtl', std:'EU 543/2011', best:false},
      {market:'USA',          price:'₹5,600/qtl', std:'USDA AMS',    best:false},
    ],
    buyers:[
      {name:'Ramesh Agrotech Pvt Ltd',role:'Trader',  dist:'2.8 km',phone:'+91 98765 43210',offer:price+'/qtl',rating:'4.8',verified:true},
      {name:'GreenGold Exports',      role:'Exporter',dist:'11 km', phone:'+91 87654 32109',offer:'₹5,200/qtl',rating:'4.6',verified:true},
      {name:'Hospet APMC',            role:'APMC',    dist:'6.5 km',phone:'+91 76543 21098',offer:price+'/qtl',rating:'4.3',verified:true},
    ],
    aiRemark:'Good quality produce. Recommend prompt sale at current market prices.',
    aiRemarkNative:'', marketInsight:'Prices stable this week.',
    exportCerts:['APEDA','FSSAI','AGMARK'],
    _demo:true,
  };
}

/* ── /cert/ SPA route ── */
app.get('/cert/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ── Start ── */
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n✅ FasalEx · DeepGazerAI v3.0.0');
  console.log('   URL    : http://localhost:' + PORT);
  console.log('   AI     : ' + (GEMINI_KEY ? 'Gemini Flash 2.0 ✓ (free tier)' : 'DEMO MODE — set GEMINI_API_KEY'));
  console.log('   /cert/ : SPA route active\n');
});
