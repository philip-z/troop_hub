// =============================================================================
// Troop 58 permission slip: front-end script
//
// Sections:
//   1. Configuration
//   2. Vehicle make/model data
//   3. Page startup
//   4. Trip details
//   5. Form state (youth/adult toggle, drafts)
//   6. Form field helpers (data in/out, phone format, vehicle autocomplete)
//   7. Submission (submit, spinner, wording snapshot)
//   8. Google sign-in and saved profiles
// =============================================================================


// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------

const APPS_SCRIPT_URL = TROOP_CONFIG.APPS_SCRIPT_URL;
const TRIP_ID = new URLSearchParams(window.location.search).get('trip') || '';
const DRAFT_KEY = 'troop58_form_draft_' + TRIP_ID;


// ---------------------------------------------------------------------------
// 2. Vehicle make/model data
// ---------------------------------------------------------------------------

// Common US makes and models for the vehicle autocomplete. Suggestions only: any
// value can still be typed, so a missing make or model never blocks anyone.
const VEHICLE_MODELS = {
  'Acura': ['ILX', 'Integra', 'MDX', 'RDX', 'TLX'],
  'Audi': ['A3', 'A4', 'A6', 'Q3', 'Q5', 'Q7'],
  'BMW': ['3 Series', '5 Series', 'X1', 'X3', 'X5'],
  'Buick': ['Enclave', 'Encore', 'Envision'],
  'Cadillac': ['Escalade', 'XT4', 'XT5', 'XT6'],
  'Chevrolet': ['Blazer', 'Colorado', 'Equinox', 'Malibu', 'Silverado 1500', 'Silverado 2500', 'Suburban', 'Tahoe', 'Traverse', 'Trax'],
  'Chrysler': ['300', 'Pacifica'],
  'Dodge': ['Challenger', 'Charger', 'Durango', 'Grand Caravan', 'Ram 1500'],
  'Ford': ['Bronco', 'Edge', 'Escape', 'Expedition', 'Explorer', 'F-150', 'F-250', 'F-350', 'Fusion', 'Maverick', 'Mustang', 'Ranger', 'Transit'],
  'GMC': ['Acadia', 'Canyon', 'Sierra 1500', 'Sierra 2500', 'Terrain', 'Yukon'],
  'Honda': ['Accord', 'Civic', 'CR-V', 'Fit', 'HR-V', 'Odyssey', 'Passport', 'Pilot', 'Ridgeline'],
  'Hyundai': ['Elantra', 'Kona', 'Palisade', 'Santa Fe', 'Sonata', 'Tucson'],
  'Infiniti': ['Q50', 'QX50', 'QX60'],
  'Jeep': ['Cherokee', 'Compass', 'Gladiator', 'Grand Cherokee', 'Renegade', 'Wrangler'],
  'Kia': ['Forte', 'Optima', 'Seltos', 'Sorento', 'Soul', 'Sportage', 'Telluride'],
  'Lexus': ['ES', 'GX', 'IS', 'NX', 'RX'],
  'Lincoln': ['Aviator', 'Corsair', 'Navigator'],
  'Mazda': ['CX-3', 'CX-30', 'CX-5', 'CX-9', 'Mazda3', 'Mazda6'],
  'Mercedes-Benz': ['C-Class', 'E-Class', 'GLC', 'GLE'],
  'Mitsubishi': ['Outlander', 'Outlander Sport'],
  'Nissan': ['Altima', 'Frontier', 'Murano', 'Pathfinder', 'Rogue', 'Sentra', 'Titan', 'Versa'],
  'Ram': ['1500', '2500', '3500', 'ProMaster'],
  'Subaru': ['Ascent', 'Crosstrek', 'Forester', 'Impreza', 'Legacy', 'Outback'],
  'Tesla': ['Model 3', 'Model S', 'Model X', 'Model Y'],
  'Toyota': ['4Runner', 'Camry', 'Corolla', 'Highlander', 'RAV4', 'Sequoia', 'Sienna', 'Tacoma', 'Tundra'],
  'Volkswagen': ['Atlas', 'Jetta', 'Passat', 'Tiguan'],
  'Volvo': ['XC40', 'XC60', 'XC90']
};


