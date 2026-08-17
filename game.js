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
let recentPitches = [], lastFrame = performance.now(), travelStart = 0;
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
  setupStage=0; setupAnchor=0; setupAccepted=[]; setupReadyAt=performance.now()+500;
  document.querySelectorAll('.setup-note').forEach((el,i)=>{el.className='setup-note'+(i===0?' active':'');});
  $('setupPrompt').textContent='Sing any comfortable DO'; $('setupFeedback').textContent='Listening…';
  show('setup'); requestAnimationFrame(loop);
}
function updateSetup(now){
  const singing=latest.pitch>0&&latest.volume>=.008&&latest.confidence>.55;
  let error=0, correct=setupStage===0;
  if(setupStage>0&&setupAnchor&&singing){
    const wanted=setupAnchor*2**([0,2,4][setupStage]/12);
    error=1200*Math.log2(latest.pitch/wanted); correct=Math.abs(error)<=35;
  }
  if(!singing) $('setupFeedback').textContent='Listening…';
  else if(!correct) $('setupFeedback').textContent=error<0?'A little higher ↑':'A little lower ↓';
  else $('setupFeedback').textContent='Got it!';
  if(now>=setupReadyAt&&singing&&correct){
    setupAccepted.push(latest.pitch); if(setupStage===0) setupAnchor=latest.pitch;
    document.querySelector(`[data-stage="${setupStage}"]`).className='setup-note done'; setupStage++;
    if(setupStage===3){
      const rootMidis=setupAccepted.map((hz,i)=>69+12*Math.log2(hz/440)-[0,2,4][i]);
      const estimated=rootMidis.reduce((a,b)=>a+b,0)/rootMidis.length;
      baseMidi=Math.max(36,Math.min(72,Math.round((estimated-4)/12)*12));
      $('setupPrompt').textContent='Voice setup complete!';
      $('setupFeedback').textContent=`Your range: ${noteName(baseMidi)}–${noteName(baseMidi+12)}`;
      setTimeout(startGame,900); return;
    }
    const el=document.querySelector(`[data-stage="${setupStage}"]`); el.classList.add('active');
    $('setupPrompt').textContent=`Now hit ${SOLFEGE[setupStage]}`;
    setupReadyAt=now+650;
  }
}

function startGame(){
  level=0; lift=0; score=0; streak=0; travelStart=0; recentPitches=[];
  updateLabels(); show('game'); resizeCanvas(); lastFrame=performance.now();
}
function updateLabels(){
  $('score').textContent=score; $('streak').textContent=streak;
  $('solfege').textContent=SOLFEGE[level]; $('noteName').textContent=noteName(baseMidi+OFFSETS[level]);
}
function resetGame(){ level=0;lift=0;score=0;streak=0;travelStart=0;recentPitches=[];updateLabels();$('gameMessage').textContent='Sing and hold the target note'; }
function changeOctave(){ baseMidi=baseMidi>=72?48:baseMidi+12;lift=0;travelStart=0;recentPitches=[];updateLabels();$('gameMessage').textContent=`Octave changed to ${noteName(baseMidi)}`; }

