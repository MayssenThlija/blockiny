function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seamless(raw, loopLen, fade) {
  const out = new Float32Array(loopLen);
  for (let i = 0; i < loopLen; i++) out[i] = raw[i];
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    out[i] = raw[i] * t + raw[loopLen + i] * (1 - t);
  }
  return out;
}

function normalizeRms(data, target) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  const rms = Math.sqrt(sum / data.length) || 1;
  const gain = target / rms;
  for (let i = 0; i < data.length; i++) data[i] = Math.max(-1, Math.min(1, data[i] * gain));
  return data;
}

function generateNoise(type, sampleRate, seconds = 8) {
  const rand = makeRandom(type === "rain" ? 7 : type === "brown" ? 3 : 11);
  const fade = Math.floor(sampleRate * 0.5);
  const loopLen = Math.floor(sampleRate * seconds);
  const raw = new Float32Array(loopLen + fade);

  if (type === "brown") {
    let last = 0;
    for (let i = 0; i < raw.length; i++) {
      last = (last + 0.02 * (rand() * 2 - 1)) / 1.02;
      raw[i] = last;
    }
    return normalizeRms(seamless(raw, loopLen, fade), 0.22);
  }

  if (type === "rain") {
    for (let i = 0; i < raw.length; i++) raw[i] = (rand() * 2 - 1) * 0.5;
    const addDrops = (perSecond, minAmp, maxAmp, minHz, maxHz, ms) => {
      const count = Math.floor(perSecond * raw.length / sampleRate);
      const len = Math.floor(sampleRate * ms / 1000);
      for (let n = 0; n < count; n++) {
        const start = Math.floor(rand() * (raw.length - len));
        const amp = minAmp + rand() * (maxAmp - minAmp);
        const hz = minHz + rand() * (maxHz - minHz);
        for (let i = 0; i < len; i++) {
          raw[start + i] += amp * Math.exp(-6 * i / len) * Math.sin(2 * Math.PI * hz * i / sampleRate);
        }
      }
    };
    addDrops(350, 0.05, 0.25, 2500, 7000, 4);
    addDrops(45, 0.25, 0.8, 1500, 4500, 10);
    return normalizeRms(seamless(raw, loopLen, fade), 0.2);
  }

  for (let i = 0; i < raw.length; i++) raw[i] = rand() * 2 - 1;
  return normalizeRms(seamless(raw, loopLen, fade), 0.2);
}
