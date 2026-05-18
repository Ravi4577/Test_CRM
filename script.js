/* =============================================================
 * Personator Consumer — Lead Update Widget
 * -------------------------------------------------------------
 * Flow:
 *   1. Zoho SDK PageLoad -> get current Lead ID
 *   2. Fetch current Lead from Zoho CRM
 *   3. Call Personator Consumer API using Lead values
 *   4. Render multiple results in horizontal table
 *   5. User selects a row -> preview shows
 *   6. Update button updates current Lead with selected data
 *   7. Success modal -> close popup
 * ============================================================= */

/* ===============================
 * CONFIGURATION — EDIT BEFORE GO-LIVE
 * =============================== */

/**
 * Personator Consumer API endpoint.
 * Default is Melissa Data's Contact Search (returns multiple records).
 *
 * If you are running through a backend proxy (RECOMMENDED for production)
 * set PERSONATOR_PROXY_URL below and the code will call your proxy instead.
 */
const PERSONATOR_ENDPOINT =
  "https://personator.melissadata.net/v3/WEB/ContactVerify/doContactVerify?";

/**
 * Backend proxy URL (preferred). Leave empty string to call Personator directly.
 * SECURITY: Do NOT expose the API key in frontend production code.
 * Use a backend/proxy endpoint that injects the key server-side.
 *
 * Example proxy URL:
 *   const PERSONATOR_PROXY_URL = "https://yourdomain.com/api/personator-consumer";
 */
const PERSONATOR_PROXY_URL = "https://personator.melissadata.net/v3/WEB/ContactVerify/doContactVerify?"; // <-- SET THIS for production

/**
 * TEMPORARY/TESTING ONLY — direct license key.
 * Do not expose API key in frontend production. Use backend proxy.
 */
const PERSONATOR_LICENSE_KEY = "NNyQiGBQttkIhzONLxAqXx**";

/**
 * Columns to request from Personator. Adjust if your subscription differs.
 */
const PERSONATOR_COLUMNS = "GrpAddress,GrpName,GrpPhone,GrpEmail,GrpCensus,GrpAddressDetails";

/**
 * Address update mode for Zoho CRM Leads:
 *   "separate"  -> uses individual API names like Home_Address_Street, Home_Address_State, ...
 *   "compound"  -> uses a single Home_Address object with Street/State/City/Zip
 *
 * Change this if your CRM uses a compound address field.
 */
const ADDRESS_UPDATE_MODE = "separate"; // "separate" | "compound"

/* ===============================
 * STATE
 * =============================== */

let sdkReady = false;
let currentLeadId = null;
let currentLeadRecord = null;
let personatorRecords = [];      // mapped records shown in the UI
let filteredRecords = [];        // after applying filter
let selectedPersonatorRecord = null;
let selectedIndex = -1;

/* ===============================
 * DOM REFERENCES
 * =============================== */

const els = {
  banner:       document.getElementById("banner"),
  leadContext:  document.getElementById("leadContext"),
  loading:      document.getElementById("loadingState"),
  empty:        document.getElementById("emptyState"),
  resultsWrap:  document.getElementById("resultsWrapper"),
  resultsBody:  document.getElementById("resultsBody"),
  previewSec:   document.getElementById("previewSection"),
  previewGrid:  document.getElementById("previewGrid"),
  updateBtn:    document.getElementById("updateBtn"),
  cancelBtn:    document.getElementById("cancelBtn"),
  filterInput:  document.getElementById("filterInput"),
  successModal: document.getElementById("successModal"),
  successClose: document.getElementById("successCloseBtn"),
};

/* ===============================
 * UI HELPERS
 * =============================== */

function showBanner(message, type = "info") {
  els.banner.textContent = message;
  els.banner.className = `banner banner-${type}`;
}

function hideBanner() {
  els.banner.className = "banner banner-hidden";
  els.banner.textContent = "";
}

function setLoading(isLoading) {
  els.loading.classList.toggle("hidden", !isLoading);
}

function showEmpty(show) {
  els.empty.classList.toggle("hidden", !show);
}

function showResults(show) {
  els.resultsWrap.classList.toggle("hidden", !show);
}

