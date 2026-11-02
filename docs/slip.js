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
    const scoutNameInput = document.getElementById('scoutName');
    if (scoutNameInput) {
      scoutNameInput.addEventListener('change', e => {
        const name = e.target.value.trim().toLowerCase();
        const found = (window.userYouthProfiles || []).find(s => String(s['Youth Name'] || s['Name'] || '').trim().toLowerCase() === name);
        if (found) fillScoutProfile(found);
      });
    }
  }

  const signOutBtn = document.getElementById('signOutBtn');
  if (signOutBtn) signOutBtn.addEventListener('click', TroopAuth.signOut);

  const manageProfilesBtn = document.getElementById('manageProfilesBtn');
  const profilesDialog = document.getElementById('profilesDialog');
  const closeProfilesModal = document.getElementById('closeProfilesModal');
  const profilesModalForm = document.getElementById('profilesModalForm');
  const modalScoutSelect = document.getElementById('modalScoutSelect');

  const modalProfileSelect = document.getElementById('modalProfileSelect');
  const youthExtraFields = document.getElementById('youthExtraFields');
  const adultExtraFields = document.getElementById('adultExtraFields');

  if (manageProfilesBtn && profilesDialog) {
    manageProfilesBtn.addEventListener('click', () => {
      populateModalProfileDropdown();
      profilesDialog.showModal();
    });
  }
  if (closeProfilesModal && profilesDialog) {
    closeProfilesModal.addEventListener('click', () => profilesDialog.close());
  }

  if (modalProfileSelect) {
    modalProfileSelect.addEventListener('change', (e) => {
      const val = e.target.value;
      const isAdultKind = val === 'add_adult' || (val !== '' && val !== 'add_scout' && window.userProfilesMap && window.userProfilesMap[val] && window.userProfilesMap[val].kind === 'adult');
      
      if (youthExtraFields) youthExtraFields.hidden = isAdultKind;
      if (adultExtraFields) adultExtraFields.hidden = !isAdultKind;
      document.getElementById('modalProfileKind').value = isAdultKind ? 'adult' : 'youth';

      if (val === '' || val === 'add_scout' || val === 'add_adult') {
        document.getElementById('modalScoutName').value = '';
        document.getElementById('modalGender').value = '';
        document.getElementById('modalBirthMonth').value = '';
        document.getElementById('modalHomePatrol').value = '';
        document.getElementById('modalAuthorizedEmails').value = '';
        document.getElementById('modalEmergencyPhone').value = '';
        document.getElementById('modalMedicalNotes').value = '';
        if (adultExtraFields) {
          document.getElementById('modalVehicleMake').value = '';
          document.getElementById('modalAvailableSeats').value = '';
          document.getElementById('modalYptDate').value = '';
        }
      } else if (window.userProfilesMap && window.userProfilesMap[val]) {
        const p = window.userProfilesMap[val];
        document.getElementById('modalScoutName').value = p['Name'] || p['Youth Name'] || p['Adult Name'] || '';
        document.getElementById('modalGender').value = p['Gender'] || '';
        document.getElementById('modalBirthMonth').value = p['Birth Month'] || '';
        document.getElementById('modalHomePatrol').value = p['Home Patrol'] || '';
        document.getElementById('modalAuthorizedEmails').value = p['Authorized Emails'] || '';
        document.getElementById('modalEmergencyPhone').value = p['Emergency Phone'] || p['Youth Emergency Phone'] || p['Adult Emergency Phone'] || '';
        document.getElementById('modalMedicalNotes').value = p['Medical Notes'] || '';
        if (adultExtraFields && isAdultKind) {
          document.getElementById('modalVehicleMake').value = p['Vehicle Make'] || '';
          document.getElementById('modalAvailableSeats').value = p['Available Seats'] || '';
          document.getElementById('modalYptDate').value = p['Ypt Date'] || '';
        }
      }
    });
  }

  if (profilesModalForm) {
    profilesModalForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const kind = document.getElementById('modalProfileKind').value;
      const name = document.getElementById('modalScoutName').value.trim();
      if (!name) return;

      const profileData = {
        'Profile Kind': kind,
        'Name': name,
        'Gender': document.getElementById('modalGender').value.trim(),
        'Authorized Emails': document.getElementById('modalAuthorizedEmails').value.trim(),
        'Emergency Phone': document.getElementById('modalEmergencyPhone').value.trim(),
        'Medical Notes': document.getElementById('modalMedicalNotes').value.trim()
      };
      if (kind === 'youth') {
        profileData['Youth Name'] = name;
        profileData['Birth Month'] = document.getElementById('modalBirthMonth').value.trim();
        profileData['Home Patrol'] = document.getElementById('modalHomePatrol').value.trim();
        profileData['Youth Emergency Phone'] = profileData['Emergency Phone'];
      } else {
        profileData['Adult Name'] = name;
        profileData['Vehicle Make'] = document.getElementById('modalVehicleMake').value.trim();
        profileData['Available Seats'] = document.getElementById('modalAvailableSeats').value.trim();
        profileData['Ypt Date'] = document.getElementById('modalYptDate').value.trim();
        profileData['Adult Emergency Phone'] = profileData['Emergency Phone'];
      }

      fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        body: JSON.stringify({ action: 'saveProfile', idToken: window.currentIdToken, profileData })
      })
        .then(res => res.json())
        .then(r => {
          if (r.status === 'success') {
            profilesDialog.close();
            loadUserProfile(window.currentUserGoogleId || 'user');
          }
        })
        .catch(err => console.error('Error saving profile:', err));
    });
  }

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

