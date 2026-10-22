importScripts("phase.js");

const ALARM = "blockiny-phase";
const SCHED_PREFIX = "blockiny-sched:";
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SOUNDS = ["off", "white", "brown", "rain", "forest"];
const MAX_TOTAL_MIN = 1440;
const MAX_ALLOWED = 5;
const MAX_SITES = 50;
const MAX_SCHEDULES = 20;
const LOCK_HOURS = 24;
const GRACE_MS = 10 * 60 * 1000;

const END_MESSAGES = [
  "Session complete.",
  "Done for now.",
  "Focus block finished.",
  "Session finished."
];

function isInt(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}
function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
function dayKey(date = new Date()) { return date.toLocaleDateString("en-CA"); }

async function notify(title, message) {
  const { settings } = await chrome.storage.local.get("settings");
  if (settings && settings.notify === false) return;
  try {
    await chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message, priority: 1 });
  } catch {}
}

async function notifyPhase(session, phase) {
  if (phase.type === "break") {
    const minutes = Math.round((phase.end - phase.start) / 60000);
    await notify(`Round ${phase.cycle} done`, `${minutes}-minute break.`);
  } else if (phase.type === "focus") {
    await notify("Break over", `Round ${phase.cycle} of ${phase.cycles} starts now.`);
  }
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return contexts.length > 0;
}

async function syncSound() {
  try {
    const { session } = await chrome.storage.local.get("session");
    const wanted = session && session.sound && session.sound !== "off" && getPhase(session).type === "focus";
    if (wanted) {
      if (!(await hasOffscreen())) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["AUDIO_PLAYBACK"],
          justification: "Play the optional focus sound during focus rounds"
        });
      }
      await chrome.runtime.sendMessage({ target: "offscreen", type: "play", sound: session.sound, volume: session.volume ?? 0.4 });
    } else if (await hasOffscreen()) {
      await chrome.runtime.sendMessage({ target: "offscreen", type: "stop" });
    }
  } catch {}
}

function cleanSound(message) {
  const sound = SOUNDS.includes(message.sound) ? message.sound : "off";
  const volume = typeof message.volume === "number" && message.volume >= 0 && message.volume <= 1 ? message.volume : 0.4;
  return { sound, volume };
}

async function updateSession(mutator) {
  const { session } = await chrome.storage.local.get("session");
  if (!session) return null;
  mutator(session);
  await chrome.storage.local.set({ session });
  return session;
}

async function bumpDay(mutator) {
  const { stats } = await chrome.storage.local.get("stats");
  const data = stats || { days: {} };
  const key = dayKey();
  const day = Object.assign({ minutes: 0, sessions: 0, attempts: 0 }, data.days[key]);
  mutator(day);
  data.days[key] = day;
  const cutoff = Date.now() - 400 * 864e5;
  for (const k of Object.keys(data.days)) {
    if (new Date(k).getTime() < cutoff) delete data.days[k];
  }
  await chrome.storage.local.set({ stats: data });
}

function allowRule(item, index) {
  const host = String.raw`^https?://([a-z0-9-]+\.)*youtube\.com/`;
  const regexFilter = item.kind === "video"
    ? `${host}watch\\?(.*&)?v=${item.id}(&.*)?$`
    : `${host}(watch|playlist)\\?(.*&)?list=${item.id}(&.*)?$`;
  return {
    id: 1000 + index,
    priority: 2,
    action: { type: "allow" },
    condition: { regexFilter, isUrlFilterCaseSensitive: true, resourceTypes: ["main_frame"] }
  };
}

async function setRules(domains, allowed = []) {
  const oldRules = await chrome.declarativeNetRequest.getDynamicRules();
  const addRules = domains.map((domain, index) => ({
    id: index + 1,
    priority: 1,
    action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
    condition: { urlFilter: `||${domain}^`, resourceTypes: ["main_frame"] }
  }));
  if (domains.length) addRules.push(...allowed.map(allowRule));
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: oldRules.map(rule => rule.id), addRules });
}

async function endSession(completed) {
  const { session } = await chrome.storage.local.get("session");
  await setRules([]);
  await chrome.storage.local.remove("session");
  await chrome.alarms.clear(ALARM);
  await syncSound();
  if (!completed || !session) return;
  const s = normalizeSession(session);
  const minutes = Math.round((s.cycles * s.focusMs) / 60000);
  await bumpDay(day => { day.minutes += minutes; day.sessions += 1; });
  if (Date.now() - s.endsAt < 10 * 60000) {
    await notify(pick(END_MESSAGES), `${minutes} minutes logged.`);
  }
}