function showPreview(show) {
  els.previewSec.classList.toggle("hidden", !show);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function refreshUpdateButton() {
  els.updateBtn.disabled =
    !sdkReady || !currentLeadId || !selectedPersonatorRecord;
}

/* ===============================
 * ZOHO SDK INIT
 * =============================== */

ZOHO.embeddedApp.on("PageLoad", async function (data) {
  console.log("PageLoad data:", data);
  sdkReady = true;

  // Resolve current Lead ID from possible PageLoad data shapes
  if (data) {
    if (data.EntityId) {
      currentLeadId = Array.isArray(data.EntityId) ? data.EntityId[0] : data.EntityId;
    } else if (data.Entity) {
      currentLeadId = Array.isArray(data.Entity) ? data.Entity[0] : data.Entity;
    }
  }

  console.log("Current Lead ID:", currentLeadId);

  if (!currentLeadId) {
    setLoading(false);
    showBanner(
      "Current Lead ID not found. Please open this widget from a Lead record.",
      "error"
    );
    els.leadContext.textContent = "No Lead context";
    return;
  }

  els.leadContext.textContent = `Current Lead ID: ${currentLeadId}`;

  try {
    // 1) Fetch current Lead
    currentLeadRecord = await fetchCurrentLead(currentLeadId);
    console.log("Current Lead Data:", currentLeadRecord);

    // 2) Call Personator Consumer API using Lead data
    const params = buildPersonatorParams(currentLeadRecord);
    console.log("Personator API request params:", params);

    const rawResponse = await callPersonatorAPI(params);
    console.log("Personator API raw response:", rawResponse);

    // 3) Map records
    const mapped = mapPersonatorRecords(rawResponse);
    console.log("Mapped Personator records:", mapped);

    personatorRecords = mapped;
    filteredRecords = [...mapped];

    setLoading(false);

    if (!mapped.length) {
      showEmpty(true);
      showResults(false);
      return;
    }

    renderResults(filteredRecords);
    showResults(true);
    els.filterInput.disabled = false;
  } catch (err) {
    console.error("Widget load error:", err);
    setLoading(false);
    showBanner(
      `Failed to load Personator results: ${err.message || err}`,
      "error"
    );
  }
});

ZOHO.embeddedApp.init();

/* ===============================
 * FETCH CURRENT LEAD
 * =============================== */

async function fetchCurrentLead(leadId) {
  try {
    const resp = await ZOHO.CRM.API.getRecord({
      Entity: "Leads",
      RecordID: leadId,
    });
    if (resp && resp.data && resp.data.length > 0) {
      return resp.data[0];
    }
    throw new Error("Lead not found in CRM.");
  } catch (err) {
    throw new Error(`Lead fetch failed: ${err.message || err}`);
  }
}

/* ===============================
 * PERSONATOR — INPUT PARAMS
 * =============================== */

function buildPersonatorParams(lead) {
  // Pull whatever is available on the Lead. Skip empty values.
  const fullName =
    lead.Full_Name ||
    [lead.First_Name, lead.Last_Name].filter(Boolean).join(" ").trim();

  // If the Lead has compound Home_Address, prefer that; otherwise use flat fields.
  const ha = lead.Home_Address || {};
  const homeStreet = lead.Home_Address_Street || ha.Street || lead.Street || "";
  const homeCity   = lead.Home_Address_City   || ha.City   || lead.City   || "";
  const homeState  = lead.Home_Address_State  || ha.State  || lead.State  || "";
  const homeZip    = lead.Home_Address_Zip    || ha.Zip    || lead.Zip_Code || "";

  const params = {
    full:   fullName,
    first:  lead.First_Name || "",
    last:   lead.Last_Name  || "",
    a1:     homeStreet,
    city:   homeCity,
    state:  homeState,
    postal: homeZip,
    phone:  lead.Phone  || lead.Mobile || "",
    email:  lead.Email  || "",
    ctry:   "US", // Personator Consumer is primarily US-centric; change if needed
  };

  // Strip empties so the API doesn't get confused
  Object.keys(params).forEach((k) => {
    if (!params[k]) delete params[k];
  });

  return params;
}

/* ===============================
 * PERSONATOR — API CALL
 * =============================== */

async function callPersonatorAPI(params) {
  // Prefer backend proxy if configured
  if (PERSONATOR_PROXY_URL) {
    const resp = await fetch(PERSONATOR_PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!resp.ok) {
      throw new Error(`Proxy returned ${resp.status} ${resp.statusText}`);
    }
    return await resp.json();
  }

  // Fallback: direct call (testing only)
  console.warn(
    "Calling Personator directly from frontend. Do not expose API key in production."
  );

  const query = new URLSearchParams({
    id:     PERSONATOR_LICENSE_KEY,
    format: "json",
    cols:   PERSONATOR_COLUMNS,
    ...params,
  });

  const url = `${PERSONATOR_ENDPOINT}?${query.toString()}`;

  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`Personator API error ${resp.status} ${resp.statusText}`);
  }
  return await resp.json();
}

