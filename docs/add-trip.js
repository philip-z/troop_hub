const APPS_SCRIPT_URL = TROOP_CONFIG.APPS_SCRIPT_URL;

let leaderIdToken = null;

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
  showSignedIn(claims.email);
  setMessage('', false);
  loadTemplates();
}

function clearLeaderState() {
  leaderIdToken = null;
  showSignedIn(null);
  templates = [];
  document.getElementById('copyRow').hidden = true;
}

let templates = [];

// Optional: if this fails the form still works, just without the copy dropdown.
function loadTemplates() {
  const token = leaderIdToken;
  fetch(APPS_SCRIPT_URL, { method: 'POST', body: JSON.stringify({ action: 'listTripTemplates', idToken: token }) })
    .then(res => res.json())
    .then(r => {
      if (token !== leaderIdToken || r.status !== 'success') return;
      templates = r.trips;
      const sel = document.getElementById('copyFrom');
      sel.length = 1;
      templates.forEach((t, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = t.tripTitle + (t.tripDates ? ' (' + t.tripDates + ')' : '');
        sel.appendChild(o);
      });
      document.getElementById('copyRow').hidden = !templates.length;
    })
    .catch(err => console.error(err));
}

const COPY_FIELDS = ['tripTitle', 'tripLocation', 'departureDetails', 'departureOptions', 'returnDetails', 'tripCost', 'tripCoordinator', 'tripUniform'];

function copyFromTrip() {
  const t = templates[Number(document.getElementById('copyFrom').value)];
  if (!t) return;
  COPY_FIELDS.forEach(f => { document.getElementById(f).value = t[f] || ''; });
  document.getElementById('tripDates').value = '';
  document.getElementById('tripMonth').focus();
  setMessage('Copied from "' + t.tripTitle + '". Enter the new month and dates.', false);
}

TroopAuth.start({ buttonId: 'signInBtn', buttonSize: 'large', onSignIn: handleLeaderCredential, onSignOut: clearLeaderState });

window.addEventListener('load', function() {
  document.getElementById('tripForm').addEventListener('submit', submitTrip);
  document.getElementById('copyFrom').addEventListener('change', copyFromTrip);
  document.getElementById('signOutBtn').addEventListener('click', TroopAuth.signOut);
});

function submitTrip(e) {
  e.preventDefault();
  if (!leaderIdToken) { setMessage('Please sign in first.', true); return; }

  const form = e.target;
  const btn = document.getElementById('addTripBtn');
  const payload = { action: 'addTrip', idToken: leaderIdToken };
  new FormData(form).forEach((value, key) => { payload[key] = value; });

  btn.disabled = true;
  setMessage('Adding trip...', false);

  fetch(APPS_SCRIPT_URL, { method: 'POST', body: JSON.stringify(payload) })
    .then(res => res.json())
    .then(r => {
      if (r.status === 'success') {
        setMessage('Trip added.', false);
        form.reset();
        loadTemplates();
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