function applyTripDetails(data) {
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
}

// The hub caches each open trip's slip config (the same data slipTrip returns) in
// sessionStorage, so arriving from the hub needs no server call. Edits made to the sheet
// afterwards are caught on submit by the _tripRevision check.
function cachedTripDetails() {
  try {
    const trips = JSON.parse(sessionStorage.getItem('troop58_trips') || '[]');
    const trip = trips.find(t => t && t.tripId === TRIP_ID);
    return trip && trip.slip ? trip.slip : null;
  } catch (e) { return null; }
}

function loadTripDetails() {
  if (!TRIP_ID) { showTripUnavailable('No trip selected. Open this form from the trip list.'); return; }

  const cached = cachedTripDetails();
  if (cached) { applyTripDetails(cached); return; }

  fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    body: JSON.stringify({ action: 'slipTrip', tripId: TRIP_ID, idToken: window.currentIdToken })
  })
    .then(res => res.json())
    .then(data => {
      if (data.code === 'signin') { TroopAuth.signOut(); return; }
      if (data.status === 'error') { showTripUnavailable(data.message || 'This trip is unavailable.'); return; }
      applyTripDetails(data);
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

  const parentEmails = document.getElementById('parentEmails');
  if (parentEmails && !parentEmails.value.trim() && responsePayload.email) {
    parentEmails.value = responsePayload.email;
  }
  const adultEmails = document.getElementById('adultEmails');
  if (adultEmails && !adultEmails.value.trim() && responsePayload.email) {
    adultEmails.value = responsePayload.email;
  }

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
  const cacheKey = `troop58_scouts_${googleUserId}`;
  let scouts = [];
  try { scouts = JSON.parse(localStorage.getItem(cacheKey)) || []; } catch (e) {}
  window.userYouthProfiles = scouts;
  updateScoutDatalist(scouts);

  fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    body: JSON.stringify({ action: 'getProfile', idToken: window.currentIdToken })
  })
    .then(res => res.json())
    .then(profileData => {
      if (profileData && !profileData.error) {
        if (Array.isArray(profileData.youthProfiles) && profileData.youthProfiles.length > 0) {
          window.userYouthProfiles = profileData.youthProfiles;
          localStorage.setItem(cacheKey, JSON.stringify(profileData.youthProfiles));
          updateScoutDatalist(profileData.youthProfiles);
          // Auto-fill first scout if name is empty
          const scoutNameInput = document.getElementById('scoutName');
          if (scoutNameInput && !scoutNameInput.value.trim()) {
            fillScoutProfile(profileData.youthProfiles[0]);
          }
        }
      }
    })
    .catch(err => console.log('Profile fetch error:', err));
}

function updateScoutDatalist(scouts) {
  const list = document.getElementById('scoutNamesList');
  if (!list) return;
  list.innerHTML = '';
  scouts.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s['Youth Name'] || s['Name'] || '';
    list.appendChild(opt);
  });
}

