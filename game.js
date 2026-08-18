const $ = (id) => document.getElementById(id);
const screens = { welcome: $('welcome'), game: $('game') };
const NOTES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
const SOLFEGE = ['DO','REH','MI','FA','SOL','LA','TI','DO'];
const OFFSETS = [0,2,4,5,7,9,11,12];
const HOLD_SECONDS = 1.15;
const deerPhoto=new Image(),alpinePhoto=new Image();
deerPhoto.src='assets/deer.jpg';alpinePhoto.src='assets/alps.jpg';
let audioContext, analyser, micStream, audioBuffer;
let latest = { pitch: 0, volume: 0, confidence: 0, sequence: 0 };
let lastAnalysis = 0, lastPitchSequence = -1;
let mode = 'welcome';
let baseMidi = 60, level = 0, lift = 0, score = 0, streak = 0;
let recentPitches = [], lastFrame = performance.now(), travelStart = 0, finaleStart = 0, scopePan = 0, scopeVelocity = 0;
let calibrationPending = true, calibrationPitches = [];

function midiFrequency(midi){ return 440 * 2 ** ((midi - 69) / 12); }
function noteName(midi){ return NOTES[(midi % 12 + 12) % 12] + (Math.floor(midi / 12) - 1); }
function median(values){ const a = [...values].sort((x,y)=>x-y); return a[Math.floor(a.length/2)] || 0; }
function show(name){ Object.entries(screens).forEach(([key,el]) => el.classList.toggle('hidden', key !== name)); mode = name; }
function toast(message){ const el=$('toast'); el.textContent=message; el.classList.remove('hidden'); setTimeout(()=>el.classList.add('hidden'),4500); }

async function startMicrophone(){
  try {
    micStream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();
    const source = audioContext.createMediaStreamSource(micStream);
    const highpass = audioContext.createBiquadFilter();
    highpass.type='highpass'; highpass.frequency.value=60;
    analyser = audioContext.createAnalyser();
    analyser.fftSize=4096; analyser.smoothingTimeConstant=0;
    audioBuffer = new Float32Array(analyser.fftSize);
    source.connect(highpass).connect(analyser);
    startGame();
  } catch (error) {
    console.error(error);
    toast('Microphone access is needed to play. Please allow it in your browser settings.');
    $('startButton').disabled=false; $('startButton').textContent='Try microphone again →';
  }
}

// YIN pitch detector, tuned for a clear monophonic singing voice.
function detectPitch(data, sampleRate){
  const n=data.length, centered=new Float32Array(n);
  let mean=0, energy=0;
  for(let i=0;i<n;i++) mean+=data[i]; mean/=n;
  for(let i=0;i<n;i++){ const x=data[i]-mean; centered[i]=x; energy+=x*x; }
  const rms=Math.sqrt(energy/n);
  if(rms<0.008) return {pitch:0,volume:rms,confidence:0};
  // Cover the practical sung range C2–C7 while retaining several periods for
  // bass notes. AudioContext.sampleRate is the hardware clock used here.
  const minLag=Math.max(2,Math.floor(sampleRate/2200));
  const maxLag=Math.min(n>>1,Math.floor(sampleRate/55));
  const diff=new Float32Array(maxLag+1), cmnd=new Float32Array(maxLag+1);
  let running=0; cmnd[0]=1;
  for(let lag=1;lag<=maxLag;lag++){
    let sum=0, end=n-lag;
    for(let i=0;i<end;i++){ const d=centered[i]-centered[i+lag]; sum+=d*d; }
    diff[lag]=sum; running+=sum; cmnd[lag]=running ? sum*lag/running : 1;
  }
  let chosen=0;
  for(let lag=minLag;lag<maxLag;lag++){
    if(cmnd[lag]<.18){ while(lag+1<=maxLag && cmnd[lag+1]<cmnd[lag]) lag++; chosen=lag; break; }
  }
  if(!chosen){ let best=Infinity; for(let lag=minLag;lag<=maxLag;lag++) if(cmnd[lag]<best){best=cmnd[lag];chosen=lag;} }
  const confidence=Math.max(0,1-cmnd[chosen]);
  if(confidence<.55) return {pitch:0,volume:rms,confidence};
  let refined=chosen;
  if(chosen>1&&chosen<maxLag){
    const a=cmnd[chosen-1],b=cmnd[chosen],c=cmnd[chosen+1],den=a-2*b+c;
    if(Math.abs(den)>1e-6) refined+=.5*(a-c)/den;
  }
  return {pitch:sampleRate/refined,volume:rms,confidence};
}

