importScripts("phase.js");

const ALARM = "blockiny-phase";
const SCHED_PREFIX = "blockiny-sched:";
const BLOCKINY_DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
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

// All background events use this queue to avoid overlapping updates.
let operationQueue = Promise.resolve();

function enqueueOperation(operation) {
  const task = operationQueue.then(operation);
  operationQueue = task.catch(() => {});
  return task;
}

function reportError(error) {
  console.error("Blockiny background error:", error);
}

function isInt(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/* ---------- notifications ---------- */

async function notify(title, message) {
  const { settings } = await chrome.storage.local.get("settings");

  if (settings && settings.notify === false) return;

  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
      priority: 1
    });
  } catch (error) {
    console.warn("Blockiny notification failed:", error);
  }
}

async function notifyPhase(session, phase) {
  if (phase.type === "break") {
    const minutes = Math.round((phase.end - phase.start) / 60000);

    await notify(
      `Round ${phase.cycle} done`,
      `${minutes}-minute break.`
    );
  } else if (phase.type === "focus") {
    await notify(
      "Break over",
      `Round ${phase.cycle} of ${phase.cycles} starts now.`
    );
  }
}

/* ---------- sound ---------- */

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });

  return contexts.length > 0;
}

async function syncSound() {
  try {
    const { session } = await chrome.storage.local.get("session");

    const wanted =
      session &&
      session.sound &&
      session.sound !== "off" &&
      getPhase(session).type === "focus";

    if (wanted) {
      if (!(await hasOffscreen())) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["AUDIO_PLAYBACK"],
          justification:
            "Play the optional focus sound during focus rounds"
        });
      }

      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "play",
        sound: session.sound,
        volume: session.volume ?? 0.4
      });
    } else if (await hasOffscreen()) {
      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "stop"
      });
    }
  } catch (error) {
    console.warn("Blockiny sound update failed:", error);
  }
}

function cleanSound(message) {
  const sound = SOUNDS.includes(message.sound)
    ? message.sound
    : "off";

  const volume =
    typeof message.volume === "number" &&
    Number.isFinite(message.volume) &&
    message.volume >= 0 &&
    message.volume <= 1
      ? message.volume
      : 0.4;

  return { sound, volume };
}

/* ---------- session storage ---------- */

async function updateSession(mutator) {
  const { session } = await chrome.storage.local.get("session");

  if (!session) return null;

  mutator(session);

  await chrome.storage.local.set({ session });
  return session;
}

/* ---------- statistics ---------- */

function nonNegativeNumber(value) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : 0;
}

function statsDay(data, key) {
  const existing = data.days[key] || {};

  const day = {
    ...existing,
    minutes: nonNegativeNumber(existing.minutes),
    sessions: nonNegativeNumber(existing.sessions),
    attempts: nonNegativeNumber(existing.attempts)
  };

  data.days[key] = day;
  return day;
}

async function changeStats(mutator) {
  const { stats } = await chrome.storage.local.get("stats");

  const data =
    stats && typeof stats === "object" && !Array.isArray(stats)
      ? stats
      : { days: {} };

  if (
    !data.days ||
    typeof data.days !== "object" ||
    Array.isArray(data.days)
  ) {
    data.days = {};
  }

  mutator(data);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 400);
  cutoff.setHours(0, 0, 0, 0);

  for (const key of Object.keys(data.days)) {
    // Only prune keys whose YYYY-MM-DD format is explicit.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;

    const date = new Date(`${key}T00:00:00`);

    if (Number.isFinite(date.getTime()) && date < cutoff) {
      delete data.days[key];
    }
  }

  await chrome.storage.local.set({ stats: data });
}

async function bumpDay(mutator) {
  const key = dayKey();

  await changeStats(data => {
    mutator(statsDay(data, key));
  });
}