// ---------------------------------------------------------------------------
// 3. Page startup
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', function() {
  setupVehicleAutocomplete();
  restoreFormDraft();

  const form = document.getElementById('permissionForm');
  const formType = document.getElementById('formType');

  if (formType) {
    formType.addEventListener('change', function() {
      updatePrintHeader();
      toggleFormType();
    });
  }

  if (form) {
    form.addEventListener('input', e => {
      const t = e.target;
      if (t.type !== 'tel' || (e.inputType && e.inputType.startsWith('delete'))) return;
      const formatted = formatPhone(t.value);
      if (formatted !== t.value) t.value = formatted;
    });
    form.addEventListener('input', saveFormDraft);
    form.addEventListener('change', saveFormDraft);
    form.addEventListener('submit', handleFormSubmit);
    const scoutSelector = document.getElementById('scoutSelector');
    if (scoutSelector) scoutSelector.addEventListener('change', e => onScoutSelected(e.target.value));
  }

  const signOutBtn = document.getElementById('signOutBtn');
  if (signOutBtn) signOutBtn.addEventListener('click', TroopAuth.signOut);

  toggleFormType();
  updatePrintHeader();
});

// Shared sign-in (auth.js): also restores a sign-in made on another page of this site.
TroopAuth.start({
  buttonId: 'googleSignInBtn',
  buttonSize: 'large',
  onSignIn: (token) => handleCredentialResponse({ credential: token }),
  onSignOut: clearSignedInState
});


// ---------------------------------------------------------------------------
// 4. Trip details
// ---------------------------------------------------------------------------

function showTripUnavailable(message) {
  const title = document.getElementById('tripTitle');
  if (title) title.textContent = message;
  const form = document.getElementById('permissionForm');
  if (form) form.hidden = true;
}

function loadTripDetails() {
  if (!TRIP_ID) { showTripUnavailable('No trip selected. Open this form from the trip list.'); return; }
  fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    body: JSON.stringify({ action: 'slipTrip', tripId: TRIP_ID, idToken: window.currentIdToken })
  })
    .then(res => res.json())
    .then(data => {
      if (data.code === 'signin') { TroopAuth.signOut(); return; }
      if (data.status === 'error') { showTripUnavailable(data.message || 'This trip is unavailable.'); return; }
      Object.keys(data).forEach(key => {
        const val = data[key];
        if (val === undefined || val === null) return;
        if (key === '_tripRevision') {
          window.currentTripId = val;
          return;
        }
        // An empty override must not wipe the standard departure text inside this span.
        if (key === 'customDepartureHtml' && String(val).trim() === '') return;

        const element = document.getElementById(key);
        if (element) {
          if (typeof val === 'string' && (val.includes('<') && val.includes('>'))) {
            element.innerHTML = val;
          } else if ('value' in element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT')) {
            element.value = val;
          } else {
            element.innerText = val;
          }
        }
      });
    })
    .catch(err => console.error("Error loading trip data:", err));
}


// ---------------------------------------------------------------------------
// 5. Form state (youth/adult toggle, drafts)
// ---------------------------------------------------------------------------

function toggleFormType() {
  const isYouth = document.getElementById('formType').value === 'Youth';
  setSectionActive(document.getElementById('youthSection'), isYouth);
  setSectionActive(document.getElementById('adultSection'), !isYouth);
}

function setSectionActive(section, active) {
  if (!section) return;
  section.disabled = !active;
  section.hidden = !active;
}

function updatePrintHeader() {
  const formType = document.getElementById('formType');
  const header = document.getElementById('printHeader');

  if (!formType || !header) return;
  header.textContent = formType.value === 'Adult' ? 'ADULT PERMISSION SLIP' : 'YOUTH PERMISSION SLIP';
}

function saveFormDraft() {
  const form = document.getElementById('permissionForm');
  if (!form) return;

  let previous = {};
  try { previous = JSON.parse(localStorage.getItem(DRAFT_KEY)) || {}; } catch (e) {}

  const data = Object.assign(previous, extractFormData(form, { skipSignatures: false }));
  data._tripId = window.currentTripId || null;
  localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
}

function restoreFormDraft() {
  const savedData = localStorage.getItem(DRAFT_KEY);
  if (!savedData) return;
  try {
    const data = JSON.parse(savedData);
    if (data._tripId && window.currentTripId && data._tripId !== window.currentTripId) {
      localStorage.removeItem(DRAFT_KEY);
      return;
    }
    const form = document.getElementById('permissionForm');
    populateFormFields(form, data, { skipSignatures: false });
  } catch (e) {
    console.error(e);
  }
}


