const $ = (id) => document.getElementById(id);
const screens = { welcome: $('welcome'), setup: $('setup'), game: $('game') };
const NOTES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
const SOLFEGE = ['DO','REH','MI','FA','SOL','LA','TI','DO'];
const OFFSETS = [0,2,4,5,7,9,11,12];
const HOLD_SECONDS = 1.15;
let audioContext, analyser, micStream, audioBuffer;
let latest = { pitch: 0, volume: 0, confidence: 0 };
let lastAnalysis = 0;
let mode = 'welcome';
let baseMidi = 60, level = 0, lift = 0, score = 0, streak = 0;
let recentPitches = [], lastFrame = performance.now(), travelStart = 0, scopePan = 0;
let setupStage = 0, setupAnchor = 0, setupAccepted = [], setupReadyAt = 0;

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
    beginSetup();
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
  const minLag=Math.max(2,Math.floor(sampleRate/1000));
  const maxLag=Math.min(n>>1,Math.floor(sampleRate/70));
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
  latest=detectPitch(audioBuffer,audioContext.sampleRate);
}

function beginSetup(){
  setupStage=0; setupReadyAt=performance.now()+500;
  document.querySelector('[data-stage="0"]').className='setup-note active';
  $('setupPrompt').textContent='Sing your first DO'; $('setupFeedback').textContent='Listening…';
  show('setup'); requestAnimationFrame(loop);
}
function updateSetup(now){
  const singing=latest.pitch>0&&latest.volume>=.008&&latest.confidence>.55;
  $('setupFeedback').textContent=singing?`Heard ${Math.round(latest.pitch)} Hz — got your octave!`:'Listening…';
  if(now>=setupReadyAt&&singing&&setupStage===0){
    setupStage=1;
    const sungMidi=69+12*Math.log2(latest.pitch/440);
    // The first DO may be in any octave; select the matching C-to-C game range.
    baseMidi=Math.max(36,Math.min(72,Math.round((sungMidi-4)/12)*12));
    document.querySelector('[data-stage="0"]').className='setup-note done';
    $('setupPrompt').textContent='Octave found!';
    $('setupFeedback').textContent=`Your melody: ${noteName(baseMidi)}–${noteName(baseMidi+12)}`;
    setTimeout(startGame,900);
  }
}

function startGame(){
  level=0; lift=0; score=0; streak=0; travelStart=0; recentPitches=[];
  updateLabels(); show('game'); resizeCanvas(); lastFrame=performance.now();
}
function updateLabels(){
  $('score').textContent=`🌈 ${score}`; $('streak').textContent=`${level+1} / 8`;
  $('solfege').textContent=SOLFEGE[level]; $('noteName').textContent=noteName(baseMidi+OFFSETS[level]);
}
function resetGame(){ level=0;lift=0;score=0;streak=0;travelStart=0;recentPitches=[];updateLabels();$('gameMessage').textContent='Move the bullseye onto the deer with your voice'; }
function changeOctave(){ baseMidi=baseMidi>=72?48:baseMidi+12;lift=0;travelStart=0;recentPitches=[];updateLabels();$('gameMessage').textContent=`Octave changed to ${noteName(baseMidi)}`; }
function playMagicPop(){
  if(!audioContext)return;
  const t=audioContext.currentTime, gain=audioContext.createGain(), osc=audioContext.createOscillator();
  gain.gain.setValueAtTime(.0001,t);gain.gain.exponentialRampToValueAtTime(.12,t+.01);gain.gain.exponentialRampToValueAtTime(.0001,t+.22);
  osc.type='triangle';osc.frequency.setValueAtTime(180,t);osc.frequency.exponentialRampToValueAtTime(75,t+.18);
  osc.connect(gain).connect(audioContext.destination);osc.start(t);osc.stop(t+.23);
}

