// Blockiny popup. This file only handles the UI; the real blocking is in background.js.

const $ = id => document.getElementById(id);

// Default suggestions. If history access is allowed, your most visited sites get added to these.
const POPULAR = [
  "youtube.com", "instagram.com", "tiktok.com", "facebook.com", "x.com", "twitter.com",
  "reddit.com", "netflix.com", "twitch.tv", "snapchat.com", "pinterest.com", "linkedin.com",
  "discord.com", "9gag.com", "tumblr.com", "threads.net", "kick.com", "crunchyroll.com",
  "disneyplus.com", "primevideo.com", "spotify.com", "web.whatsapp.com", "amazon.com", "ebay.com"
];

// Study and work sites that should not show up as suggestions.
const IGNORE = [
  /moodle/, /canvas/, /blackboard/, /ilias/, /classroom\.google/, /\.edu$/, /\.ac\.[a-z]{2}$/,
  /brightspace/, /schoology/, /docs\.google/, /drive\.google/, /mail\.google/, /scholar\.google/,
  /overleaf/, /notion\.so$/, /zoom\.us$/, /teams\.microsoft/, /outlook\./, /github\.com$/, /stackoverflow\.com$/
];
const isIgnored = d => IGNORE.some(re => re.test(d));
let hidden = []; // sites the user chose to never see again (saved in chrome.storage)

let chips = [];               // domains the user has picked
let candidates = [...POPULAR]; // everything we can suggest
let activeIndex = -1;         // keyboard-highlighted suggestion
let armed = false, armTimer;  // two-tap confirmation state

/* ---------- helpers ---------- */

// "https://www.YouTube.com/watch?v=1" -> "youtube.com"; returns null if it's not a valid domain.
function cleanDomain(raw) {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return DOMAIN_RE.test(d) ? d : null;
}

function fmtDuration(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}

function showError(text) { $("error").textContent = text || ""; }

function chipEl(domain, removable) {
  const el = document.createElement("span");
  el.className = "chip";
  el.append(domain);
  if (removable) {
    const x = document.createElement("button");
    x.type = "button"; x.textContent = "×"; x.title = "Remove";
    x.addEventListener("click", () => { chips = chips.filter(c => c !== domain); renderChips(); });
    el.append(x);
  }
  return el;
}

/* ---------- chips + suggestions ---------- */

function renderChips() {
  $("chips").replaceChildren(...chips.map(d => chipEl(d, true)));
}

function addChip(domain) {
  if (!chips.includes(domain)) chips.push(domain);
  $("siteInput").value = "";
  showError("");
  renderChips();
  renderSuggestions();
}

// What the user typed, without "https://" or "www."
function getQuery() {
  return $("siteInput").value.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
}

function getMatches() {
  const q = getQuery();
  if (!q) return [];
  const hits = candidates.filter(d => d.includes(q) && !chips.includes(d));
  // starts-with matches first, then "contains" matches
  hits.sort((a, b) => (b.startsWith(q) - a.startsWith(q)));
  return hits.slice(0, 5);
}

function renderSuggestions() {
  const list = $("suggestions");
  const q = getQuery();
  const matches = getMatches();
  activeIndex = matches.length ? 0 : -1;
  list.hidden = matches.length === 0;
  list.replaceChildren(...matches.map((d, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    if (i === activeIndex) b.classList.add("active");
    // highlight the part you typed
    const at = d.indexOf(q);
    b.append(d.slice(0, at));
    const mark = document.createElement("mark");
    mark.textContent = d.slice(at, at + q.length);
    b.append(mark, d.slice(at + q.length));
    b.classList.add("pick");
    b.addEventListener("click", () => addChip(d));
    const hide = document.createElement("button");
    hide.type = "button"; hide.className = "hide"; hide.textContent = "hide"; hide.title = "Never suggest this site again";
    hide.addEventListener("click", () => hideSuggestion(d));
    li.append(b, hide);
    return li;
  }));
}

function moveActive(step) {
  const btns = [...$("suggestions").querySelectorAll(".pick")];
  if (!btns.length) return;
  activeIndex = (activeIndex + step + btns.length) % btns.length;
  btns.forEach((b, i) => b.classList.toggle("active", i === activeIndex));
}