function sessionMinutesByDay(rawSession) {
  const session = normalizeSession(rawSession);
  const totals = {};

  if (
    !Number.isFinite(session.startedAt) ||
    !Number.isFinite(session.focusMs) ||
    !Number.isFinite(session.breakMs) ||
    !Number.isInteger(session.cycles) ||
    session.focusMs <= 0 ||
    session.breakMs < 0 ||
    session.cycles < 1 ||
    session.cycles > 12
  ) {
    throw new Error(
      "Invalid session timing; statistics were not changed."
    );
  }

  const totalMs =
    session.cycles * session.focusMs +
    (session.cycles - 1) * session.breakMs;

  if (
    !Number.isFinite(totalMs) ||
    totalMs > MAX_TOTAL_MIN * 60000
  ) {
    throw new Error(
      "Invalid session duration; statistics were not changed."
    );
  }

  for (let cycle = 0; cycle < session.cycles; cycle++) {
    let cursor =
      session.startedAt +
      cycle * (session.focusMs + session.breakMs);

    const end = cursor + session.focusMs;

    while (cursor < end) {
      const date = new Date(cursor);
      const midnight = new Date(cursor);
      midnight.setHours(24, 0, 0, 0);

      const segmentEnd = Math.min(end, midnight.getTime());

      if (
        !Number.isFinite(segmentEnd) ||
        segmentEnd <= cursor
      ) {
        throw new Error("Could not allocate session dates.");
      }

      const key = dayKey(date);

      totals[key] =
        (totals[key] || 0) +
        (segmentEnd - cursor) / 60000;

      cursor = segmentEnd;
    }
  }

  return totals;
}

function completionReceipt(rawSession) {
  const session = normalizeSession(rawSession);

  if (session.id) {
    return `session:${session.id}`;
  }

  // Compatibility with sessions created before session IDs existed.
  return JSON.stringify([
    session.startedAt,
    session.endsAt,
    session.focusMs,
    session.breakMs,
    session.cycles
  ]);
}

async function recordCompletedSession(session) {
  const totals = sessionMinutesByDay(session);
  const receipt = completionReceipt(session);

  await changeStats(data => {
    const receipts = Array.isArray(data.completedSessions)
      ? data.completedSessions
      : [];

    if (receipts.includes(receipt)) return;

    for (const [key, minutes] of Object.entries(totals)) {
      const day = statsDay(data, key);

      day.minutes =
        Math.round((day.minutes + minutes) * 1000000) /
        1000000;

      // A completed session counts toward each date it covered.
      day.sessions += 1;
    }

    data.completedSessions = [...receipts, receipt].slice(-1000);
  });
}

/* ---------- blocking rules ---------- */

function allowRule(item, index) {
  const host = String.raw`^https?://([a-z0-9-]+\.)*youtube\.com/`;

  const regexFilter =
    item.kind === "video"
      ? `${host}watch\\?(.*&)?v=${item.id}(&.*)?$`
      : `${host}(watch|playlist)\\?(.*&)?list=${item.id}(&.*)?$`;

  return {
    id: 1000 + index,
    priority: 2,
    action: { type: "allow" },
    condition: {
      regexFilter,
      isUrlFilterCaseSensitive: true,
      resourceTypes: ["main_frame"]
    }
  };
}

async function setRules(domains, allowed = []) {
  const oldRules =
    await chrome.declarativeNetRequest.getDynamicRules();

  const addRules = domains.map((domain, index) => ({
    id: index + 1,
    priority: 1,
    action: {
      type: "redirect",
      redirect: { extensionPath: "/blocked.html" }
    },
    condition: {
      urlFilter: `||${domain}^`,
      resourceTypes: ["main_frame"]
    }
  }));

  if (domains.length) {
    addRules.push(...allowed.map(allowRule));
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: oldRules.map(rule => rule.id),
    addRules
  });
}

/* ---------- session lifecycle ---------- */