/* ===============================
 * PERSONATOR — RESPONSE MAPPING
 * -------------------------------
 * The exact field names depend on the Personator Consumer columns enabled in
 * your account. Adjust the fallbacks below to match your actual response.
 * =============================== */

function mapPersonatorRecords(response) {
  if (!response) return [];

  // Most Melissa endpoints return { Records: [...] }; some return { records: [...] }
  const records =
    response.Records ||
    response.records ||
    response.Data ||
    response.results ||
    [];

  if (!Array.isArray(records)) return [];

  return records.map((record) => {
    /*
     * Adjust mapping here according to actual Personator Consumer API response.
     * Each row must isolate its own value — never copy Zip into Street/State/City.
     */
    const personatorMappedRecord = {
      homeAddressStreet:
        record.AddressLine1 ||
        record.Address ||
        record.Home_Address_Street ||
        record.Street ||
        "",
      homeAddressState:
        record.State ||
        record.AdministrativeArea ||
        record.Home_Address_State ||
        record.StateProvince ||
        "",
      homeAddressCity:
        record.City ||
        record.Locality ||
        record.Home_Address_City ||
        "",
      homeAddressZip:
        record.PostalCode ||
        record.Zip ||
        record.Home_Address_Zip ||
        record.PostalCodePrimary ||
        "",
      phone:
        record.PhoneNumber ||
        record.Phone ||
        record.HomePhone ||
        "",
      email:
        record.EmailAddress ||
        record.Email ||
        "",
    };

    return personatorMappedRecord;
  });
}

/* ===============================
 * RENDER RESULTS TABLE
 * =============================== */

function renderResults(records) {
  els.resultsBody.innerHTML = "";

  if (!records.length) {
    showEmpty(true);
    showResults(false);
    return;
  }

  showEmpty(false);
  showResults(true);

  records.forEach((rec, index) => {
    const tr = document.createElement("tr");
    tr.dataset.index = index;

    tr.innerHTML = `
      <td>${escapeHtml(rec.homeAddressStreet) || "—"}</td>
      <td>${escapeHtml(rec.homeAddressState)  || "—"}</td>
      <td>${escapeHtml(rec.homeAddressCity)   || "—"}</td>
      <td>${escapeHtml(rec.homeAddressZip)    || "—"}</td>
      <td>${escapeHtml(rec.phone)             || "—"}</td>
      <td>${escapeHtml(rec.email)             || "—"}</td>
      <td class="action-cell">
        <button class="btn btn-select" data-action="select" data-index="${index}">
          Select
        </button>
      </td>
    `;

    tr.addEventListener("click", () => selectRecord(index));
    els.resultsBody.appendChild(tr);
  });

  // Re-apply selected state if any
  if (selectedIndex >= 0) markSelectedRow(selectedIndex);
}

/* ===============================
 * SELECT RECORD
 * =============================== */

function selectRecord(index) {
  const record = filteredRecords[index];
  if (!record) return;

  selectedIndex = index;
  selectedPersonatorRecord = record;
  console.log("Selected Personator record:", selectedPersonatorRecord);

  markSelectedRow(index);
  renderPreview(record);
  showPreview(true);
  refreshUpdateButton();
}

function markSelectedRow(index) {
  const rows = els.resultsBody.querySelectorAll("tr");
  rows.forEach((row, i) => {
    const isSel = parseInt(row.dataset.index, 10) === index;
    row.classList.toggle("selected", isSel);
    const btn = row.querySelector(".btn-select");
    if (btn) {
      btn.classList.toggle("is-selected", isSel);
      btn.textContent = isSel ? "Selected" : "Select";
    }
  });
}

function renderPreview(rec) {
  const fields = [
    ["Home Address Street", rec.homeAddressStreet],
    ["Home Address State",  rec.homeAddressState],
    ["Home Address City",   rec.homeAddressCity],
    ["Home Address Zip",    rec.homeAddressZip],
    ["Phone",               rec.phone],
    ["Email",               rec.email],
  ];

  els.previewGrid.innerHTML = fields
    .map(([label, value]) => `
      <div class="preview-item">
        <span class="preview-label">${escapeHtml(label)}</span>
        <span class="preview-value ${value ? "" : "empty"}">
          ${value ? escapeHtml(value) : "—"}
        </span>
      </div>
    `)
    .join("");
}