function commitTyped() {
  const btns = [...$("suggestions").querySelectorAll(".pick")];
  if (activeIndex >= 0 && btns[activeIndex]) { btns[activeIndex].click(); return; }
  const raw = $("siteInput").value;
  if (!raw.trim()) return;
  const d = cleanDomain(raw);
  if (d) addChip(d); else showError("Try something like youtube.com");
}

$("siteInput").addEventListener("input", () => { showError(""); renderSuggestions(); });
$("siteInput").addEventListener("keydown", e => {
  if (e.key === "ArrowDown") { e.preventDefault(); moveActive(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moveActive(-1); }
  else if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commitTyped(); }
  else if (e.key === "Backspace" && !e.target.value && chips.length) { chips.pop(); renderChips(); }
});
$("field").addEventListener("click", () => $("siteInput").focus());

// Suggestions = popular sites, plus the most visited sites if the user allowed history access.
// History is only read on this device to count visits per site. It is never stored or sent anywhere.
async function loadCandidates() {
  const stored = await chrome.storage.local.get("hiddenSites");
  hidden = stored.hiddenSites || [];
  const hasHistory = await chrome.permissions.contains({ permissions: ["history"] });
  $("historyBtn").hidden = hasHistory;
  $("historyNote").hidden = hasHistory;
  let top = [];
  if (hasHistory) {
    try {
      const items = await chrome.history.search({ text: "", maxResults: 500, startTime: Date.now() - 30 * 864e5 });
      const counts = {};
      for (const it of items) {
        let host;
        try { host = new URL(it.url).hostname.replace(/^www\./, ""); } catch { continue; }
        if (!DOMAIN_RE.test(host) || /^\d+(\.\d+)+$/.test(host)) continue; // skip junk and IP addresses
        if (isIgnored(host)) continue;
        counts[host] = (counts[host] || 0) + (it.visitCount || 1);
      }
      top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 40).map(e => e[0]);
    } catch (err) {
      console.warn("Could not read history:", err);
    }
  }
  candidates = [...new Set([...top, ...POPULAR])].filter(d => !hidden.includes(d));
}

$("historyBtn").addEventListener("click", async () => {
  // Has to run straight from the click, Chrome only shows the prompt after a user action.
  // If the popup closes when the prompt appears, just reopen it.
  const granted = await chrome.permissions.request({ permissions: ["history"] });
  if (!granted) return;
  await loadCandidates();
  renderSuggestions();
});

async function hideSuggestion(domain) {
  hidden.push(domain);
  await chrome.storage.local.set({ hiddenSites: hidden });
  candidates = candidates.filter(d => d !== domain);
  renderSuggestions();
}

/* ---------- duration ---------- */

function syncPresets() {
  const v = Number($("minutes").value);
  document.querySelectorAll("#presets button").forEach(b => b.classList.toggle("on", Number(b.dataset.min) === v));
}
$("presets").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  $("minutes").value = b.dataset.min;
  syncPresets(); disarm();
});
$("minutes").addEventListener("input", () => { syncPresets(); showError(""); disarm(); });

/* ---------- allowed YouTube pages ---------- */

let allowed = [];

