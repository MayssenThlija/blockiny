let ctx = null;
let master = null;
let active = null;
let birdTimer = null;
let queue = Promise.resolve();
const FADE_IN = 2;

function bufferFor(c, type) {
  const data = generateNoise(type, c.sampleRate, 8);
  const buffer = c.createBuffer(1, data.length, c.sampleRate);
  buffer.copyToChannel(data, 0);
  return buffer;
}

function loopSource(c, type) {
  const source = c.createBufferSource();
  source.buffer = bufferFor(c, type);
  source.loop = true;
  return source;
}

function filter(c, type, frequency) {
  const node = c.createBiquadFilter();
  node.type = type;
  node.frequency.value = frequency;
  return node;
}

function chirp(c, dest) {
  const base = 2200 + Math.random() * 2200;
  const notes = 2 + Math.floor(Math.random() * 4);
  let t = c.currentTime + 0.05;
  for (let i = 0; i < notes; i++) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    const dur = 0.07 + Math.random() * 0.08;
    const f0 = base * (0.9 + Math.random() * 0.3);
    const f1 = f0 * (1.1 + Math.random() * 0.4);
    osc.type = "sine";
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.1, t + 0.012);
    gain.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    t += dur + 0.05 + Math.random() * 0.08;
  }
}

function scheduleBird(c, dest) {
  birdTimer = setTimeout(() => {
    if (ctx !== c) return;
    try { chirp(c, dest); } catch {}
    scheduleBird(c, dest);
  }, 1200 + Math.random() * 4500);
}

function lfo(c, hz, depth, target) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.frequency.value = hz;
  gain.gain.value = depth;
  osc.connect(gain);
  gain.connect(target);
  return osc;
}

function build(c, sound, out) {
  const sources = [];
  if (sound === "white" || sound === "brown") {
    const s = loopSource(c, sound);
    s.connect(out);
    sources.push(s);
  } else if (sound === "rain") {
    const s = loopSource(c, "rain");
    const hp = filter(c, "highpass", 350);
    const lp = filter(c, "lowpass", 8000);
    s.connect(hp); hp.connect(lp); lp.connect(out);
    sources.push(s);
  } else if (sound === "forest") {
    const wind = loopSource(c, "brown");
    const windLp = filter(c, "lowpass", 700);
    const windGain = c.createGain();
    windGain.gain.value = 0.65;
    wind.connect(windLp); windLp.connect(windGain); windGain.connect(out);
    sources.push(wind, lfo(c, 0.07, 0.3, windGain.gain));

    const leaves = loopSource(c, "white");
    const leavesBp = filter(c, "bandpass", 3200);
    const leavesGain = c.createGain();
    leavesGain.gain.value = 0.05;
    leaves.connect(leavesBp); leavesBp.connect(leavesGain); leavesGain.connect(out);
    sources.push(leaves, lfo(c, 0.13, 0.03, leavesGain.gain));
    scheduleBird(c, out);
  }
  sources.forEach(s => s.start());
  return sources;
}

function level(volume) {
  const v = Math.max(0, Math.min(1, Number(volume) || 0));
  return v * v * 0.9;
}

async function stopSound(fade = 1.5) {
  if (!ctx) return;
  const c = ctx, m = master, current = active;
  clearTimeout(birdTimer);
  ctx = null; master = null; active = null;
  const now = c.currentTime;
  m.gain.cancelScheduledValues(now);
  m.gain.setValueAtTime(m.gain.value, now);
  m.gain.linearRampToValueAtTime(0, now + fade);
  setTimeout(() => {
    if (current) current.sources.forEach(s => { try { s.stop(); } catch {} });
    c.close().catch(() => {});
  }, fade * 1000 + 150);
}

async function play(sound, volume) {
  if (active && active.sound === sound) {
    active.volume = volume;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(level(volume), ctx.currentTime, 0.2);
    return;
  }
  await stopSound(0.8);
  const c = new AudioContext();
  if (c.state === "suspended") await c.resume().catch(() => {});
  const m = c.createGain();
  m.gain.value = 0;
  m.connect(c.destination);
  ctx = c; master = m;
  try {
    const sources = build(c, sound, m);
    active = { sound, volume, sources };
  } catch {
    clearTimeout(birdTimer);
    ctx = null; master = null; active = null;
    c.close().catch(() => {});
    return;
  }
  m.gain.setValueAtTime(0, c.currentTime);
  m.gain.linearRampToValueAtTime(level(volume), c.currentTime + FADE_IN);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return false;
  queue = queue
    .then(() => (message.type === "play" ? play(message.sound, message.volume) : stopSound(1.5)))
    .catch(() => {})
    .then(() => sendResponse({ ok: true }));
  return true;
});