function analyze(now){
  if(!analyser || now-lastAnalysis<70) return;
  lastAnalysis=now; analyser.getFloatTimeDomainData(audioBuffer);
  const measured=detectPitch(audioBuffer,audioContext.sampleRate);
  latest={...measured,sequence:latest.sequence+1};
}

function startGame(){
  level=0; lift=0; score=0; streak=0; travelStart=0; finaleStart=0; recentPitches=[]; calibrationPending=true; calibrationPitches=[]; lastPitchSequence=-1; scopePan=0; scopeVelocity=0;
  updateLabels(); show('game'); resizeCanvas(); lastFrame=performance.now();
  $('pitchReadout').textContent='Sing your first DO in any octave';
  $('gameMessage').textContent='Your first DO automatically sets the octave';
  requestAnimationFrame(loop);
}
function updateLabels(){
  $('score').textContent=`🌈 ${score}`; $('streak').textContent=`${level+1} / 8`;
  $('solfege').textContent=SOLFEGE[level]; $('noteName').textContent=noteName(baseMidi+OFFSETS[level]);
}
function resetGame(){ level=0;lift=0;score=0;streak=0;travelStart=0;finaleStart=0;recentPitches=[];calibrationPending=true;calibrationPitches=[];lastPitchSequence=-1;scopePan=0;scopeVelocity=0;canvas.style.transform='';updateLabels();$('gameMessage').textContent='Your first DO automatically sets the octave'; }
function changeOctave(){ baseMidi=baseMidi>=72?48:baseMidi+12;lift=0;travelStart=0;recentPitches=[];calibrationPending=false;scopePan=0;scopeVelocity=0;updateLabels();$('gameMessage').textContent=`Octave changed to ${noteName(baseMidi)}`; }
function playMagicPop(){
  if(!audioContext)return;
  const t=audioContext.currentTime, gain=audioContext.createGain(), osc=audioContext.createOscillator();
  gain.gain.setValueAtTime(.0001,t);gain.gain.exponentialRampToValueAtTime(.12,t+.01);gain.gain.exponentialRampToValueAtTime(.0001,t+.22);
  osc.type='triangle';osc.frequency.setValueAtTime(180,t);osc.frequency.exponentialRampToValueAtTime(75,t+.18);
  osc.connect(gain).connect(audioContext.destination);osc.start(t);osc.stop(t+.23);
}

