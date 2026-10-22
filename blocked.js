const $ = id => document.getElementById(id);
let quotePhase = null;

const POOLS = {
  focus: ["focus", "discipline", "learning"],
  break: ["calm"],
  done: ["discipline", "calm"]
};

async function getSession() {
  const { session } = await chrome.storage.local.get("session");
  return session || null;
}

function showQuote(phaseType) {
  const categories = POOLS[phaseType] || POOLS.focus;
  let pool = QUOTES.map((quote, index) => ({ quote, index })).filter(item => categories.includes(item.quote.category));
  if (!pool.length) pool = QUOTES.map((quote, index) => ({ quote, index }));
  const last = Number(localStorage.getItem("lastQuote"));
  const options = pool.length > 1 ? pool.filter(item => item.index !== last) : pool;
  const pick = options[Math.floor(Math.random() * options.length)];
  localStorage.setItem("lastQuote", String(pick.index));
  $("quote").textContent = `“${pick.quote.text}”`;
  $("by").textContent = pick.quote.by ? pick.quote.by : "";
  quotePhase = phaseType;
}

function render(session) {
  const goal = session && session.goal ? session.goal.trim() : "";
  $("goalText").textContent = goal;
  $("goalCard").hidden = !goal;

  if (!session) {
    document.body.className = "done";
    $("title").textContent = "Session complete";
    $("message").textContent = "Your sites are available again.";
    $("phaseInfo").hidden = true;
    $("attempts").hidden = true;
    $("left").textContent = "00:00";
    $("timeLabel").textContent = "finished";
    if (quotePhase !== "done") showQuote("done");
    return;
  }

  const phase = getPhase(session);
  if (phase.type === "done") {
    render(null);
    return;
  }
  const info = normalizeSession(session);
  const showCycles = info.mode === "pomodoro";
  $("phaseInfo").hidden = !showCycles;
  if (showCycles) $("phaseInfo").textContent = `${phase.type === "focus" ? "Focus" : "Break"} · round ${phase.cycle} of ${phase.cycles}`;

  const attempts = session.attempts || 0;
  $("attempts").hidden = attempts < 1;
  $("attempts").textContent = `Distractions stopped this session: ${attempts}`;

  if (phase.type === "focus") {
    document.body.className = "focus";
    $("title").textContent = "Focus session active";
    $("message").textContent = "This site is blocked until your session ends.";
    $("timeLabel").textContent = showCycles ? "left in this focus round" : "remaining";
  } else {
    document.body.className = "break";
    $("title").textContent = "Break time";
    $("message").textContent = "Your sites are unlocked for now.";
    $("timeLabel").textContent = "until focus resumes";
  }
  $("left").textContent = formatClock(Math.max(0, phase.end - Date.now()));
  if (quotePhase !== phase.type) showQuote(phase.type);
}

async function tick() {
  render(await getSession());
}

chrome.runtime.sendMessage({ type: "attempt" }).catch(() => {});
tick();
setInterval(tick, 1000);