async function applyPhase() {
  const { session } = await chrome.storage.local.get("session");
  if (!session) {
    await setRules([]);
    await syncSound();
    return null;
  }
  const phase = getPhase(session);
  if (phase.type === "done") {
    await endSession(true);
    return null;
  }
  const key = `${phase.type}:${phase.cycle}`;
  if (session.phaseKey !== key) {
    const first = !session.phaseKey;
    await updateSession(s => { s.phaseKey = key; });
    if (!first && Date.now() - phase.start < 5 * 60000) await notifyPhase(session, phase);
  }
  const fresh = (await chrome.storage.local.get("session")).session;
  await setRules(phase.type === "focus" ? fresh.domains : [], fresh.allowed || []);
  await syncSound();
  chrome.alarms.create(ALARM, { when: phase.end + 500 });
  return fresh;
}

async function startSession(domains, config, goal, allowed, startedAt = Date.now(), extra = {}) {
  const total = config.cycles * config.focusMs + (config.cycles - 1) * config.breakMs;
  const session = {
    domains: [...domains], goal, allowed, startedAt,
    endsAt: startedAt + total,
    mode: config.mode,
    focusMs: config.focusMs,
    breakMs: config.breakMs,
    cycles: config.cycles,
    attempts: 0,
    sound: extra.sound || "off",
    volume: extra.volume ?? 0.4
  };
  const phase = getPhase(session);
  if (phase.type !== "done") session.phaseKey = `${phase.type}:${phase.cycle}`;
  await chrome.storage.local.set({ session });
  await applyPhase();
}

function buildConfig(message) {
  if (message.mode === "pomodoro") {
    const { focusMin, breakMin, cycles } = message;
    if (!isInt(focusMin, 1, 180) || !isInt(breakMin, 1, 60) || !isInt(cycles, 1, 12)) return null;
    const total = cycles * focusMin + (cycles - 1) * breakMin;
    if (total > MAX_TOTAL_MIN) return null;
    return { mode: "pomodoro", focusMs: focusMin * 60000, breakMs: breakMin * 60000, cycles };
  }
  if (!isInt(message.minutes, 1, MAX_TOTAL_MIN)) return null;
  return { mode: "custom", focusMs: message.minutes * 60000, breakMs: 0, cycles: 1 };
}

function validDomainList(domains) {
  return Array.isArray(domains) && domains.length > 0 && domains.length <= MAX_SITES && domains.every(domain => typeof domain === "string" && DOMAIN_RE.test(domain));
}

function cleanGoal(goal) {
  return typeof goal === "string" ? goal.trim().replace(/\s+/g, " ").slice(0, 120) : "";
}

function checkAllowed(allowed, domains) {
  if (!Array.isArray(allowed) || allowed.length > MAX_ALLOWED || !allowed.every(isValidAllowed)) return "Invalid allowed page.";
  if (allowed.length && !domains.includes("youtube.com")) return "Add youtube.com to the blocked sites first.";
  return null;
}

async function recordAttempt() {
  const { session } = await chrome.storage.local.get("session");
  if (!session || getPhase(session).type !== "focus") return;
  await updateSession(s => { s.attempts = (s.attempts || 0) + 1; });
  await bumpDay(day => { day.attempts += 1; });
}

async function getSchedules() {
  const { schedules } = await chrome.storage.local.get("schedules");
  return schedules || [];
}

function lockInfo(entry, now = Date.now()) {
  if (activeStart(entry, now)) return { deletable: false, reason: "Running now" };
  if (now - entry.createdAt < GRACE_MS) return { deletable: true };
  const next = nextStart(entry, now);
  if (next === null || next - now >= LOCK_HOURS * 3600000) return { deletable: true };
  return { deletable: false, reason: `Locked ${LOCK_HOURS}h before it starts` };
}

async function rescheduleAlarms(schedules) {
  const all = await chrome.alarms.getAll();
  for (const alarm of all) {
    if (alarm.name.startsWith(SCHED_PREFIX)) await chrome.alarms.clear(alarm.name);
  }
  for (const entry of schedules) {
    const when = nextStart(entry);
    if (when) chrome.alarms.create(SCHED_PREFIX + entry.id, { when: when + 1000 });
  }
}

async function runSchedules() {
  const schedules = await getSchedules();
  const now = Date.now();
  const { session } = await chrome.storage.local.get("session");
  let running = !!session;
  let changed = false;
  for (const entry of schedules) {
    const start = activeStart(entry, now);
    if (!start || entry.lastStart === start || running) continue;
    entry.lastStart = start;
    changed = true;
    running = true;
    const config = { mode: "custom", focusMs: entry.minutes * 60000, breakMs: 0, cycles: 1 };
    await startSession(entry.domains, config, entry.goal || "", entry.allowed || [], start);
    await notify("Scheduled session started", `${entry.minutes} minutes.`);
  }
  if (changed) await chrome.storage.local.set({ schedules });
  await rescheduleAlarms(schedules);
}

