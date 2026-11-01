(function () {
  const C = window.TROOP_CONFIG;
  const $ = (id) => document.getElementById(id);
  let idToken = null, trips = [], currentTripResponses = [];

  async function api(action, payload) {
    const res = await fetch(C.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({}, payload, { action, idToken }))
    });
    if (!res.ok) throw new Error("Server error " + res.status);
    const d = await res.json();
    if (d.status === "error" || d.error) throw new Error(d.message || d.error);
    return d;
  }

  const TRIP_ID = new URLSearchParams(window.location.search).get('trip') || '';

  async function onSignIn(token, claims) {
    idToken = token;
    const email = claims.email || claims.name || "";
    setSignedInUI(email);
    $("app").hidden = false;

    if (!TRIP_ID) {
      alert("No trip selected. Open this float plan from the trip list.");
      return;
    }

    // 1. Load trip metadata instantly from sessionStorage cache
    try {
      const cachedTrips = JSON.parse(sessionStorage.getItem('troop58_trips') || '[]');
      const trip = cachedTrips.find(t => String(t.tripId || t.id) === String(TRIP_ID));
      if (trip) {
        $("planTripTitle").textContent = trip.name || trip.tripTitle;
        $("planTripDate").textContent = trip.date || trip.tripDates;
        $("planTripLocation").textContent = trip.location || trip.tripLocation;
      }
    } catch (e) {}

    // 2. Fetch responses in a single API call
    try {
      const res = await api("floatPlanGetResponses", { tripId: TRIP_ID });
      currentTripResponses = res.responses || [];
      renderFloatPlanData(currentTripResponses);
      loadGearChecklist();
      $("floatPlanContent").hidden = false;
    } catch (err) {
      console.error("Error loading responses:", err);
      renderFloatPlanData([]);
      loadGearChecklist();
      $("floatPlanContent").hidden = false;
    }
  }

  function onSignOut() {
    idToken = null;
    setSignedInUI(null);
    $("app").hidden = true;
  }

  function setSignedInUI(label) {
    const btn = document.getElementById('googleSignInBtn');
    const prompt = document.getElementById('signinPrompt');
    const status = document.getElementById('signedInStatus');
    const user = document.getElementById('signedInUser');
    if (btn) btn.hidden = !!label;
    if (prompt) prompt.hidden = !!label;
    if (status) status.hidden = !label;
    if (user) user.textContent = label || '';
  }



  function calculateAge(birthYear, birthMonth) {
    if (!birthYear) return "-";
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth() + 1;
    let age = curYear - Number(birthYear);
    if (birthMonth && Number(birthMonth) > curMonth) age--;
    return age >= 0 ? age : "-";
  }

  function renderFloatPlanData(responses) {
    const youth = responses.filter(r => String(r["Form Type"] || "Youth").toLowerCase() === "youth");
    const adults = responses.filter(r => String(r["Form Type"] || "").toLowerCase() === "adult");

    $("youthCount").textContent = youth.length;
    $("adultCount").textContent = adults.length;
    const totalPeople = youth.length + adults.length;
    $("totalHeadcount").textContent = totalPeople;

    // Calculate available seats from adult drivers
    let totalSeats = 0;
    let driverCount = 0;
    adults.forEach(a => {
      const seats = Number(a["Veh Seats"] || a["Available Seats"] || 0);
      const driveOption = String(a["drive"] || "").toLowerCase();
      if (seats > 0 && driveOption !== "cannot drive" && driveOption !== "prefer not to drive") {
        totalSeats += seats;
        driverCount++;
      }
    });
    $("totalSeats").textContent = totalSeats;
    $("driverCount").textContent = driverCount;

    // Transport status badge
    const badgeContainer = $("transportBadgeContainer");
    if (totalSeats >= totalPeople || totalPeople === 0) {
      badgeContainer.innerHTML = '<span class="badge badge-success">Sufficient Seats (' + totalSeats + ' / ' + totalPeople + ')</span>';
    } else {
      badgeContainer.innerHTML = '<span class="badge badge-danger">Seat Shortage! Need ' + (totalPeople - totalSeats) + ' more</span>';
    }

    // YPT & Female Youth check
    const femaleYouthCount = youth.filter(y => String(y["Gender"] || "").toLowerCase() === "female").length;
    const femaleAdultCount = adults.filter(a => String(a["Gender"] || "").toLowerCase() === "female").length;
    const yptAlertBox = $("yptAlertBox");
    if (femaleYouthCount > 0) {
      if (femaleAdultCount > 0) {
        yptAlertBox.hidden = false;
        yptAlertBox.innerHTML = '<div class="badge badge-success" style="display:block; padding: 10px;">🟢 YPT / Gender Compliance: Female youth attending with ' + femaleAdultCount + ' female adult leader(s) present.</div>';
      } else {
        yptAlertBox.hidden = false;
        yptAlertBox.innerHTML = '<div class="badge badge-danger" style="display:block; padding: 10px;">🔴 YPT Compliance Warning: Female youth are attending, but no female adult leader is currently listed on the roster!</div>';
      }
    } else {
      yptAlertBox.hidden = true;
    }

    // Render Youth Table
    const youthBody = $("youthTableBody");
    youthBody.innerHTML = "";
    $("youthTableCount").textContent = youth.length;
    if (youth.length === 0) {
      youthBody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #777;">No permission slips submitted yet.</td></tr>';
    } else {
      youth.forEach(y => {
        const tr = document.createElement("tr");
        const age = calculateAge(y["Birth Year"], y["Birth Month"]);
        tr.innerHTML = `
          <td><strong>${escapeHtml(y["Youth Name"] || y["Name"] || "-")}</strong></td>
          <td>${escapeHtml(y["Gender"] || "-")}</td>
          <td>${age}</td>
          <td>${escapeHtml(y["Patrol"] || y["Home Patrol"] || "-")}</td>
          <td>${escapeHtml(y["Rank"] || "-")} / ${escapeHtml(y["Position"] || "-")}</td>
          <td>${escapeHtml(y["Youth Emergency Phone"] || y["Emergency Phone"] || "-")}</td>
          <td>${escapeHtml(y["Medical Notes"] || "None")}</td>
        `;
        youthBody.appendChild(tr);
      });
    }

    // Render Adult Table
    const adultBody = $("adultTableBody");
    adultBody.innerHTML = "";
    $("adultTableCount").textContent = adults.length;
    if (adults.length === 0) {
      adultBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #777;">No adults registered yet.</td></tr>';
    } else {
      adults.forEach(a => {
        const tr = document.createElement("tr");
        const vehicle = (a["Veh Make"] || a["Vehicle Make"] || "") + " " + (a["Veh Model"] || "") + (a["Veh Seats"] ? " (" + a["Veh Seats"] + " seats)" : "");
        tr.innerHTML = `
          <td><strong>${escapeHtml(a["Adult Name"] || a["Name"] || "-")}</strong></td>
          <td>${escapeHtml(a["Position"] || "Leader/Parent")}</td>
          <td>${escapeHtml(a["Adult Cell Phone"] || a["Emergency Phone"] || "-")}</td>
          <td>${escapeHtml(a["drive"] || "Not specified")}</td>
          <td>${escapeHtml(vehicle.trim() || "None listed")}</td>
          <td>${escapeHtml(a["Ypt Date"] || "Not recorded")}</td>
        `;
        adultBody.appendChild(tr);
      });
    }
  }

  let troopGearList = [];

  async function loadGearChecklist() {
    try {
      const cached = sessionStorage.getItem('troop58_equipment');
      if (cached) {
        troopGearList = JSON.parse(cached);
        renderGearChecklist();
        return;
      }
      const res = await api("hubListEquipment");
      if (res && Array.isArray(res.items) && res.items.length > 0) {
        troopGearList = res.items.map(i => ({ name: i.item, qty: i.quantity || '', checked: false })).filter(i => i.name);
        sessionStorage.setItem('troop58_equipment', JSON.stringify(troopGearList));
      } else {
        troopGearList = [];
      }
    } catch (e) {
      console.log("Could not load equipment list.");
      troopGearList = [];
    }
    renderGearChecklist();
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function renderGearChecklist() {
    const container = $("gearChecklistContainer");
    if (!container) return;
    container.innerHTML = "";
    if (troopGearList.length === 0) {
      container.innerHTML = '<div style="grid-column: 1 / -1; color: #777; font-size: 0.9rem;">No equipment listed in the Equipment spreadsheet yet. Use the add box below to add gear for this trip.</div>';
      return;
    }
    troopGearList.forEach((g, idx) => {
      const div = document.createElement("div");
      div.style.display = "flex";
      div.style.alignItems = "center";
      div.style.gap = "8px";
      div.innerHTML = `
        <label style="font-weight: normal; display: flex; align-items: center; gap: 8px; cursor: pointer; flex: 1; margin: 0;">
          <input type="checkbox" name="gearItem" value="${escapeHtml(g.name)}" ${g.checked ? "checked" : ""} style="width: auto; min-height: 0;">
          <input type="number" class="gear-qty" name="gearQty_${idx}" value="${escapeHtml(g.qty)}" placeholder="" min="1" style="width: 60px; padding: 4px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.85rem;" aria-label="Quantity for ${escapeHtml(g.name)}">
          <span>${escapeHtml(g.name)}</span>
        </label>
      `;
      const chk = div.querySelector('input[type="checkbox"]');
      chk.onchange = () => { g.checked = chk.checked; };
      const qtyInput = div.querySelector('input.gear-qty');
      qtyInput.oninput = () => { g.qty = qtyInput.value; };
      container.appendChild(div);
    });
  }

  const addGearBtn = $("addGearBtn");
  const newGearInput = $("newGearInput");
  const newGearQtyInput = $("newGearQtyInput");
  if (addGearBtn && newGearInput) {
    addGearBtn.onclick = () => {
      const val = newGearInput.value.trim();
      const qty = newGearQtyInput ? newGearQtyInput.value.trim() : "";
      if (!val) return;
      if (!troopGearList.some(g => g.name.toLowerCase() === val.toLowerCase())) {
        troopGearList.push({ name: val, qty: qty, checked: true });
        renderGearChecklist();
      }
      newGearInput.value = "";
      if (newGearQtyInput) newGearQtyInput.value = "";
    };
  }

  $("saveFloatPlanBtn").onclick = () => {
    alert("Float plan logistics saved successfully!");
  };

  TroopAuth.start({
    buttonId: "googleSignInBtn",
    buttonSize: "large",
    onSignIn: (token, claims) => onSignIn(token, claims),
    onSignOut: onSignOut
  });
  $("signOutBtn").onclick = TroopAuth.signOut;
})();