async function endSession(completed) {
  const { session } = await chrome.storage.local.get("session");

  // Save statistics before deleting the session.
  // The receipt prevents a retry from recording it twice.
  if (completed && session) {
    await recordCompletedSession(session);
  }

  await setRules([]);
  await chrome.storage.local.remove("session");
  await chrome.alarms.clear(ALARM);
  await syncSound();

  if (!completed || !session) return;

  const normalized = normalizeSession(session);

  const minutes = Math.round(
    normalized.cycles * normalized.focusMs / 60000
  );

  const delay = Date.now() - normalized.endsAt;

  if (delay >= 0 && delay < 10 * 60000) {
    await notify(
      pick(END_MESSAGES),
      `${minutes} minutes logged.`
    );
  }
}

async function applyPhase() {
  const { session } = await chrome.storage.local.get("session");

  if (!session) {
    await setRules([]);
    await chrome.alarms.clear(ALARM);
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

    await updateSession(current => {
      current.phaseKey = key;
    });

    const delay = Date.now() - phase.start;

    if (!first && delay >= 0 && delay < 5 * 60000) {
      await notifyPhase(session, phase);
    }
  }

  const { session: fresh } =
    await chrome.storage.local.get("session");

  if (!fresh) return null;

  await setRules(
    phase.type === "focus" ? fresh.domains : [],
    fresh.allowed || []
  );

  await syncSound();

  await chrome.alarms.create(ALARM, {
    when: phase.end + 500
  });

  return fresh;
}