function updateGame(now,dt){
  const fresh=latest.sequence!==lastPitchSequence;
  if(fresh){
    lastPitchSequence=latest.sequence;
    if(latest.pitch>0){recentPitches.push(latest.pitch);if(recentPitches.length>5)recentPitches.shift();}
    else if(latest.volume<.008){recentPitches=[];calibrationPitches=[];}
  }
  const pitch=median(recentPitches);
  const singing=pitch>0&&latest.volume>=.008&&latest.confidence>.55;
  if(calibrationPending&&fresh&&latest.pitch>0&&latest.confidence>.65){
    calibrationPitches.push(latest.pitch);if(calibrationPitches.length>5)calibrationPitches.shift();
    if(calibrationPitches.length>=4){
      const low=Math.min(...calibrationPitches),high=Math.max(...calibrationPitches);
      const spread=1200*Math.log2(high/low);
      if(spread<=30){
        const stableDO=median(calibrationPitches);
        const sungMidi=69+12*Math.log2(stableDO/440);
        baseMidi=Math.max(36,Math.min(84,Math.round((sungMidi-4)/12)*12));
        calibrationPending=false;updateLabels();
        $('gameMessage').textContent=`Octave set to ${noteName(baseMidi)} — hold DO on target`;
      }
    }
  }
  const target=midiFrequency(baseMidi+OFFSETS[level]);
  const cents=pitch>0?1200*Math.log2(pitch/target):null;
  const tuned=!calibrationPending&&singing&&Math.abs(cents)<=22, near=!calibrationPending&&singing&&Math.abs(cents)<=50;
  if(calibrationPending) $('pitchReadout').textContent='Sing your first DO in any octave';
  else if(singing) $('pitchReadout').textContent=`${cents>=0?'+':''}${Math.round(cents)} cents — scope ${cents<0?'low':'high'}`;
  else $('pitchReadout').textContent=`Sing ${SOLFEGE[level]} — the scope follows your voice`;
  if(finaleStart){
    $('holdFill').style.width='0%';drawGame(now,false,cents,false);
    if(now-finaleStart>7000){finaleStart=0;level=0;score=0;streak=0;updateLabels();$('gameMessage').textContent='Encore! Sing DO for a new meadow';}
    return;
  }
  if(!travelStart){
    if(tuned){ lift=Math.min(1,lift+dt/HOLD_SECONDS); $('gameMessage').textContent='Perfect — keep holding!'; }
    else if(near){ lift=Math.max(0,lift-dt*.12); $('gameMessage').textContent=cents<0?'Just a little higher ↑':'Just a little lower ↓'; }
    else { lift=Math.max(0,lift-dt*.48); $('gameMessage').textContent=singing?(cents<0?'Sing higher ↑':'Sing lower ↓'):`Listening… sing ${SOLFEGE[level]}`; }
    if(lift>=1){ score++;streak++;travelStart=now;playMagicPop();updateLabels();$('gameMessage').textContent='POW! Antler rainbow magic!'; }
  } else if(now-travelStart>=1400){
    travelStart=0;lift=0;recentPitches=[];
    if(level===7){finaleStart=now;$('gameMessage').textContent='The scope pulls back — the whole herd returns!';}
    else{level++;$('gameMessage').textContent=`A new deer appears — sing ${SOLFEGE[level]}`;}
    updateLabels();
  }
  $('holdFill').style.width=`${lift*100}%`;
  drawGame(now,tuned,cents,singing);
}