function updateGame(now,dt){
  if(latest.pitch>0){ recentPitches.push(latest.pitch); if(recentPitches.length>5)recentPitches.shift(); }
  else if(latest.volume<.008) recentPitches=[];
  const pitch=median(recentPitches), target=midiFrequency(baseMidi+OFFSETS[level]);
  const cents=pitch>0?1200*Math.log2(pitch/target):null;
  const singing=pitch>0&&latest.volume>=.008&&latest.confidence>.5;
  const tuned=singing&&Math.abs(cents)<=22, near=singing&&Math.abs(cents)<=50;
  if(singing) $('pitchReadout').textContent=`${cents>=0?'+':''}${Math.round(cents)} cents — scope ${cents<0?'low':'high'}`;
  else $('pitchReadout').textContent=`Sing ${SOLFEGE[level]} — the scope follows your voice`;
  if(!travelStart){
    if(tuned){ lift=Math.min(1,lift+dt/HOLD_SECONDS); $('gameMessage').textContent='Perfect — keep holding!'; }
    else if(near){ lift=Math.max(0,lift-dt*.12); $('gameMessage').textContent=cents<0?'Just a little higher ↑':'Just a little lower ↓'; }
    else { lift=Math.max(0,lift-dt*.48); $('gameMessage').textContent=singing?(cents<0?'Sing higher ↑':'Sing lower ↓'):`Listening… sing ${SOLFEGE[level]}`; }
    if(lift>=1){ score++;streak++;travelStart=now;playMagicPop();updateLabels();$('gameMessage').textContent='POW! Antler rainbow magic!'; }
  } else if(now-travelStart>=1400){
    travelStart=0;lift=0;recentPitches=[];level++;
    if(level>=8){level=0;$('gameMessage').textContent='All eight rainbows! Back to DO';}
    else $('gameMessage').textContent=`A new deer appears — sing ${SOLFEGE[level]}`;
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
function drawDeer(x,y,s,alpha=1){
  ctx.save();ctx.globalAlpha=alpha;ctx.fillStyle='#a86e38';ctx.strokeStyle='#6e4729';ctx.lineWidth=2*s;
  ctx.beginPath();ctx.ellipse(x,y+18*s,48*s,28*s,0,0,Math.PI*2);ctx.fill();ctx.stroke();
  ctx.beginPath();ctx.moveTo(x+30*s,y+5*s);ctx.quadraticCurveTo(x+28*s,y-27*s,x+18*s,y-48*s);ctx.lineTo(x+43*s,y-49*s);ctx.quadraticCurveTo(x+55*s,y-21*s,x+45*s,y+10*s);ctx.closePath();ctx.fill();ctx.stroke();
  ctx.beginPath();ctx.ellipse(x+30*s,y-55*s,26*s,22*s,-.12,0,Math.PI*2);ctx.fill();ctx.stroke();
  ctx.beginPath();ctx.moveTo(x+12*s,y-67*s);ctx.lineTo(x-3*s,y-79*s);ctx.lineTo(x+17*s,y-75*s);ctx.closePath();ctx.fill();
  ctx.beginPath();ctx.moveTo(x+46*s,y-69*s);ctx.lineTo(x+61*s,y-82*s);ctx.lineTo(x+52*s,y-61*s);ctx.closePath();ctx.fill();
  drawAntlers(x+30*s,y-73*s,s);
  ctx.fillStyle='#17271c';ctx.beginPath();ctx.arc(x+23*s,y-59*s,2.8*s,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#f8ead3';ctx.beginPath();ctx.ellipse(x+39*s,y-48*s,12*s,8*s,0,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#303126';ctx.beginPath();ctx.arc(x+49*s,y-51*s,3*s,0,Math.PI*2);ctx.fill();
  ctx.strokeStyle='#6e4729';ctx.lineWidth=4*s;for(const dx of [-30,-4,24]){ctx.beginPath();ctx.moveTo(x+dx*s,y+34*s);ctx.lineTo(x+(dx-2)*s,y+68*s);ctx.stroke();}
  ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(x-46*s,y+5*s,11*s,0,Math.PI*2);ctx.fill();ctx.restore();
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
function drawGame(now,tuned,cents,singing){
  const w=canvas.clientWidth,h=canvas.clientHeight,cx=w/2,cy=h/2,r=Math.min(w,h)*.46;ctx.clearRect(0,0,w,h);ctx.fillStyle='#101812';ctx.fillRect(0,0,w,h);
  // The reticle stays fixed. Pitch pans the entire view: low notes aim below
  // the deer, high notes aim above it. This replaces the horizontal tuner.
  const desiredPan=travelStart||!singing?0:Math.max(-65,Math.min(65,cents))*(r*.72/65);
  scopePan+=(desiredPan-scopePan)*.18;
  ctx.save();ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.clip();
  ctx.save();ctx.translate(0,scopePan);
  const sky=ctx.createLinearGradient(0,cy-r*2,0,cy+r*2);sky.addColorStop(0,'#bfe6ed');sky.addColorStop(.57,'#eef6df');sky.addColorStop(.58,'#78a957');sky.addColorStop(1,'#3f753e');ctx.fillStyle=sky;ctx.fillRect(cx-r,cy-r*2,r*2,r*4);
  ctx.fillStyle='#758f79';ctx.beginPath();ctx.moveTo(cx-r,cy+30);ctx.lineTo(cx-r*.63,cy-r*.5);ctx.lineTo(cx-r*.35,cy-r*.15);ctx.lineTo(cx,cy-r*.72);ctx.lineTo(cx+r*.43,cy-r*.18);ctx.lineTo(cx+r*.7,cy-r*.5);ctx.lineTo(cx+r,cy+20);ctx.closePath();ctx.fill();
  ctx.fillStyle='#f7f8ef';ctx.beginPath();ctx.moveTo(cx-r*.63,cy-r*.5);ctx.lineTo(cx-r*.5,cy-r*.32);ctx.lineTo(cx-r*.35,cy-r*.15);ctx.lineTo(cx-r*.48,cy-r*.22);ctx.closePath();ctx.fill();ctx.beginPath();ctx.moveTo(cx,cy-r*.72);ctx.lineTo(cx+r*.18,cy-r*.42);ctx.lineTo(cx+r*.02,cy-r*.51);ctx.lineTo(cx-r*.12,cy-r*.37);ctx.closePath();ctx.fill();
  ctx.fillStyle='#4b8044';ctx.beginPath();ctx.ellipse(cx,cy+r*.68,r*1.25,r*.54,0,0,Math.PI*2);ctx.fill();
  const deerX=cx-10,deerY=cy+r*.22,s=Math.max(.66,Math.min(1.15,w/740));
  const p=travelStart?Math.min(1,(now-travelStart)/1400):0;
  if(!travelStart||p<.38)drawDeer(deerX,deerY,s,travelStart?Math.max(0,1-p/.38):1);
  if(travelStart&&p>.16)drawRainbow(deerX,deerY-5*s,s,Math.min(1,(p-.16)/.28));
  ctx.restore();
  for(let i=0;i<Math.min(score-(travelStart?1:0),8);i++)drawRainbow(cx-r*.78+i*r*.22,cy+r*.77,.18,.95);
  if(!travelStart)drawReticle(deerX,deerY,24,tuned,lift);
  if(travelStart&&p<.42){ctx.save();ctx.translate(cx,cy-r*.42);ctx.rotate(-.08);ctx.font=`${Math.round(48*s)}px Bree Serif`;ctx.textAlign='center';ctx.fillStyle='#c64035';ctx.strokeStyle='#fffdf4';ctx.lineWidth=7;ctx.strokeText('POW!',0,0);ctx.fillText('POW!',0,0);ctx.restore();}
  ctx.restore();
  ctx.strokeStyle='#d7c485';ctx.lineWidth=5;ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.stroke();ctx.strokeStyle='#0d1710';ctx.lineWidth=12;ctx.beginPath();ctx.arc(cx,cy,r+8,0,Math.PI*2);ctx.stroke();
}

function loop(now){
  analyze(now);
  const dt=Math.min(.1,(now-lastFrame)/1000);lastFrame=now;
  if(mode==='setup')updateSetup(now); else if(mode==='game')updateGame(now,dt);
  if(mode!=='welcome')requestAnimationFrame(loop);
}

$('startButton').addEventListener('click',()=>{ $('startButton').disabled=true; $('startButton').textContent='Opening microphone…'; startMicrophone(); });
$('skipButton').addEventListener('click',()=>{baseMidi=60;startGame();});
$('octaveButton').addEventListener('click',changeOctave);$('resetButton').addEventListener('click',resetGame);
$('helpButton').addEventListener('click',()=>$('helpDialog').showModal());$('closeHelp').addEventListener('click',()=>$('helpDialog').close());
window.addEventListener('resize',()=>{if(mode==='game')resizeCanvas();});
window.addEventListener('keydown',e=>{if(mode==='game'&&(e.key==='o'||e.key==='O'))changeOctave();if(mode==='game'&&(e.key==='r'||e.key==='R'))resetGame();});
