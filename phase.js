function normalizeSession(session) {
  const focusMs = session.focusMs || (session.endsAt - session.startedAt);
  return {
    ...session,
    mode: session.mode || "custom",
    focusMs,
    breakMs: session.breakMs || 0,
    cycles: session.cycles || 1
  };
}

function getPhase(rawSession, now = Date.now()) {
  const s = normalizeSession(rawSession);
  const elapsed = now - s.startedAt;
  const total = s.cycles * s.focusMs + (s.cycles - 1) * s.breakMs;
  if (elapsed >= total) return { type: "done", cycle: s.cycles, cycles: s.cycles };
  const unit = s.focusMs + s.breakMs;
  const index = Math.floor(elapsed / unit);
  const into = elapsed - index * unit;
  const cycleStart = s.startedAt + index * unit;
  if (into < s.focusMs) {
    return { type: "focus", cycle: index + 1, cycles: s.cycles, start: cycleStart, end: cycleStart + s.focusMs };
  }
  return { type: "break", cycle: index + 1, cycles: s.cycles, start: cycleStart + s.focusMs, end: cycleStart + unit };
}

function formatClock(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const seconds = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;

function isValidAllowed(item) {
  if (!item || typeof item.id !== "string") return false;
  if (item.kind === "video") return VIDEO_ID_RE.test(item.id);
  if (item.kind === "playlist") return PLAYLIST_ID_RE.test(item.id) && !item.id.startsWith("RD");
  return false;
}

function isAllowedUrl(href, allowed) {
  let url;
  try { url = new URL(href); } catch { return false; }
  const video = url.searchParams.get("v");
  const list = url.searchParams.get("list");
  const path = url.pathname;
  return (allowed || []).some(item =>
    item.kind === "video"
      ? path === "/watch" && video === item.id
      : (path === "/watch" || path === "/playlist") && list === item.id
  );
}

function occurrenceStart(entry, dayOffset, from) {
  const [hours, minutes] = entry.time.split(":").map(Number);
  const date = new Date(from);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function nextStart(entry, from = Date.now()) {
  for (let i = 0; i < 8; i++) {
    const date = occurrenceStart(entry, i, from);
    if (entry.days.includes(date.getDay()) && date.getTime() > from) return date.getTime();
  }
  return null;
}

function activeStart(entry, now = Date.now()) {
  for (const offset of [0, -1]) {
    const date = occurrenceStart(entry, offset, now);
    const start = date.getTime();
    if (entry.days.includes(date.getDay()) && start <= now && now < start + entry.minutes * 60000) return start;
  }
  return null;
}