async function startSession(
  domains,
  config,
  goal,
  allowed,
  startedAt = Date.now(),
  extra = {}
) {
  const total =
    config.cycles * config.focusMs +
    (config.cycles - 1) * config.breakMs;

  const session = {
    id: crypto.randomUUID(),
    domains: [...domains],
    goal,
    allowed,
    startedAt,
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

  if (phase.type !== "done") {
    session.phaseKey = `${phase.type}:${phase.cycle}`;
  }

  await chrome.storage.local.set({ session });
  await applyPhase();
}

function buildConfig(message) {
  if (message.mode === "pomodoro") {
    const { focusMin, breakMin, cycles } = message;

    if (
      !isInt(focusMin, 1, 180) ||
      !isInt(breakMin, 1, 60) ||
      !isInt(cycles, 1, 12)
    ) {
      return null;
    }

    const total =
      cycles * focusMin + (cycles - 1) * breakMin;

    if (total > MAX_TOTAL_MIN) return null;

    return {
      mode: "pomodoro",
      focusMs: focusMin * 60000,
      breakMs: breakMin * 60000,
      cycles
    };
  }

  if (!isInt(message.minutes, 1, MAX_TOTAL_MIN)) {
    return null;
  }

  return {
    mode: "custom",
    focusMs: message.minutes * 60000,
    breakMs: 0,
    cycles: 1
  };
}

/* ---------- input validation ---------- */

function validDomainList(domains) {
  return (
    Array.isArray(domains) &&
    domains.length > 0 &&
    domains.length <= MAX_SITES &&
    domains.every(
      domain =>
        typeof domain === "string" &&
BLOCKINY_DOMAIN_RE.test(domain)    )
  );
}

function checkAllowed(allowed, domains) {
  if (
    !Array.isArray(allowed) ||
    allowed.length > MAX_ALLOWED ||
    !allowed.every(isValidAllowed)
  ) {
    return "Invalid allowed page.";
  }

  if (
    allowed.length &&
    !domains.includes("youtube.com")
  ) {
    return "Add youtube.com to the blocked sites first.";
  }

  return null;
}

/* ---------- blocked attempts ---------- */

async function recordAttempt() {
  const { session } = await chrome.storage.local.get("session");

  if (!session || getPhase(session).type !== "focus") {
    return;
  }

  await updateSession(current => {
    current.attempts = (current.attempts || 0) + 1;
  });

  await bumpDay(day => {
    day.attempts += 1;
  });
}

/* ---------- schedules ---------- */

async function getSchedules() {
  const { schedules } =
    await chrome.storage.local.get("schedules");

  return Array.isArray(schedules) ? schedules : [];
}

function lockInfo(entry, now = Date.now()) {
  if (activeStart(entry, now)) {
    return { deletable: false, reason: "Running now" };
  }

  if (now - entry.createdAt < GRACE_MS) {
    return { deletable: true };
  }

  const next = nextStart(entry, now);

  if (
    next === null ||
    next - now >= LOCK_HOURS * 3600000
  ) {
    return { deletable: true };
  }

  return {
    deletable: false,
    reason: `Locked ${LOCK_HOURS}h before it starts`
  };
}

async function rescheduleAlarms(schedules) {
  const all = await chrome.alarms.getAll();

  for (const alarm of all) {
    if (alarm.name.startsWith(SCHED_PREFIX)) {
      await chrome.alarms.clear(alarm.name);
    }
  }

  for (const entry of schedules) {
    const when = nextStart(entry);

    if (when) {
      await chrome.alarms.create(
        SCHED_PREFIX + entry.id,
        { when: when + 1000 }
      );
    }
  }
}

async function runSchedules() {
  // Finish an expired session before checking new schedules.
  const { session: previous } =
    await chrome.storage.local.get("session");

  if (previous && getPhase(previous).type === "done") {
    await endSession(true);
  }

  const schedules = await getSchedules();
  const now = Date.now();

  const { session } = await chrome.storage.local.get("session");

  let running = !!session;

  for (const entry of schedules) {
    const start = activeStart(entry, now);

    if (
      !start ||
      entry.lastStart === start ||
      running
    ) {
      continue;
    }

    const config = {
      mode: "custom",
      focusMs: entry.minutes * 60000,
      breakMs: 0,
      cycles: 1
    };

    await startSession(
      entry.domains,
      config,
      entry.goal || "",
      entry.allowed || [],
      start
    );

    entry.lastStart = start;
    running = true;

    await chrome.storage.local.set({ schedules });

    await notify(
      "Scheduled session started",
      `${entry.minutes} minutes.`
    );
  }

  await rescheduleAlarms(schedules);
}

function validateSchedule(message) {
  const { days, time, minutes, domains } = message;

  if (
    !Array.isArray(days) ||
    !days.length ||
    !days.every(day => isInt(day, 0, 6)) ||
    new Set(days).size !== days.length
  ) {
    return "Pick at least one day.";
  }

  if (
    typeof time !== "string" ||
    !TIME_RE.test(time)
  ) {
    return "Pick a start time.";
  }

  if (!isInt(minutes, 1, MAX_TOTAL_MIN)) {
    return "Pick between 1 and 1440 minutes.";
  }

  if (!validDomainList(domains)) {
    return "Add at least one site above.";
  }

  return checkAllowed(
    Array.isArray(message.allowed) ? message.allowed : [],
    domains
  );
}

/* ---------- startup and alarms ---------- */

async function onStartup() {
  await runSchedules();
  await applyPhase();
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (
    alarm.name !== ALARM &&
    !alarm.name.startsWith(SCHED_PREFIX)
  ) {
    return;
  }

  enqueueOperation(async () => {
    await runSchedules();
    await applyPhase();
  }).catch(reportError);
});

chrome.runtime.onStartup.addListener(() => {
  enqueueOperation(onStartup).catch(reportError);
});

chrome.runtime.onInstalled.addListener(() => {
  enqueueOperation(onStartup).catch(reportError);
});

/* ---------- popup and blocked-page messages ---------- */