// ---------------------------------------------------------------------------
// 6. Form field helpers
// ---------------------------------------------------------------------------

function isSignatureOrDateField(key) {
  const k = key.toLowerCase();
  return k.includes('signature') || k.includes('sigdate') || k.includes('sign_date');
}

function extractFormData(form, options = { skipSignatures: false }) {
  const formData = new FormData(form);
  const data = {};
  formData.forEach((value, key) => {
    if (options.skipSignatures && isSignatureOrDateField(key)) return;
    if (data[key]) {
      if (!Array.isArray(data[key])) data[key] = [data[key]];
      data[key].push(value);
    } else {
      data[key] = value;
    }
  });
  return data;
}

function populateFormFields(form, data, options = { skipSignatures: false }) {
  Object.keys(data).forEach(key => {
    if (key.startsWith('_')) return;
    if (options.skipSignatures && isSignatureOrDateField(key)) return;

    const elements = form.querySelectorAll(`[name="${key}"]`);
    const value = data[key];

    elements.forEach(el => {
      if (el.type === 'checkbox' || el.type === 'radio') {
        el.checked = Array.isArray(value) ? value.includes(el.value) : (el.value === value);
      } else {
        el.value = el.type === 'tel' ? formatPhone(value) : value;
      }
    });
  });

  if (data.youthProfiles) {
    renderYouthSelector(data.youthProfiles);
  }
  if (window.refreshVehicleModels) window.refreshVehicleModels();
}

// Formats US numbers as (555) 555-1234 while typing. Anything with more than 10 digits
// (extensions, international) is left as typed so nothing is lost.
function formatPhone(value) {
  const raw = String(value == null ? '' : value);
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length > 10 || /[^\d\s()+.\-]/.test(raw)) return raw;
  if (d.length === 0) return '';
  if (d.length < 4) return d.length === raw.trim().length ? d : '(' + d;
  if (d.length < 7) return '(' + d.slice(0, 3) + ') ' + d.slice(3);
  return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
}

function setupVehicleAutocomplete() {
  const makeList = document.getElementById('vehMakeList');
  const modelList = document.getElementById('vehModelList');
  const make = document.getElementById('vehMake');
  const model = document.getElementById('vehModel');
  if (!makeList || !modelList || !make || !model) return;

  Object.keys(VEHICLE_MODELS).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    makeList.appendChild(opt);
  });

  const findMake = () => {
    const typed = make.value.trim().toLowerCase();
    return Object.keys(VEHICLE_MODELS).find(k => k.toLowerCase() === typed);
  };

  const refreshModels = () => {
    const key = findMake();
    modelList.replaceChildren();
    (key ? VEHICLE_MODELS[key] : []).forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      modelList.appendChild(opt);
    });
  };

  make.addEventListener('input', refreshModels);
  make.addEventListener('change', refreshModels);
  refreshModels();
  // Profile/draft values are filled in after load, so refresh when the make is set programmatically.
  window.refreshVehicleModels = refreshModels;
}


// ---------------------------------------------------------------------------
// 7. Submission
// ---------------------------------------------------------------------------

function handleFormSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const formData = new FormData(form);
  const payload = {};

  formData.forEach((value, key) => {
    if (payload[key]) {
      if (!Array.isArray(payload[key])) payload[key] = [payload[key]];
      payload[key].push(value);
    } else {
      payload[key] = value;
    }
  });
  payload._tripId = TRIP_ID;
  payload._tripRevision = window.currentTripId || '';
  payload._slipSnapshot = buildSlipSnapshot(form);
  if (window.currentIdToken) payload._idToken = window.currentIdToken;

  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  setSubmitting(true);

  fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
  .then(res => res.json())
  .then(response => {
    setSubmitting(false); // clear before alert(), which blocks the page
    if (response.status === 'success') {
      alert("Permission slip submitted successfully! Thank you.");
      if (window.currentIdToken) saveUserProfile(); // also cache locally
      localStorage.removeItem(DRAFT_KEY);
      form.reset();
      toggleFormType();
      updatePrintHeader();
    } else if (response.code === 'signin') {
      saveFormDraft();
      alert(response.message);
      TroopAuth.signOut();
    } else if (response.code === 'trip_changed') {
      form.querySelectorAll('input[name*="signature" i]').forEach(el => {
        el.value = '';
      });
      saveFormDraft();
      alert(response.message);
    } else {
      alert("Submission error: " + response.message + "\nYour entries are saved on this device. Please wait a minute and press Submit again.");
    }
  })
  .catch(err => {
    setSubmitting(false);
    alert("Network error submitting form. Your entries are saved on this device. Please wait a minute and press Submit again.");
    console.error(err);
  })
  .finally(() => {
    setSubmitting(false);
    if (submitBtn) submitBtn.disabled = false;
  });
}