function parseYouTube(raw) {
  let url;
  try { url = new URL(raw.trim()); } catch { return { error: "That is not a full link." }; }
  const host = url.hostname.replace(/^www\./, "").replace(/^m\./, "");
  let video = null;
  if (host === "youtu.be") video = url.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" && url.pathname === "/watch") video = url.searchParams.get("v");
  else if (host !== "youtube.com") return { error: "Only YouTube links are supported." };
  const list = host === "youtube.com" && ["/watch", "/playlist"].includes(url.pathname) ? url.searchParams.get("list") : null;
  const items = [];
  if (list && PLAYLIST_ID_RE.test(list) && !list.startsWith("RD")) items.push({ kind: "playlist", id: list });
  if (video && VIDEO_ID_RE.test(video)) items.push({ kind: "video", id: video });
  if (!items.length) {
    return { error: list && list.startsWith("RD") ? "Auto-generated mixes are not allowed." : "Use a video or playlist link." };
  }
  return { items };
}
function allowLabel(item) { return `${item.kind} ${item.id.length > 12 ? item.id.slice(0, 12) + "…" : item.id}`; }
function renderAllowed() {
  $("allowChips").replaceChildren(...allowed.map(item => {
    const el = chipEl(allowLabel(item), true);
    el.querySelector("button").addEventListener("click", () => {
      allowed = allowed.filter(x => !(x.kind === item.kind && x.id === item.id));
      renderAllowed();
    });
    return el;
  }));
}
function commitAllow() {
  const raw = $("allowInput").value;
  if (!raw.trim()) return true;
  const result = parseYouTube(raw);
  if (result.error) { $("allowError").textContent = result.error; return false; }
  for (const item of result.items) {
    if (allowed.some(x => x.kind === item.kind && x.id === item.id)) continue;
    if (allowed.length >= 5) { $("allowError").textContent = "You can allow up to 5 pages."; return false; }
    allowed.push(item);
  }
  $("allowInput").value = "";
  $("allowError").textContent = "";
  renderAllowed();
  return true;
}
$("allowAdd").addEventListener("click", commitAllow);
$("allowInput").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); commitAllow(); } });
$("allowInput").addEventListener("input", () => { $("allowError").textContent = ""; disarm(); });

/* ---------- full page ---------- */

const isFull = new URLSearchParams(location.search).has("full");
if (isFull) {
  document.body.classList.add("full");
  $("openFull").hidden = true;
}
$("openFull").addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?full=1") });
  window.close();
});

/* ---------- modes, pomodoro ---------- */

let mode = "custom";
let pomo = { focus: 25, brk: 5 };

function cycles() { return Number($("cycles").value); }
function pomoTotal() { return cycles() * pomo.focus + (cycles() - 1) * pomo.brk; }
function renderPomoSummary() {
  const n = cycles();
  if (!Number.isInteger(n) || n < 1 || n > 12) { $("pomoSummary").textContent = "Pick 1 to 12 rounds."; return; }
  $("pomoSummary").textContent = `${n} x ${pomo.focus}m focus, ${pomo.brk}m breaks. Total ${fmtDuration(pomoTotal())}. Sites unlock during breaks.`;
}
function setMode(next) {
  mode = next;
  document.querySelectorAll("#modes button").forEach(b => b.classList.toggle("on", b.dataset.mode === mode));
  $("customCard").hidden = mode !== "custom";
  $("pomoCard").hidden = mode !== "pomodoro";
  renderPomoSummary(); showError(""); disarm();
}
$("modes").addEventListener("click", e => { const b = e.target.closest("button"); if (b) setMode(b.dataset.mode); });
$("pomoPresets").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  pomo = { focus: Number(b.dataset.focus), brk: Number(b.dataset.break) };
  document.querySelectorAll("#pomoPresets button").forEach(x => x.classList.toggle("on", x === b));
  renderPomoSummary(); disarm();
});
$("cycles").addEventListener("input", () => { renderPomoSummary(); showError(""); disarm(); });

/* ---------- stats and weekly chart ---------- */

async function loadStats() {
  const res = await chrome.runtime.sendMessage({ type: "stats" });
  const days = (res && res.stats && res.stats.days) || {};
  const today = new Date();
  const get = d => Object.assign({ minutes: 0, sessions: 0, attempts: 0 }, days[dayKey(d)]);
  const t = get(today);

  const week = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    week.push({ date: d, ...get(d), isToday: i === 0 });
  }
  const weekMinutes = week.reduce((sum, d) => sum + d.minutes, 0);
  const weekAttempts = week.reduce((sum, d) => sum + d.attempts, 0);
  const max = Math.max(30, ...week.map(d => d.minutes));

  let streak = 0;
  const cur = new Date(today);
  if (!t.sessions) cur.setDate(cur.getDate() - 1);
  while (get(cur).sessions > 0) { streak++; cur.setDate(cur.getDate() - 1); }

  $("statToday").textContent = fmtDuration(t.minutes);
  $("statStreak").textContent = String(streak);
  $("statTotal").textContent = fmtDuration(weekMinutes);

  $("chart").replaceChildren(...week.map(d => {
    const col = document.createElement("div");
    col.className = "bar-col";
    const label = d.date.toLocaleDateString([], { weekday: "short" });
    col.title = `${label}: ${fmtDuration(d.minutes)}`;
    const value = document.createElement("span");
    value.className = "bar-val";
    value.textContent = d.minutes ? fmtDuration(d.minutes) : "";
    const track = document.createElement("div");
    track.className = "bar-track";
    const bar = document.createElement("div");
    bar.className = "bar" + (d.isToday ? " today" : "") + (d.minutes ? "" : " empty");
    bar.style.height = d.minutes ? `${Math.max(6, Math.round(d.minutes / max * 100))}%` : "";
    track.append(bar);
    const name = document.createElement("span");
    name.className = "bar-label";
    name.textContent = label;
    col.append(value, track, name);
    return col;
  }));
  $("chartCaption").textContent = `${weekAttempts} blocked attempt${weekAttempts === 1 ? "" : "s"} in the last 7 days`;
}