async function handleMessage(message, sender) {
  switch (message.type) {
    case "status": {
      await runSchedules();

      return {
        session: await applyPhase()
      };
    }

    case "stats": {
      // Process expired sessions before returning totals.
      await applyPhase();

      const { stats } =
        await chrome.storage.local.get("stats");

      return {
        stats: stats || { days: {} }
      };
    }

    case "blockTab": {
      if (sender.tab && sender.tab.id != null) {
        await chrome.tabs.update(sender.tab.id, {
          url: chrome.runtime.getURL("blocked.html")
        });
      }

      return { ok: true };
    }

    case "attempt": {
      await recordAttempt();
      return { ok: true };
    }

    case "setSound": {
      const { sound, volume } = cleanSound(message);

      const updated = await updateSession(session => {
        session.sound = sound;
        session.volume = volume;
      });

      if (!updated) {
        return {
          ok: false,
          error: "No session is running."
        };
      }

      await syncSound();
      return { ok: true };
    }

    case "addSite": {
      const session = await applyPhase();

     if (!session) {
  return {
    ok: false,
    error: "No session is running."
  };
}

if (
  typeof message.domain !== "string" ||
  !BLOCKINY_DOMAIN_RE.test(message.domain)
) {
  return {
    ok: false,
    error: "Try something like reddit.com"
  };
}

      if (session.domains.includes(message.domain)) {
        return { ok: true };
      }

      if (session.domains.length >= MAX_SITES) {
        return {
          ok: false,
          error: "Too many sites."
        };
      }

      await updateSession(current => {
        current.domains.push(message.domain);
      });

      await applyPhase();
      return { ok: true };
    }

    case "start": {
      const config = buildConfig(message);

      if (
        !validDomainList(message.domains) ||
        !config
      ) {
        return {
          ok: false,
          error: "Invalid input."
        };
      }

      const allowed = Array.isArray(message.allowed)
        ? message.allowed
        : [];

      const problem = checkAllowed(
        allowed,
        message.domains
      );

      if (problem) {
        return { ok: false, error: problem };
      }

      const { session } =
        await chrome.storage.local.get("session");

      if (session) {
        if (getPhase(session).type !== "done") {
          return {
            ok: false,
            error: "A session is already running."
          };
        }

        await endSession(true);
      }

      await startSession(
        message.domains,
        config,
        cleanGoal(message.goal),
        allowed.map(({ kind, id }) => ({ kind, id })),
        Date.now(),
        cleanSound(message)
      );

      return { ok: true };
    }

    case "listSchedules": {
      const now = Date.now();

      const schedules = (await getSchedules()).map(entry => ({
        id: entry.id,
        days: entry.days,
        time: entry.time,
        minutes: entry.minutes,
        domains: entry.domains,
        next: nextStart(entry, now),
        ...lockInfo(entry, now)
      }));

      return { schedules };
    }

    case "addSchedule": {
      const problem = validateSchedule(message);

      if (problem) {
        return { ok: false, error: problem };
      }

      const schedules = await getSchedules();

      if (schedules.length >= MAX_SCHEDULES) {
        return {
          ok: false,
          error: "Too many scheduled sessions."
        };
      }

      const allowed = Array.isArray(message.allowed)
        ? message.allowed
        : [];

      schedules.push({
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        days: [...message.days].sort((a, b) => a - b),
        time: message.time,
        minutes: message.minutes,
        domains: [...message.domains],
        goal: cleanGoal(message.goal),
        allowed: allowed.map(({ kind, id }) => ({ kind, id }))
      });

      await chrome.storage.local.set({ schedules });
      await runSchedules();

      return { ok: true };
    }

    case "deleteSchedule": {
      const schedules = await getSchedules();

      const entry = schedules.find(
        item => item.id === message.id
      );

      if (!entry) return { ok: true };

      const info = lockInfo(entry);

      if (!info.deletable) {
        return {
          ok: false,
          error: info.reason
        };
      }

      await chrome.storage.local.set({
        schedules: schedules.filter(
          item => item.id !== message.id
        )
      });

      await runSchedules();
      return { ok: true };
    }

    default:
      return {
        ok: false,
        error: "Unknown request."
      };
  }
}

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }

    if (message.target === "offscreen") {
      return false;
    }

    enqueueOperation(() => handleMessage(message, sender))
      .then(result => {
        sendResponse(result);
      })
      .catch(error => {
        reportError(error);

        sendResponse({
          ok: false,
          error: String(error)
        });
      });

    return true;
  }
);
