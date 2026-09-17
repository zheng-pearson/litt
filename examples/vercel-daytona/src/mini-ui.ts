export const miniHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Set up Second</title><link rel="stylesheet" href="/mini/app.css"><script src="https://telegram.org/js/telegram-web-app.js"></script><script defer src="/mini/app.js"></script></head><body><main><h1>Set up Second</h1><p>Sign in with your Google account to set up your assistant in this Telegram chat.</p><p id="status" role="status" aria-live="polite">Checking your Telegram session…</p><button id="continue" hidden>Continue with Google</button><p id="help">Google opens in your browser. Keep this Mini App open, then return here after signing in. Setup finishes automatically, with no code to send.</p><noscript>JavaScript is required. Open this page using the bot’s Open App button in Telegram.</noscript></main></body></html>`;

export const miniStyle = `:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;background:light-dark(#fff,#18222d);color:light-dark(#17212b,#f5f5f5)}main{max-width:38rem;margin:0 auto;padding:32px 24px;padding-bottom:max(32px,env(safe-area-inset-bottom))}h1{font-size:1.75rem;line-height:1.2;margin:0 0 16px}p{font-size:1rem;line-height:1.55;margin:0 0 24px}button{font:inherit;font-weight:600;min-height:48px;padding:12px 20px;border:0;border-radius:12px;background:light-dark(#155c99,#8ec9ff);color:light-dark(#fff,#102331);cursor:pointer}button:hover{filter:brightness(.9)}button:focus-visible{outline:3px solid currentColor;outline-offset:4px}button:disabled{opacity:.6;cursor:wait}[hidden]{display:none}#status{font-weight:600}#help{margin-top:24px}`;

export const miniScript = `"use strict";
(() => {
  const status = document.getElementById("status");
  const button = document.getElementById("continue");
  const help = document.getElementById("help");
  const app = window.Telegram && window.Telegram.WebApp;
  let session, timer, busy = false, stopped = false;
  function fail(message) {
    stopped = true;
    clearTimeout(timer);
    status.textContent = message;
    button.hidden = true;
    help.textContent = "Close this Mini App and open it again from the bot to restart setup. Your existing assistant is not changed.";
  }
  async function request(path, body) {
    const response = await fetch(path, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body), signal:AbortSignal.timeout(15000)});
    const data = await response.json();
    if (!response.ok) { throw new Error(data.error || "Setup is unavailable. Close and reopen the Mini App to try again."); }
    return data;
  }
  function show(state) {
    if (state === "active") {
      stopped = true;
      clearTimeout(timer);
      status.textContent = "Your assistant is ready.";
      help.textContent = "Return to the bot and send your first message.";
      button.hidden = false;
      button.textContent = "Back to chat";
      button.onclick = () => app.close();
    } else if (state === "provisioning") {
      button.hidden = true;
      status.textContent = "Account linked. Setting up your assistant…";
      help.textContent = "You can close this window. The bot will message you when your assistant is ready.";
    }
  }
  async function poll() {
    if (busy || stopped || !session) { return; }
    clearTimeout(timer);
    busy = true;
    try {
      const data = await request("/mini/status", {initData:app.initData, session});
      show(data.status);
      if (!stopped) { timer = setTimeout(poll, 3000); }
    } catch (error) { fail(error.message); }
    finally { busy = false; }
  }
  if (!app || !app.initData) {
    fail("Open Second from Telegram to start setup.");
    return;
  }
  app.ready();
  request("/mini/session", {initData:app.initData}).then(data => {
    if (data.status !== "pending") { show(data.status); return; }
    session = data.session;
    status.textContent = "Telegram verified. Continue with Google.";
    button.hidden = false;
    button.onclick = () => {
      app.openLink(data.url);
      button.hidden = true;
      status.textContent = "Waiting for Google sign-in…";
      poll();
    };
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { poll(); } });
  }).catch(error => fail(error.message));
})();`;