/* ---------- weekly schedule ---------- */

const DAY_NAMES = { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" };
const schedDays = new Set([1, 2, 3, 4, 5]);

$("schedDays").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  const day = Number(b.dataset.day);
  if (schedDays.has(day)) schedDays.delete(day); else schedDays.add(day);
  b.classList.toggle("on", schedDays.has(day));
  $("schedError").textContent = "";
});

function dayOrder(days) { return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); }

async function loadSchedules() {
  const res = await chrome.runtime.sendMessage({ type: "listSchedules" });
  const list = (res && res.schedules) || [];
  $("schedList").replaceChildren(...list.map(entry => {
    const li = document.createElement("li");
    const text = document.createElement("div");
    const title = document.createElement("span");
    title.textContent = `${dayOrder(entry.days).map(d => DAY_NAMES[d]).join(" ")} · ${entry.time} · ${fmtDuration(entry.minutes)}`;
    const sub = document.createElement("small");
    const next = entry.next ? new Date(entry.next).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "";
    sub.textContent = `${entry.domains.join(", ")}${next ? " · next " + next : ""}`;
    text.append(title, sub);
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Delete";
    del.disabled = !entry.deletable;
    del.title = entry.deletable ? "Delete this schedule" : entry.reason;
    del.addEventListener("click", async () => {
      const result = await chrome.runtime.sendMessage({ type: "deleteSchedule", id: entry.id });
      $("schedError").textContent = result.ok ? "" : result.error;
      loadSchedules();
    });
    li.append(text, del);
    return li;
  }));
}

$("schedAdd").addEventListener("click", async () => {
  $("schedError").textContent = "";
  if ($("siteInput").value.trim()) commitTyped();
  if (!commitAllow()) { $("schedError").textContent = "Fix the allowed page first."; return; }
  const goal = cleanGoal($("goal").value);
  const res = await chrome.runtime.sendMessage({
    type: "addSchedule", days: [...schedDays], time: $("schedTime").value,
    minutes: Number($("schedMinutes").value), domains: chips, goal, allowed
  });
  if (!res.ok) { $("schedError").textContent = res.error || "Could not add."; return; }
  loadSchedules();
  init();
});

/* ---------- notifications setting ---------- */

async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  $("notifyToggle").checked = !settings || settings.notify !== false;
}
$("notifyToggle").addEventListener("change", async () => {
  const { settings } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...(settings || {}), notify: $("notifyToggle").checked } });
});

/* ---------- start (two taps = confirmation) ---------- */

function disarm() {
  armed = false; clearTimeout(armTimer);
  $("start").classList.remove("armed");
  $("start").textContent = "Block. No undo.";
}