function fillScoutProfile(scout) {
  if (!scout) return;
  document.getElementById('scoutName').value = scout['Youth Name'] || scout['Name'] || '';
  if (document.getElementById('scoutGender')) document.getElementById('scoutGender').value = scout['Gender'] || '';
  if (document.getElementById('birthYear')) document.getElementById('birthYear').value = scout['Birth Year'] || '';
  if (document.getElementById('birthMonth')) document.getElementById('birthMonth').value = scout['Birth Month'] || '';
  if (document.getElementById('scoutPatrol')) document.getElementById('scoutPatrol').value = scout['Patrol'] || scout['Home Patrol'] || '';
  if (document.getElementById('scoutRank')) document.getElementById('scoutRank').value = scout['Rank'] || '';
  if (document.getElementById('scoutPosition')) document.getElementById('scoutPosition').value = scout['Position'] || '';
  if (document.getElementById('parentEmails')) document.getElementById('parentEmails').value = scout['Authorized Emails'] || '';
  if (document.getElementById('emergencyContact')) document.getElementById('emergencyContact').value = scout['Youth Emergency Phone'] || scout['Emergency Phone'] || '';
  if (document.getElementById('medicalNotes')) document.getElementById('medicalNotes').value = scout['Medical Notes'] || '';
}

function saveUserProfile() {
  const googleUserId = window.currentUserGoogleId;
  if (!googleUserId || !window.currentIdToken) return;
  const form = document.getElementById('permissionForm');
  const profileData = extractFormData(form, { skipSignatures: true });
  delete profileData['Form Type'];
  delete profileData['website_url'];

  const cacheKey = `troop58_scouts_${googleUserId}`;
  let scouts = [];
  try { scouts = JSON.parse(localStorage.getItem(cacheKey)) || []; } catch (e) {}

  const scoutName = String(profileData['Youth Name'] || '').trim();
  if (!scoutName) return;

  const existingIdx = scouts.findIndex(s => String(s['Youth Name'] || s['Name'] || '').trim().toLowerCase() === scoutName.toLowerCase());
  if (existingIdx >= 0) {
    scouts[existingIdx] = Object.assign(scouts[existingIdx], profileData);
  } else {
    scouts.push(profileData);
  }
  localStorage.setItem(cacheKey, JSON.stringify(scouts));
  updateScoutDatalist(scouts);

  // Send to server
  fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    body: JSON.stringify({ action: 'saveProfile', idToken: window.currentIdToken, profileData: { 'Youth Name': scoutName, youthProfiles: scouts } })
  }).catch(err => console.error('Save profile error:', err));
}

function populateModalProfileDropdown() {
  const sel = document.getElementById('modalProfileSelect');
  if (!sel) return;
  sel.length = 3; // Keep default, add_scout, add_adult
  window.userProfilesMap = {};

  (window.userYouthProfiles || []).forEach((y, idx) => {
    const key = 'youth_' + idx;
    window.userProfilesMap[key] = Object.assign({ kind: 'youth' }, y);
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = (y['Youth Name'] || 'Scout') + ' (Scout)';
    sel.insertBefore(opt, sel.querySelector('option[value="add_scout"]'));
  });

  // If adult profile exists in local cache or profiles
  if (window.userAdultProfile) {
    const key = 'adult_0';
    window.userProfilesMap[key] = Object.assign({ kind: 'adult' }, window.userAdultProfile);
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = (window.userAdultProfile['Adult Name'] || window.userAdultProfile['Name'] || 'Adult') + ' (Adult)';
    sel.insertBefore(opt, sel.querySelector('option[value="add_scout"]'));
  }

  sel.value = '';
  document.getElementById('modalProfileKind').value = 'youth';
  if (document.getElementById('youthExtraFields')) document.getElementById('youthExtraFields').hidden = false;
  if (document.getElementById('adultExtraFields')) document.getElementById('adultExtraFields').hidden = true;

  document.getElementById('modalScoutName').value = '';
  document.getElementById('modalGender').value = '';
  document.getElementById('modalBirthMonth').value = '';
  document.getElementById('modalHomePatrol').value = '';
  document.getElementById('modalAuthorizedEmails').value = '';
  document.getElementById('modalEmergencyPhone').value = '';
  document.getElementById('modalMedicalNotes').value = '';
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

  if (window.userYouthProfiles.length > 0 && (selector.value === '' || selector.value === 'new')) {
    selector.value = '0';
    onScoutSelected(0);
  }
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