function setSubmitting(on) {
  let overlay = document.getElementById('submitOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'submitOverlay';
    overlay.setAttribute('role', 'alert');
    overlay.innerHTML = '<div class="submit-box"><div class="spinner" aria-hidden="true"></div>' +
      '<p>Submitting your permission slip&hellip;<br>Please keep this page open.</p></div>';
    document.body.appendChild(overlay);
  }
  overlay.hidden = !on;
}

// Captures what the signer saw (visible text, trip details, entered values) as lines of
// segments. The server hashes the fixed wording from this to record which text was signed.
// Segment: { s: text, v: 1 if it is a typed value, sig: 1 if it is a signature }.
function buildSlipSnapshot(form) {
  const lines = [];
  let cur = [];
  let level = 0;

  const flush = () => {
    const segs = cur;
    cur = [];
    if (!segs.some(sg => sg.s.trim() !== '' || sg.v)) return;
    if (!segs[0].v) segs[0].s = segs[0].s.replace(/^\s+/, '');
    const last = segs[segs.length - 1];
    if (!last.v) last.s = last.s.replace(/\s+$/, '');
    lines.push({ h: level, segs });
  };

  const walk = node => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent.replace(/\s+/g, ' ');
      if (t) cur.push({ s: t });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (['SCRIPT', 'STYLE', 'SELECT', 'BUTTON', 'IMG', 'LEGEND'].includes(tag)) return;
    if (node.getAttribute('aria-hidden') === 'true' || node.classList.contains('sr-only')) return;
    if (node.id === 'scoutSelectorContainer' || node.classList.contains('signin')) return;
    if (getComputedStyle(node).display === 'none') return;

    if (tag === 'BR') { flush(); return; }
    if (tag === 'INPUT') {
      if (node.type === 'radio') cur.push({ s: node.checked ? '[X] ' : '[ ] ' });
      else cur.push({ s: node.value || '', v: 1, sig: /signature/i.test(node.name) ? 1 : 0 });
      return;
    }

    const isBlock = ['P', 'DIV', 'H1', 'H2', 'H3', 'FIELDSET'].includes(tag);
    const prevLevel = level;
    if (isBlock) {
      flush();
      if (tag === 'H2') level = 2;
      else if (tag === 'H3') level = 3;
    }
    node.childNodes.forEach(walk);
    if (isBlock) {
      flush();
      level = prevLevel;
    }
  };

  const type = form.querySelector('#formType');
  cur.push({ s: (type && type.value === 'Adult' ? 'ADULT' : 'YOUTH') + ' PERMISSION SLIP' });
  level = 1;
  flush();
  level = 0;
  form.childNodes.forEach(walk);
  flush();
  return lines;
}


// ---------------------------------------------------------------------------
// 8. Google sign-in and saved profiles
// ---------------------------------------------------------------------------

function handleCredentialResponse(response) {
  const responsePayload = TroopAuth.parseJwt(response.credential);
  // The raw token is what the server verifies. The decoded 'sub' is only
  // used locally as a cache key; the server never trusts a client-supplied ID.
  window.currentIdToken = response.credential;
  window.currentUserGoogleId = responsePayload.sub;
  setSignedInUI(responsePayload.email || responsePayload.name);
  loadTripDetails();

  const pName = document.getElementById('parentName');
  const pEmail = document.getElementById('parentEmail');

  if (pName && responsePayload.name) pName.value = responsePayload.name;
  if (pEmail && responsePayload.email) pEmail.value = responsePayload.email;

  loadUserProfile(responsePayload.sub);

  document.querySelectorAll('#permissionForm input[name*="signature" i]').forEach(el => {
    el.value = '';
  });
}

