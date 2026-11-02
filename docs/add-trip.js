const APPS_SCRIPT_URL = TROOP_CONFIG.APPS_SCRIPT_URL;

let leaderIdToken = null;
let leaderEmail = '';

function setMessage(text, isError) {
  const el = document.getElementById('leaderMessage');
  el.textContent = text;
  el.style.color = isError ? '#b00020' : '#1b5e20';
}

function showSignedIn(email) {
  document.getElementById('signedInAs').textContent = email || '';
  document.getElementById('signedIn').hidden = !email;
  document.getElementById('signInBtn').hidden = !!email;
  document.getElementById('tripForm').hidden = !email;
  document.getElementById('signinPrompt').hidden = !!email;
  document.getElementById('addTripBtn').disabled = !email;
}

// Shared sign-in (auth.js): also restores a sign-in made on another page of this site.
function handleLeaderCredential(token, claims) {
  leaderIdToken = token;
  leaderEmail = String(claims.email || '').toLowerCase();
  showSignedIn(claims.email);
  setMessage('', false);
  loadTemplates();
}

function clearLeaderState() {
  leaderIdToken = null;
  leaderEmail = '';
  showSignedIn(null);
  templates = [];
  document.getElementById('copyRow').hidden = true;
}

let templates = [];

function applyTemplates(list) {
  templates = list;
  const sel = document.getElementById('copyFrom');
  sel.length = 1;
  templates.forEach((t, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = t.tripTitle + (t.tripDates ? ' (' + t.tripDates + ')' : '');
    sel.appendChild(o);
  });
  document.getElementById('copyRow').hidden = !templates.length;
}

// The hub's session response (saved on this device by hub.js) already includes the
// templates for leaders, so arriving from the hub needs no server call.
function cachedTemplates() {
  try {
    const saved = TroopOffline.cacheGet(leaderEmail, 'session');
    return saved && Array.isArray(saved.data.templates) ? saved.data.templates : null;
  } catch (e) { return null; }
}

// Optional: if this fails the form still works, just without the copy dropdown.
function loadTemplates(forceRefresh) {
  const token = leaderIdToken;
  const cached = forceRefresh ? null : cachedTemplates();
  if (cached) { applyTemplates(cached); return; }
  fetch(APPS_SCRIPT_URL, { method: 'POST', body: JSON.stringify({ action: 'listTripTemplates', idToken: token }) })
    .then(res => res.json())
    .then(r => {
      if (token !== leaderIdToken || r.status !== 'success') return;
      applyTemplates(r.trips);
    })
    .catch(err => console.error(err));
}

// A new trip makes the hub's saved session (trips list and templates) out of date; marking it
// stale makes the hub refresh it next time it opens (the old copy still works offline until then).
function invalidateHubCache() {
  TroopOffline.cacheStale(leaderEmail, 'session');
}

// Fills every named input that the template has a value for, except those marked
// data-no-copy in add-trip.html (dates, month) and checkboxes. The template's keys are the
// Trips column names, which are the inputs' names.
function copyFromTrip() {
  const t = templates[Number(document.getElementById('copyFrom').value)];
  if (!t) return;
  Array.from(document.getElementById('tripForm').elements).forEach(el => {
    if (!el.name || el.type === 'checkbox' || el.dataset.noCopy !== undefined) return;
    if (t[el.name] !== undefined) el.value = t[el.name];
  });
  document.getElementById('tripDates').value = '';
  document.getElementById('tripMonth').focus();
  setMessage('Copied from "' + t.tripTitle + '". Enter the new month and dates.', false);
}

TroopAuth.start({ buttonId: 'signInBtn', buttonSize: 'large', onSignIn: handleLeaderCredential, onSignOut: clearLeaderState });

window.addEventListener('load', function() {
  document.getElementById('tripForm').addEventListener('submit', submitTrip);
  document.getElementById('copyFrom').addEventListener('change', copyFromTrip);
  document.getElementById('signOutBtn').addEventListener('click', TroopAuth.userSignOut);
});

function submitTrip(e) {
  e.preventDefault();
  if (!leaderIdToken) { setMessage('Please sign in first.', true); return; }

  const form = e.target;
  const btn = document.getElementById('addTripBtn');
  const payload = { action: 'addTrip', idToken: leaderIdToken, values: Object.fromEntries(new FormData(form)) };

  btn.disabled = true;
  setMessage('Adding trip...', false);

  fetch(APPS_SCRIPT_URL, { method: 'POST', body: JSON.stringify(payload) })
    .then(res => res.json())
    .then(r => {
      if (r.status === 'success') {
        setMessage('Trip added.', false);
        form.reset();
        invalidateHubCache();
        loadTemplates(true);
      } else if (r.code === 'signin') {
        TroopAuth.signOut();
        setMessage(r.message + ' Your entries are still in the form.', true);
        return;
      } else {
        setMessage(r.message || 'Could not add the trip.', true);
      }
    })
    .catch(err => {
      console.error(err);
      setMessage('Network error. Your entries are still in the form; try again.', true);
    })
    .finally(() => { btn.disabled = !leaderIdToken; });
}