function validateSchedule(message) {
  const { days, time, minutes, domains } = message;
  if (!Array.isArray(days) || !days.length || !days.every(d => isInt(d, 0, 6)) || new Set(days).size !== days.length) return "Pick at least one day.";
  if (typeof time !== "string" || !TIME_RE.test(time)) return "Pick a start time.";
  if (!isInt(minutes, 1, MAX_TOTAL_MIN)) return "Pick between 1 and 1440 minutes.";
  if (!validDomainList(domains)) return "Add at least one site above.";
  return checkAllowed(Array.isArray(message.allowed) ? message.allowed : [], domains);
}

async function onStartup() {
  await runSchedules();
  await applyPhase();
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) applyPhase();
  else if (alarm.name.startsWith(SCHED_PREFIX)) runSchedules();
});
chrome.runtime.onStartup.addListener(onStartup);
chrome.runtime.onInstalled.addListener(onStartup);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.target === "offscreen") return false;
  (async () => {
    try {
      switch (message.type) {
        case "status": {
          await runSchedules();
          sendResponse({ session: await applyPhase() });
          return;
        }
        case "stats": {
          const { stats } = await chrome.storage.local.get("stats");
          sendResponse({ stats: stats || { days: {} } });
          return;
        }
        case "blockTab": {
          if (sender.tab && sender.tab.id != null) {
            await chrome.tabs.update(sender.tab.id, { url: chrome.runtime.getURL("blocked.html") });
          }
          sendResponse({ ok: true });
          return;
        }
        case "attempt": {
          await recordAttempt();
          sendResponse({ ok: true });
          return;
        }
        case "setSound": {
          const { sound, volume } = cleanSound(message);
          const updated = await updateSession(s => { s.sound = sound; s.volume = volume; });
          if (!updated) return sendResponse({ ok: false, error: "No session is running." });
          await syncSound();
          return sendResponse({ ok: true });
        }
        case "addSite": {
          const { session } = await chrome.storage.local.get("session");
          if (!session) return sendResponse({ ok: false, error: "No session is running." });
          if (typeof message.domain !== "string" || !DOMAIN_RE.test(message.domain)) return sendResponse({ ok: false, error: "Try something like reddit.com" });
          if (session.domains.includes(message.domain)) return sendResponse({ ok: true });
          if (session.domains.length >= MAX_SITES) return sendResponse({ ok: false, error: "Too many sites." });
          await updateSession(s => { s.domains.push(message.domain); });
          await applyPhase();
          return sendResponse({ ok: true });
        }
        case "start": {
          const { session } = await chrome.storage.local.get("session");
          if (session && Date.now() < normalizeSession(session).endsAt) return sendResponse({ ok: false, error: "A session is already running." });
          const config = buildConfig(message);
          if (!validDomainList(message.domains) || !config) return sendResponse({ ok: false, error: "Invalid input." });
          const allowed = Array.isArray(message.allowed) ? message.allowed : [];
          const problem = checkAllowed(allowed, message.domains);
          if (problem) return sendResponse({ ok: false, error: problem });
          await startSession(message.domains, config, cleanGoal(message.goal), allowed.map(({ kind, id }) => ({ kind, id })), Date.now(), cleanSound(message));
          return sendResponse({ ok: true });
        }
        case "listSchedules": {
          const now = Date.now();
          const list = (await getSchedules()).map(entry => ({
            id: entry.id, days: entry.days, time: entry.time, minutes: entry.minutes,
            domains: entry.domains, next: nextStart(entry, now), ...lockInfo(entry, now)
          }));
          return sendResponse({ schedules: list });
        }
        case "addSchedule": {
          const problem = validateSchedule(message);
          if (problem) return sendResponse({ ok: false, error: problem });
          const schedules = await getSchedules();
          if (schedules.length >= MAX_SCHEDULES) return sendResponse({ ok: false, error: "Too many scheduled sessions." });
          const allowed = Array.isArray(message.allowed) ? message.allowed : [];
          schedules.push({
            id: Date.now().toString(36), createdAt: Date.now(),
            days: [...message.days].sort(), time: message.time, minutes: message.minutes,
            domains: [...message.domains], goal: cleanGoal(message.goal),
            allowed: allowed.map(({ kind, id }) => ({ kind, id }))
          });
          await chrome.storage.local.set({ schedules });
          await runSchedules();
          return sendResponse({ ok: true });
        }
        case "deleteSchedule": {
          const schedules = await getSchedules();
          const entry = schedules.find(item => item.id === message.id);
          if (!entry) return sendResponse({ ok: true });
          const info = lockInfo(entry);
          if (!info.deletable) return sendResponse({ ok: false, error: info.reason });
          await chrome.storage.local.set({ schedules: schedules.filter(item => item.id !== message.id) });
          await runSchedules();
          return sendResponse({ ok: true });
        }
        default:
          return sendResponse({ ok: false, error: "Unknown request." });
      }
    } catch (error) {
      sendResponse({ ok: false, error: String(error) });
    }
  })();
  return true;
});