function setSignedInUI(label) {
  const btn = document.getElementById('googleSignInBtn');
  const status = document.getElementById('signedInStatus');
  const user = document.getElementById('signedInUser');
  const form = document.getElementById('permissionForm');
  if (btn) btn.hidden = !!label;
  if (status) status.hidden = !label;
  if (user) user.textContent = label || '';
  if (form) form.classList.toggle('needs-signin', !label);
}

function clearSignedInState() {
  window.currentIdToken = null;
  window.currentUserGoogleId = null;
  setSignedInUI(null);
}

function loadUserProfile(googleUserId) {
  if (!googleUserId) return;

  const localCache = localStorage.getItem(`user_profile_${googleUserId}`);
  if (localCache && localCache !== '{}') {
    let cached = null;
    try { cached = JSON.parse(localCache); } catch (e) {}
    if (cached) {
      populateFormFields(document.getElementById('permissionForm'), cached, { skipSignatures: true });
    }
  }

  // Always refresh from the server: the local cache is built from submitted form data, which
  // omits the disabled (hidden) form section, so it can lack adult or scout fields.
  // POST (not GET) so the token never appears in a URL or server log.
  fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    body: JSON.stringify({ action: 'getProfile', idToken: window.currentIdToken })
  })
    .then(res => res.json())
    .then(profileData => {
      if (profileData && !profileData.error && Object.keys(profileData).length > 0) {
        populateFormFields(document.getElementById('permissionForm'), profileData, { skipSignatures: true });
        let merged = {};
        try { merged = JSON.parse(localStorage.getItem(`user_profile_${googleUserId}`)) || {}; } catch (e) {}
        localStorage.setItem(`user_profile_${googleUserId}`, JSON.stringify(Object.assign(merged, profileData)));
        saveFormDraft();
      }
    })
    .catch(err => console.log('Offline or profile fetch error:', err));
}

function saveUserProfile() {
  const googleUserId = window.currentUserGoogleId;
  if (!googleUserId || !window.currentIdToken) return;
  const form = document.getElementById('permissionForm');
  const profileData = extractFormData(form, { skipSignatures: true });
  delete profileData['Form Type'];
  delete profileData['website_url'];

  const cacheKey = `user_profile_${googleUserId}`;
  let cached = {};
  try { cached = JSON.parse(localStorage.getItem(cacheKey)) || {}; } catch (e) {}
  const youthFields = {};
  Object.keys(profileData).forEach(k => { if (k.startsWith('Youth ')) youthFields[k] = profileData[k]; });
  const youthName = String(youthFields['Youth Name'] || '').trim();
  if (youthName) {
    const list = Array.isArray(cached.youthProfiles) ? cached.youthProfiles : [];
    const i = list.findIndex(y => String(y['Youth Name'] || '').trim().toLowerCase() === youthName.toLowerCase());
    if (i >= 0) list[i] = Object.assign(list[i], youthFields); else list.push(youthFields);
    cached.youthProfiles = list;
    renderYouthSelector(list);
  }
  localStorage.setItem(cacheKey, JSON.stringify(Object.assign(cached, profileData)));
}

function renderYouthSelector(youthProfiles) {
  const container = document.getElementById('scoutSelectorContainer');
  const selector = document.getElementById('scoutSelector');
  if (!container || !selector) return;

  window.userYouthProfiles = youthProfiles || [];
  container.hidden = window.userYouthProfiles.length === 0;

  selector.querySelectorAll('option[data-scout]').forEach(o => o.remove());
  const addNew = selector.querySelector('option[value="new"]');
  window.userYouthProfiles.forEach((y, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.dataset.scout = '1';
    opt.textContent = y['Youth Name'] || '';
    selector.insertBefore(opt, addNew);
  });
}

function onScoutSelected(selectedIndex) {
  const form = document.getElementById('permissionForm');
  const youthFields = form.querySelectorAll('#youthSection [name^="Youth "]');
  const selectedScout = (selectedIndex === '' || selectedIndex === 'new')
    ? null : window.userYouthProfiles[selectedIndex];
  if (selectedIndex !== '' && selectedIndex !== 'new' && !selectedScout) return;

  youthFields.forEach(el => {
    if (isSignatureOrDateField(el.name)) return;
    const saved = selectedScout && selectedScout[el.name] != null ? selectedScout[el.name] : '';
    el.value = el.type === 'tel' ? formatPhone(saved) : saved;
  });

  saveFormDraft();
}
