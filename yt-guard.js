(function () {
  let busy = false;
  let timer;

  async function check() {
    if (busy) return;
    if (!chrome.runtime || !chrome.runtime.id) { clearInterval(timer); return; }
    busy = true;
    try {
      const { session } = await chrome.storage.local.get("session");
      if (!session || getPhase(session).type !== "focus") return;
      const host = location.hostname.replace(/^www\./, "");
      const blocked = (session.domains || []).some(d => host === d || host.endsWith("." + d));
      if (!blocked || isAllowedUrl(location.href, session.allowed || [])) return;
      chrome.runtime.sendMessage({ type: "blockTab" });
    } catch {
      clearInterval(timer);
    } finally {
      busy = false;
    }
  }

  check();
  timer = setInterval(check, 700);
  window.addEventListener("yt-navigate-finish", check);
  window.addEventListener("popstate", check);
})();