const canvas=$('gameCanvas'), ctx=canvas.getContext('2d');
function resizeCanvas(){
  const rect=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);
  canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);
}
function drawAntlers(x,y,s,color='#68452b'){
  ctx.strokeStyle=color;ctx.lineWidth=3*s;ctx.lineCap='round';
  for(const side of [-1,1]){ctx.beginPath();ctx.moveTo(x+side*8*s,y);ctx.quadraticCurveTo(x+side*18*s,y-18*s,x+side*25*s,y-31*s);ctx.moveTo(x+side*17*s,y-18*s);ctx.lineTo(x+side*9*s,y-29*s);ctx.moveTo(x+side*22*s,y-26*s);ctx.lineTo(x+side*32*s,y-29*s);ctx.stroke();}
}
function drawRainbow(x,y,s,alpha=1){
  const colors=['#d84438','#e98c39','#f2d34f','#55a95b','#4e9bc5','#7657a5'];ctx.save();ctx.globalAlpha=alpha;ctx.lineCap='round';
  colors.forEach((color,i)=>{ctx.strokeStyle=color;ctx.lineWidth=7*s;ctx.beginPath();ctx.arc(x,y+34*s,(56-i*7)*s,Math.PI,Math.PI*2);ctx.stroke();});
  drawAntlers(x,y-28*s,s*.85,'#6e4729');ctx.restore();
}
function drawReticle(x,y,r,tuned,progress){
  ctx.save();ctx.strokeStyle=tuned?'#f5f0cf':'#24392c';ctx.fillStyle=tuned?'#f5f0cf':'#24392c';ctx.lineWidth=2;ctx.shadowColor=tuned?'#fff':'transparent';ctx.shadowBlur=tuned?8:0;
  ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.arc(x,y,r*.28,0,Math.PI*2);ctx.stroke();
  ctx.beginPath();ctx.moveTo(x-r*1.7,y);ctx.lineTo(x-r*.45,y);ctx.moveTo(x+r*.45,y);ctx.lineTo(x+r*1.7,y);ctx.moveTo(x,y-r*1.7);ctx.lineTo(x,y-r*.45);ctx.moveTo(x,y+r*.45);ctx.lineTo(x,y+r*1.7);ctx.stroke();
  ctx.lineWidth=4;ctx.strokeStyle='#f4d45f';ctx.beginPath();ctx.arc(x,y,r+7,-Math.PI/2,-Math.PI/2+Math.PI*2*progress);ctx.stroke();ctx.restore();
}
function drawPhotoCover(image,x,y,w,h){
  if(!image.complete||!image.naturalWidth){ctx.fillStyle='#8a7659';ctx.fillRect(x,y,w,h);return;}
  const ir=image.naturalWidth/image.naturalHeight,ar=w/h;
  let sx=0,sy=0,sw=image.naturalWidth,sh=image.naturalHeight;
  if(ir>ar){sw=image.naturalHeight*ar;sx=(image.naturalWidth-sw)/2;}else{sh=image.naturalWidth/ar;sy=(image.naturalHeight-sh)/2;}
  ctx.drawImage(image,sx,sy,sw,sh,x,y,w,h);
}
function drawVintageGrain(w,h,now){
  ctx.save();ctx.globalCompositeOperation='multiply';ctx.fillStyle='rgba(104,69,42,.22)';ctx.fillRect(0,0,w,h);ctx.globalCompositeOperation='screen';
  for(let i=0;i<170;i++){const x=(i*83+now*.017)%w,y=(i*149+Math.sin(i*7)*31+h)%h,a=.025+(i%5)*.008;ctx.fillStyle=`rgba(255,244,210,${a})`;ctx.fillRect(x,y,1+(i%3),1+(i%2));}
  ctx.globalAlpha=.12;ctx.strokeStyle='#fff3cf';for(let i=0;i<3;i++){const x=(now*.012+i*w*.37)%w;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x-3,h);ctx.stroke();}ctx.restore();
}
const DEER_FOCI=[[.35,.66],[.69,.62],[.83,.59],[.34,.65],[.7,.61],[.82,.6],[.36,.66],[.68,.62]];
function drawDeerPhotoTarget(cx,cy,r,index,pan){
  if(!deerPhoto.complete||!deerPhoto.naturalWidth)return false;
  const [fx,fy]=DEER_FOCI[index%DEER_FOCI.length],dw=r*3.4,dh=dw*deerPhoto.naturalHeight/deerPhoto.naturalWidth;
  ctx.save();ctx.filter='sepia(.78) saturate(.58) contrast(1.18) brightness(.9)';ctx.drawImage(deerPhoto,cx-fx*dw,cy-fy*dh+pan,dw,dh);ctx.restore();return true;
}
function drawRainbowExplosion(now,p,w,h){
  const colors=['#d54238','#ef8737','#f3cf43','#4ba95a','#3a91bd','#72549a'];
  const blast=Math.min(1,p/.55),cx=w/2,cy=h/2;
  ctx.save();ctx.globalCompositeOperation='screen';
  for(let ray=0;ray<24;ray++){const a=ray*Math.PI*2/24+now*.00025,len=(40+Math.sin(ray*9)*18)+blast*Math.max(w,h)*.85;ctx.strokeStyle=colors[ray%colors.length];ctx.globalAlpha=.35+.45*(1-blast);ctx.lineWidth=8+ray%4*3;ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*25,cy+Math.sin(a)*25);ctx.lineTo(cx+Math.cos(a)*len,cy+Math.sin(a)*len);ctx.stroke();}
  ctx.globalCompositeOperation='source-over';for(let i=0;i<80;i++){const a=i*2.399,len=blast*(60+(i%17)*18),x=cx+Math.cos(a)*len,y=cy+Math.sin(a)*len;ctx.fillStyle=colors[i%6];ctx.save();ctx.translate(x,y);ctx.rotate(a+now*.004);ctx.fillRect(-5,-2,10,4);ctx.restore();}
  ctx.globalAlpha=Math.max(0,1-p*2.4);ctx.fillStyle='#fff8d8';ctx.fillRect(0,0,w,h);ctx.restore();
}
function drawDeerPortrait(x,y,size,index,now){
  if(!deerPhoto.complete||!deerPhoto.naturalWidth)return;
  const [fx,fy]=DEER_FOCI[index%3],sw=deerPhoto.naturalWidth*.23,sh=deerPhoto.naturalHeight*.5,sx=fx*deerPhoto.naturalWidth-sw/2,sy=fy*deerPhoto.naturalHeight-sh*.52;
  ctx.save();ctx.beginPath();ctx.ellipse(x,y,size*.43,size*.52,0,0,Math.PI*2);ctx.clip();ctx.filter='sepia(.5) saturate(.8) contrast(1.1)';ctx.drawImage(deerPhoto,sx,sy,sw,sh,x-size*.43,y-size*.52,size*.86,size*1.04);ctx.restore();ctx.strokeStyle='#fff0c4';ctx.lineWidth=3;ctx.beginPath();ctx.ellipse(x,y,size*.43,size*.52,0,0,Math.PI*2);ctx.stroke();
}
function drawFinale(now,w,h,cx,cy,r){
  const elapsed=now-finaleStart,p=Math.min(1,elapsed/1800),zoomR=r+p*Math.max(w,h)*.8;
  ctx.fillStyle='#17150f';ctx.fillRect(0,0,w,h);ctx.save();ctx.beginPath();ctx.arc(cx,cy,zoomR,0,Math.PI*2);ctx.clip();ctx.save();ctx.filter='sepia(.62) saturate(.62) contrast(1.1)';drawPhotoCover(alpinePhoto,0,0,w,h);ctx.restore();ctx.fillStyle='rgba(107,69,37,.2)';ctx.fillRect(0,0,w,h);
  const colors=['#c93f37','#e27a32','#e7bd3d','#4a9654','#438ca8','#71518a'],rr=Math.min(w*.43,h*.6);ctx.lineCap='round';colors.forEach((c,i)=>{ctx.strokeStyle=c;ctx.lineWidth=Math.max(8,w/65);ctx.beginPath();ctx.arc(cx,h*.7,rr-i*Math.max(9,w/68),Math.PI,Math.PI*2);ctx.stroke();});
  const dance=Math.max(0,Math.min(1,(elapsed-900)/900));for(let i=0;i<8;i++){const x=w*.09+i*w*.117,y=h*.76+Math.sin(now*.008+i*1.7)*18*dance;drawDeerPortrait(x,y,Math.min(85,w/9),i,now);}
  ctx.font=`700 ${Math.max(24,w/18)}px "Poiret One"`;ctx.textAlign='center';ctx.fillStyle='#fff3cf';ctx.shadowColor='#513720';ctx.shadowBlur=7;ctx.fillText('ACHT REGENBOGEN!',cx,h*.15);ctx.shadowBlur=0;drawVintageGrain(w,h,now);ctx.restore();
  if(p<1){ctx.strokeStyle='#d7c485';ctx.lineWidth=7;ctx.beginPath();ctx.arc(cx,cy,zoomR,0,Math.PI*2);ctx.stroke();}
}
function drawGame(now,tuned,cents,singing){
  const w=canvas.clientWidth,h=canvas.clientHeight,cx=w/2,cy=h/2,r=Math.min(w,h)*.46,deerY=cy+r*.1;ctx.clearRect(0,0,w,h);
  if(finaleStart){canvas.style.transform='';drawFinale(now,w,h,cx,cy,r);return;}
  const p=travelStart?Math.min(1,(now-travelStart)/1400):0,shake=travelStart&&p<.48?(1-p/.48)*18:0;
  canvas.style.transform=shake?`translate(${(Math.random()-.5)*shake}px,${(Math.random()-.5)*shake}px) rotate(${(Math.random()-.5)*shake*.12}deg)`:'none';
  ctx.fillStyle='#15150f';ctx.fillRect(0,0,w,h);
  const desiredPan=travelStart||!singing?0:Math.max(-65,Math.min(65,cents))*(r*1.38/65);
  scopeVelocity+=(desiredPan-scopePan)*.045;scopeVelocity*=.82;scopePan=Math.max(-r*1.45,Math.min(r*1.45,scopePan+scopeVelocity));
  ctx.save();ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.clip();
  ctx.save();ctx.filter='sepia(.82) saturate(.48) contrast(1.15)';drawPhotoCover(alpinePhoto,cx-r,cy-r*1.8+scopePan*.22,r*2,r*3.6);ctx.restore();
  drawDeerPhotoTarget(cx,deerY,r,level,scopePan);drawVintageGrain(w,h,now);
  if(travelStart){ctx.fillStyle=`rgba(255,244,205,${Math.max(0,.45-p)})`;ctx.fillRect(0,0,w,h);}
  for(let i=0;i<Math.min(score-(travelStart?1:0),8);i++)drawRainbow(cx-r*.78+i*r*.22,cy+r*.77,.18,.9);
  if(!travelStart)drawReticle(cx,deerY,25,tuned,lift);
  ctx.restore();ctx.strokeStyle='#bda56d';ctx.lineWidth=6;ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.stroke();ctx.strokeStyle='#090b09';ctx.lineWidth=14;ctx.beginPath();ctx.arc(cx,cy,r+9,0,Math.PI*2);ctx.stroke();
  if(travelStart){drawRainbowExplosion(now,p,w,h);if(p<.4){ctx.font=`700 ${Math.round(Math.max(48,w/10))}px "Poiret One"`;ctx.textAlign='center';ctx.fillStyle='#8d2e2a';ctx.strokeStyle='#fff3cf';ctx.lineWidth=8;ctx.strokeText('POW!',cx,cy);ctx.fillText('POW!',cx,cy);}}
}
function loop(now){
  analyze(now);
  const dt=Math.min(.1,(now-lastFrame)/1000);lastFrame=now;
  if(mode==='game')updateGame(now,dt);
  if(mode!=='welcome')requestAnimationFrame(loop);
}

$('startButton').addEventListener('click',()=>{ $('startButton').disabled=true; $('startButton').textContent='Opening microphone…'; startMicrophone(); });
$('octaveButton').addEventListener('click',changeOctave);$('resetButton').addEventListener('click',resetGame);
$('helpButton').addEventListener('click',()=>$('helpDialog').showModal());$('closeHelp').addEventListener('click',()=>$('helpDialog').close());
window.addEventListener('resize',()=>{if(mode==='game')resizeCanvas();});
window.addEventListener('keydown',e=>{if(mode==='game'&&(e.key==='o'||e.key==='O'))changeOctave();if(mode==='game'&&(e.key==='r'||e.key==='R'))resetGame();});
