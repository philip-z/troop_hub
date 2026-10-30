// Dev-only stand-in for Google Sign-In (https://accounts.google.com/gsi/client).
// dev/server.js injects this in place of the real script. It mints UNSIGNED tokens,
// which only the local mock backend accepts; the real Apps Script rejects them.
(function () {
  const PRESETS = ["leader@test.com", "treasurer@test.com", "parent@test.com", "parent2@test.com"];
  const LAST_KEY = "mockGsiEmail";
  let callback = null;

  const b64url = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  function makeToken(email) {
    const name = email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: "mock", aud: "mock-client", sub: "mock-" + email, email, email_verified: true, name, iat: now, exp: now + 3600 };
    return b64url({ alg: "none", typ: "JWT" }) + "." + b64url(claims) + ".mock";
  }

  window.google = { accounts: { id: {
    initialize(opts) { callback = opts.callback; },
    renderButton(el) {
      el.textContent = "";
      const box = document.createElement("span");
      box.style.cssText = "display:inline-flex;gap:4px;align-items:center;border:1px dashed #b36b00;padding:3px 6px;background:#fff8e1;font:13px sans-serif";
      const tag = document.createElement("strong"); tag.textContent = "MOCK sign-in:";
      const input = document.createElement("input");
      input.setAttribute("list", "mock-gsi-emails");
      input.value = localStorage.getItem(LAST_KEY) || PRESETS[0];
      input.size = 22;
      const list = document.createElement("datalist"); list.id = "mock-gsi-emails";
      PRESETS.forEach((e) => { const o = document.createElement("option"); o.value = e; list.appendChild(o); });
      const btn = document.createElement("button"); btn.type = "button"; btn.textContent = "Sign in";
      btn.onclick = () => {
        const email = input.value.trim().toLowerCase();
        if (!email || !callback) return;
        localStorage.setItem(LAST_KEY, email);
        callback({ credential: makeToken(email) });
      };
      box.append(tag, input, list, btn);
      el.appendChild(box);
    },
    disableAutoSelect() {},
    prompt() {}
  } } };
})();
