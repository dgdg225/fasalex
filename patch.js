// FarEX Camera Fix — run ONCE with: node patch.js
// Then: node server.js
'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'public', 'index.html');

if (!fs.existsSync(p)) { console.error('❌ Cannot find public/index.html'); process.exit(1); }

let h = fs.readFileSync(p, 'utf8');
console.log('File loaded:', h.length, 'chars');

let changed = 0;

// Fix 1: Replace blocking FileReader image load with instant blobURL approach
const fnStart = h.indexOf('function handleScanFile(e){');
const fnEnd   = h.indexOf('\nfunction stampGPSOnCanvas(', fnStart);
if (fnStart > 0 && fnEnd > fnStart) {
  const newFn = `function handleScanFile(e){
  const file = e.target.files && e.target.files[0];
  if(!file){ return; }
  const isVideo = file.type.startsWith('video/');
  if(isVideo){
    const bU=URL.createObjectURL(file);const vid=document.createElement('video');
    vid.src=bU;vid.muted=true;vid.playsInline=true;
    vid.onloadeddata=function(){vid.currentTime=0.5;};
    vid.onseeked=function(){
      try{const cv=document.createElement('canvas');cv.width=Math.min(vid.videoWidth||1280,1280);cv.height=Math.min(vid.videoHeight||960,960);cv.getContext('2d').drawImage(vid,0,0,cv.width,cv.height);const d=cv.toDataURL('image/jpeg',0.85);S.scan.imageBase64=d.split(',')[1];S.scan.grainMeasure=null;showScanPreview(d);toast('✓ Video ready!');setTimeout(function(){triggerAIDetectionFromFile();},400);}catch(er){toast('Video err','#E74C3C');}
      URL.revokeObjectURL(bU);
    };
    vid.onerror=function(){URL.revokeObjectURL(bU);};vid.load();return;
  }
  // IMAGE — show instantly via blobURL, convert to base64 in background
  const blobURL = URL.createObjectURL(file);
  const pi = document.getElementById('previewImg');
  if(!pi){ return; }
  pi.onload = function(){
    showScanPreview(blobURL);
    toast('✓ Photo loaded!');
    const r = new FileReader();
    r.onload = function(ev){
      const img2 = new Image();
      img2.onload = function(){
        try{
          const MX=1280;let w=img2.width,h=img2.height;
          if(w>MX||h>MX){if(w>h){h=Math.round(h*MX/w);w=MX;}else{w=Math.round(w*MX/h);h=MX;}}
          const cv=document.createElement('canvas');cv.width=w;cv.height=h;
          cv.getContext('2d').drawImage(img2,0,0,w,h);
          try{
            const gm=measureGrainSizeFromCanvas(cv);S.scan.grainMeasure=gm;
            if(gm&&gm.avgMm){const lb=gm.coinDetected?'📏 '+gm.avgMm+'mm ✓':'📏 '+gm.avgMm+'mm est.';const ov=document.getElementById('grainSizeOverlay');if(ov){ov.textContent=lb;ov.style.background=gm.coinDetected?'rgba(233,196,106,.95)':'rgba(249,115,22,.9)';ov.style.display='block';}}
          }catch(ge){console.warn('grain',ge.message);}
          S.scan.imageBase64=cv.toDataURL('image/jpeg',0.85).split(',')[1];
        }catch(ce){ S.scan.imageBase64=ev.target.result.split(',')[1]; }
        URL.revokeObjectURL(blobURL);
        setTimeout(function(){triggerAIDetectionFromFile();},300);
      };
      img2.onerror=function(){S.scan.imageBase64=ev.target.result.split(',')[1];URL.revokeObjectURL(blobURL);setTimeout(function(){triggerAIDetectionFromFile();},300);};
      img2.src=ev.target.result;
    };
    r.readAsDataURL(file);
  };
  pi.onerror=function(){toast('Cannot show image','#E74C3C');URL.revokeObjectURL(blobURL);};
  pi.src=blobURL;
  try{e.target.value='';}catch(_){}
}
`;
  h = h.slice(0, fnStart) + newFn + h.slice(fnEnd);
  changed++;
  console.log('✅ Fix 1: Image handler replaced');
} else {
  console.log('⚠  Fix 1: handleScanFile not found (may already be patched)');
}

fs.writeFileSync(p, h);
if(changed > 0){
  console.log('\n🎉 DONE! Now run: node server.js');
  console.log('   Then refresh phone: http://192.168.31.81:3000');
} else {
  console.log('\n⚠  No changes made — file may already be up to date');
}
