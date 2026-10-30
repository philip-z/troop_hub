// Shared sign-in (Google or emailed code) for every page. The token is kept in sessionStorage,
// so one sign-in carries across index.html, slip.html and add-trip.html in the same tab until
// it expires or the user signs out. With "Remember me" it is kept in localStorage instead.
// The server still verifies the token on every request; nothing here is trusted for access control.
window.TroopAuth = (function () {
  const KEY = "troop_id_token";

  function parseJwt(token) {
    const b = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(decodeURIComponent(atob(b).split("").map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")));
    // Email-code session tokens carry only {email, exp}; give them the same identity key the server uses.
    if (token.indexOf("ts1.") === 0 && !claims.sub) claims.sub = "email:" + String(claims.email || "").toLowerCase();
    return claims;
  }

  async function post(body) {
    const res = await fetch(window.TROOP_CONFIG.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error("Server error " + res.status);
    return res.json();
  }

  let emailBox = null;
  const remember = document.createElement("input");
  remember.type = "checkbox";

  // Remembered sign-ins live in localStorage (survive new tabs and restarts); others in sessionStorage.
  function save(token, persist) {
    sessionStorage.removeItem(KEY); localStorage.removeItem(KEY);
    (persist ? localStorage : sessionStorage).setItem(KEY, token);
  }

  // Google ID tokens last ~1 hour, so "remember me" swaps one for a 30-day token from our server.
  async function onGoogleCredential(credential) {
    let token = credential;
    if (remember.checked) {
      try {
        const d = await post({ action: "authExchange", idToken: credential });
        if (d.status === "success") token = d.token;
      } catch (e) { /* keep the Google token for this tab */ }
    }
    save(token, remember.checked && token !== credential);
    onSignInCb(token, parseJwt(token));
  }

  // "Sign in with email" fallback for people who don't want to use Google. The server
  // emails a 6-digit code and swaps it for a session token (apps-script/Auth.gs).
  function buildEmailBox(afterEl) {
    const box = document.createElement("div");
    box.className = "troop-email-auth";
    const rememberLabel = document.createElement("label");
    rememberLabel.className = "troop-remember";
    rememberLabel.append(remember, " Remember me on this device (30 days; don't use on shared computers)");
    const toggle = document.createElement("button");
    toggle.type = "button"; toggle.className = "link-btn"; toggle.textContent = "Or sign in with email";
    const form = document.createElement("div"); form.hidden = true;
    const email = document.createElement("input");
    email.type = "email"; email.placeholder = "you@example.com"; email.autocomplete = "email"; email.setAttribute("aria-label", "Email address");
    const send = document.createElement("button"); send.type = "button"; send.textContent = "Email me a code";
    const code = document.createElement("input");
    code.type = "text"; code.inputMode = "numeric"; code.maxLength = 6; code.placeholder = "6-digit code"; code.autocomplete = "one-time-code";
    code.setAttribute("aria-label", "Sign-in code"); code.hidden = true;
    const verify = document.createElement("button"); verify.type = "button"; verify.textContent = "Sign in"; verify.hidden = true;
    const note = document.createElement("div"); note.setAttribute("role", "status");
    form.append(email, " ", send, " ", code, " ", verify, note);
    box.append(rememberLabel, toggle, form);

    const say = (t, bad) => { note.textContent = t || ""; note.style.color = bad ? "#b00020" : "#1b5e20"; };
    toggle.onclick = () => { form.hidden = !form.hidden; if (!form.hidden) email.focus(); };
    send.onclick = async () => {
      send.disabled = true;
      try {
        const d = await post({ action: "authRequestCode", email: email.value });
        if (d.status === "error") { say(d.message, true); return; }
        say(d.message); code.hidden = false; verify.hidden = false; code.focus();
      } catch (e) { say(e.message, true); }
      finally { send.disabled = false; }
    };
    verify.onclick = async () => {
      verify.disabled = true;
      try {
        const d = await post({ action: "authVerifyCode", email: email.value, code: code.value, remember: remember.checked });
        if (d.status === "error") { say(d.message, true); return; }
        code.value = ""; say("");
        save(d.token, remember.checked);
        onSignInCb(d.token, parseJwt(d.token));
      } catch (e) { say(e.message, true); }
      finally { verify.disabled = false; }
    };
    afterEl.insertAdjacentElement("afterend", box);
    return box;
  }

  function stored() {
    try {
      const t = sessionStorage.getItem(KEY) || localStorage.getItem(KEY);
      if (!t) return null;
      // 30s margin so a token isn't restored just as it expires.
      if (Number(parseJwt(t).exp) * 1000 < Date.now() + 30000) { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); return null; }
      return t;
    } catch (e) { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); return null; }
  }

  let onSignInCb = null, onSignOutCb = null;

  // opts: { buttonId, buttonSize, onSignIn(token, claims), onSignOut() }
  function start(opts) {
    onSignInCb = function (t, c) { if (emailBox) emailBox.hidden = true; opts.onSignIn(t, c); };
    onSignOutCb = function () { if (emailBox) emailBox.hidden = false; if (opts.onSignOut) opts.onSignOut(); };
    window.addEventListener("load", function () {
      const el = document.getElementById(opts.buttonId);
      if (el) emailBox = buildEmailBox(el);
      if (window.google && google.accounts && google.accounts.id) {
        google.accounts.id.initialize({
          client_id: window.TROOP_CONFIG.GOOGLE_CLIENT_ID,
          callback: function (r) { onGoogleCredential(r.credential); }
        });
        if (el) google.accounts.id.renderButton(el, { theme: "outline", size: opts.buttonSize || "medium" });
      }
      const t = stored();
      if (t) onSignInCb(t, parseJwt(t));
    });
  }

  function signOut() {
    sessionStorage.removeItem(KEY); localStorage.removeItem(KEY);
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    if (onSignOutCb) onSignOutCb();
  }

  return { start, signOut, parseJwt, getToken: stored };
})();