function updateGame(now,dt){
  if(latest.pitch>0){ recentPitches.push(latest.pitch); if(recentPitches.length>5)recentPitches.shift(); }
  else if(latest.volume<.008) recentPitches=[];
  const pitch=median(recentPitches), target=midiFrequency(baseMidi+OFFSETS[level]);
  const cents=pitch>0?1200*Math.log2(pitch/target):null;
  const singing=pitch>0&&latest.volume>=.008&&latest.confidence>.5;
  const tuned=singing&&Math.abs(cents)<=22, near=singing&&Math.abs(cents)<=50;
  const needle=$('needle');
  needle.classList.toggle('hidden',!singing);
  if(singing){ needle.style.left=`${Math.max(0,Math.min(100,cents+50))}%`; needle.classList.toggle('tuned',tuned); $('pitchReadout').textContent=`${cents>=0?'+':''}${Math.round(cents)} cents`; }
  else $('pitchReadout').textContent=`Sing ${SOLFEGE[level]}`;
  if(!travelStart){
    if(tuned){ lift=Math.min(1,lift+dt/HOLD_SECONDS); $('gameMessage').textContent='Perfect — keep holding!'; }
    else if(near){ lift=Math.max(0,lift-dt*.12); $('gameMessage').textContent=cents<0?'Just a little higher ↑':'Just a little lower ↓'; }
    else { lift=Math.max(0,lift-dt*.48); $('gameMessage').textContent=singing?(cents<0?'Sing higher ↑':'Sing lower ↓'):`Listening… sing ${SOLFEGE[level]}`; }
    if(lift>=1){ score+=100+streak*20;streak++;travelStart=now;updateLabels();$('gameMessage').textContent=level<7?`Through! Moving to ${SOLFEGE[level+1]}…`:'Scale complete!'; }
  } else if(now-travelStart>=1000){
    travelStart=0;lift=0;recentPitches=[];level++;
    if(level>=8){level=0;score+=500;$('gameMessage').textContent='Scale complete! Back to DO';}
    else $('gameMessage').textContent=`Next note: ${SOLFEGE[level]}`;
    updateLabels();
  }
  $('holdFill').style.width=`${lift*100}%`;
  drawGame(now,tuned);
}

const canvas=$('gameCanvas'), ctx=canvas.getContext('2d');
function resizeCanvas(){
  const rect=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);
  canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);
}
function drawStar(x,y,r,fill){
  ctx.beginPath();for(let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5,rr=i%2?r*.45:r;ctx.lineTo(x+Math.cos(a)*rr,y+Math.sin(a)*rr);}ctx.closePath();ctx.fillStyle=fill;ctx.shadowColor=fill;ctx.shadowBlur=22;ctx.fill();ctx.shadowBlur=0;
}
function drawGame(now,tuned){
  const w=canvas.clientWidth,h=canvas.clientHeight;ctx.clearRect(0,0,w,h);
  const sky=ctx.createLinearGradient(0,0,0,h);sky.addColorStop(0,'#2b2059');sky.addColorStop(1,'#15102e');ctx.fillStyle=sky;ctx.fillRect(0,0,w,h);
  ctx.fillStyle='#ffffff20';for(let i=0;i<24;i++){const x=(i*83%997)/997*w,y=(i*137%701)/701*h;ctx.fillRect(x,y,1.4,1.4);}
  const margin=Math.max(28,w*.055), hoopY=74, floorY=h-42;
  const centers=OFFSETS.map((_,i)=>margin+i*(w-2*margin)/7);
  ctx.textAlign='center';ctx.font=`700 ${w<500?10:12}px DM Sans`;ctx.lineWidth=4;
  centers.forEach((x,i)=>{
    ctx.strokeStyle=i<level?'#62edc1':i===level?'#ffd568':'#675d89';ctx.shadowColor=i===level?'#ffd568':'transparent';ctx.shadowBlur=i===level?15:0;
    ctx.beginPath();ctx.arc(x,hoopY,Math.max(13,Math.min(21,w/38)),0,Math.PI*2);ctx.stroke();ctx.shadowBlur=0;
    ctx.fillStyle=i===level?'#ffd568':'#938ba9';ctx.fillText(SOLFEGE[i],x,hoopY-31);
    if(i<level){ctx.fillStyle='#62edc1';ctx.fillText('✓',x,hoopY+4);}
  });
  let ballX=centers[level], ballY=floorY-(floorY-hoopY)*lift;
  if(travelStart){const p=Math.min(1,(now-travelStart)/1000),ease=1-(1-p)**3;ballY=hoopY;if(level<7)ballX=centers[level]+(centers[level+1]-centers[level])*ease;}
  if(!travelStart){ctx.setLineDash([4,8]);ctx.strokeStyle='#8e82ae55';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(ballX,floorY);ctx.lineTo(ballX,hoopY);ctx.stroke();ctx.setLineDash([]);}
  ctx.strokeStyle='#564c78';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(18,floorY+18);ctx.lineTo(w-18,floorY+18);ctx.stroke();
  drawStar(ballX,ballY,w<500?12:15,travelStart||tuned?'#62edc1':'#ff65b3');
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