$("start").addEventListener("click", async () => {
  if ($("siteInput").value.trim()) commitTyped();
  const goal = cleanGoal($("goal").value);
  if (!commitAllow()) return showError("Fix the allowed page first.");
  if (!chips.length) return showError("Add at least one site.");
  if (allowed.length && !chips.includes("youtube.com")) return showError("Add youtube.com to the blocked sites first.");

  let payload, totalMinutes;
  if (mode === "pomodoro") {
    const n = cycles();
    if (!Number.isInteger(n) || n < 1 || n > 12) return showError("Pick 1 to 12 rounds.");
    totalMinutes = pomoTotal();
    if (totalMinutes > 1440) return showError("That is longer than 24 hours.");
    payload = { mode: "pomodoro", focusMin: pomo.focus, breakMin: pomo.brk, cycles: n };
  } else {
    const minutes = Number($("minutes").value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return showError("Pick between 1 and 1440 minutes.");
    totalMinutes = minutes;
    payload = { mode: "custom", minutes };
  }

  if (!armed) {
    armed = true;
    $("start").classList.add("armed");
    $("start").textContent = `Tap again: locked for ${fmtDuration(totalMinutes)}`;
    armTimer = setTimeout(disarm, 4000);
    return;
  }
  disarm();
  const res = await chrome.runtime.sendMessage({
    type: "start", domains: chips, goal, allowed,
    sound: $("sound").value, volume: Number($("volume").value) / 100, ...payload
  });
  if (!res.ok) return showError(res.error || "Something went wrong.");
  init();
});

/* ---------- locked view ---------- */

const RING = 326.73;
let timer;

async function addSiteLive() {
  const domain = cleanDomain($("lockedSite").value);
  if (!domain) { $("lockedError").textContent = "Try something like reddit.com"; return; }
  const res = await chrome.runtime.sendMessage({ type: "addSite", domain });
  if (!res.ok) { $("lockedError").textContent = res.error || "Could not add."; return; }
  $("lockedSite").value = "";
  $("lockedError").textContent = "";
  init();
}
$("lockedSiteAdd").addEventListener("click", addSiteLive);
$("lockedSite").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addSiteLive(); } });

function sendSound() {
  chrome.runtime.sendMessage({ type: "setSound", sound: $("lockedSound").value, volume: Number($("lockedVolume").value) / 100 });
}
$("lockedSound").addEventListener("change", sendSound);
$("lockedVolume").addEventListener("change", sendSound);

function showLocked(session) {
  $("setup").hidden = true;
  $("locked").hidden = false;
  $("lockedList").replaceChildren(...session.domains.map(d => chipEl(d, false)));
  const sessionAllowed = session.allowed || [];
  $("lockedAllowedTitle").hidden = !sessionAllowed.length;
  $("lockedAllowed").replaceChildren(...sessionAllowed.map(item => chipEl(allowLabel(item), false)));
  const attempts = session.attempts || 0;
  $("lockedAttempts").textContent = attempts ? `Distractions stopped this session: ${attempts}` : "";
  if (document.activeElement !== $("lockedSound")) $("lockedSound").value = session.sound || "off";
  if (document.activeElement !== $("lockedVolume")) $("lockedVolume").value = String(Math.round((session.volume ?? 0.4) * 100));
  const goal = (session.goal || "").trim();
  $("lockedGoal").hidden = !goal;
  $("lockedGoal").textContent = goal ? `Goal: ${goal}` : "";
  const pomodoro = normalizeSession(session).mode === "pomodoro";

  const tick = () => {
    const phase = getPhase(session);
    if (phase.type === "done") { clearInterval(timer); return init(); }
    const total = phase.end - phase.start;
    const left = Math.max(0, phase.end - Date.now());
    $("countdown").textContent = formatClock(left);
    $("ringFg").style.strokeDashoffset = String(RING * (1 - left / total));
    if (phase.type === "break") {
      $("phaseLabel").textContent = "break";
      $("lockedMsg").textContent = "Sites are unlocked for now.";
      $("ringFg").style.stroke = "#2f9e6b";
    } else {
      $("phaseLabel").textContent = pomodoro ? `focus ${phase.cycle}/${phase.cycles}` : "remaining";
      $("lockedMsg").textContent = "Stay with your task.";
      $("ringFg").style.stroke = "";
    }
  };
  tick();
  clearInterval(timer);
  timer = setInterval(tick, 1000);
}

async function init() {
  const { session } = await chrome.runtime.sendMessage({ type: "status" });
  if (session) showLocked(session);
  else {
    $("setup").hidden = false;
    $("locked").hidden = true;
    $("siteInput").focus();
    loadStats();
    loadSchedules();
  }
}

syncPresets();
renderPomoSummary();
loadSettings();
loadCandidates();
init();