/* ===============================
 * FILTER
 * =============================== */

els.filterInput.addEventListener("input", (e) => {
  const q = (e.target.value || "").trim().toLowerCase();

  if (!q) {
    filteredRecords = [...personatorRecords];
  } else {
    filteredRecords = personatorRecords.filter((r) =>
      [
        r.homeAddressStreet,
        r.homeAddressState,
        r.homeAddressCity,
        r.homeAddressZip,
        r.phone,
        r.email,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }

  // Reset selection when filtering changes the set
  selectedIndex = -1;
  selectedPersonatorRecord = null;
  showPreview(false);
  refreshUpdateButton();

  renderResults(filteredRecords);
});

/* ===============================
 * UPDATE LEAD IN ZOHO CRM
 * =============================== */

els.updateBtn.addEventListener("click", async () => {
  if (!sdkReady || !currentLeadId || !selectedPersonatorRecord) return;

  hideBanner();
  els.updateBtn.disabled = true;
  els.updateBtn.textContent = "Updating…";

  try {
    const payload = buildUpdatePayload(currentLeadId, selectedPersonatorRecord);
    console.log("Zoho update payload:", payload);

    const updateResponse = await ZOHO.CRM.API.updateRecord({
      Entity: "Leads",
      APIData: payload,
      Trigger: ["workflow"],
    });

    console.log("Zoho update response:", updateResponse);

    const success =
      updateResponse &&
      updateResponse.data &&
      updateResponse.data[0] &&
      (updateResponse.data[0].code === "SUCCESS" ||
        updateResponse.data[0].status === "success");

    if (!success) {
      const reason =
        updateResponse?.data?.[0]?.message ||
        "Unknown error from Zoho CRM update.";
      throw new Error(reason);
    }

    // Success: show modal, hide working UI
    showSuccessModal();
  } catch (err) {
    console.error("Update failed:", err);
    showBanner(`Update failed: ${err.message || err}`, "error");
    els.updateBtn.disabled = false;
    els.updateBtn.textContent = "Update Lead";
  }
});

/* -------------------------------------------------------------
 * BUILD UPDATE PAYLOAD
 * -------------------------------------------------------------
 * If your Zoho Address field uses compound format, set
 * ADDRESS_UPDATE_MODE = "compound".
 * If it uses separate fields, leave it as "separate".
 * Each field maps strictly to its own value — Zip is NEVER
 * copied into Street/State/City.
 * ------------------------------------------------------------- */
function buildUpdatePayload(leadId, rec) {
  if (ADDRESS_UPDATE_MODE === "compound") {
    // Compound address format
    const updateDataCompound = {
      id: leadId,
      Home_Address: {
        Street: rec.homeAddressStreet || "",
        State:  rec.homeAddressState  || "",
        City:   rec.homeAddressCity   || "",
        Zip:    rec.homeAddressZip    || "",
      },
      Phone: rec.phone || "",
      Email: rec.email || "",
    };
    return updateDataCompound;
  }

  // Separate field API names (default)
  const updateData = {
    id: leadId,
    Home_Address_Street: rec.homeAddressStreet || "",
    Home_Address_State:  rec.homeAddressState  || "",
    Home_Address_City:   rec.homeAddressCity   || "",
    Home_Address_Zip:    rec.homeAddressZip    || "",
    Phone:               rec.phone             || "",
    Email:               rec.email             || "",
  };
  return updateData;
}

/* ===============================
 * SUCCESS MODAL + CLOSE
 * =============================== */

function showSuccessModal() {
  els.successModal.classList.remove("hidden");
}

els.successClose.addEventListener("click", closeWidget);
els.cancelBtn.addEventListener("click", closeWidget);

function closeWidget() {
  // Close the popup/card/modal where selection/update was happening.
  try {
    ZOHO.CRM.UI.Popup.closeReload()
      .then(() => console.log("Widget closed and CRM reloaded"))
      .catch(() => {
        // Fallback close if closeReload not available
        if (ZOHO.CRM.UI.Popup.close) ZOHO.CRM.UI.Popup.close();
      });
  } catch (e) {
    console.warn("Popup close failed:", e);
  }
}
