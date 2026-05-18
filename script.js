/* =============================================================
 * Melissa Personator Search — Lead Update Widget
 * -------------------------------------------------------------
 * Flow:
 *   1. Zoho SDK PageLoad -> get current Lead ID
 *   2. Fetch current Lead from Zoho CRM (input only)
 *   3. Build Melissa Personator Search request from Lead fields
 *   4. Call Melissa Personator Search API (broad consumer search)
 *      with a fallback ladder if strict matches return zero records
 *   5. Render every matching Melissa record in the results table
 *   6. User selects a row -> preview shows
 *   7. Update button writes selected Melissa values to current Lead
 *   8. Success modal -> close popup
 *
 * IMPORTANT: Current Lead data is used ONLY to build the API
 * request and to perform the final Zoho update. It is NEVER
 * used to fill rows in the results table — rows come from
 * response.Records only.
 * ============================================================= */

/* ===============================
 * CONFIGURATION — EDIT BEFORE GO-LIVE
 * =============================== */

const PERSONATOR_ENDPOINT =
  "https://personatorsearch.melissadata.net/WEB/doPersonatorSearch";

/**
 * Backend proxy URL (preferred for production). Leave empty string to
 * call Melissa directly from the browser.
 * SECURITY: Do NOT expose the API key in frontend production code.
 */
const PERSONATOR_PROXY_URL = ""; // <-- SET THIS for production

/**
 * TEMPORARY/TESTING ONLY — placeholder license key.
 * Replace with your real Melissa Personator Search license key.
 * Do not commit a real key to a public repository.
 */
const PERSONATOR_LICENSE_KEY = "NNyQiGBQttkIhzONLxAqXx**";

/**
 * Address update mode for Zoho CRM Leads:
 *   "separate" -> Home_Address_Street, Home_Address_State, ...
 *                 Use this if your Lead layout shows the address as
 *                 four independent fields.
 *   "compound" -> single Home_Address object with sub-fields.
 *                 Use this if your Lead layout uses Zoho's compound
 *                 address field (one block, multiple sub-fields).
 */
// Default to "compound" because Zoho Lead layouts that group the four
// Home Address fields under one block use the compound Home_Address object.
// Switch to "separate" if your layout exposes them as four independent fields.
const ADDRESS_UPDATE_MODE = "compound"; // "compound" | "separate"

/* ===============================
 * STATE
 * =============================== */

let sdkReady = false;
let currentLeadId = null;
let currentLeadRecord = null;
let melissaRecords = [];
let filteredRecords = [];
let selectedMelissaRecord = null;
let selectedIndex = -1;

/* ===============================
 * DOM REFERENCES
 * =============================== */

const els = {
  banner: document.getElementById("banner"),
  leadContext: document.getElementById("leadContext"),
  loading: document.getElementById("loadingState"),
  empty: document.getElementById("emptyState"),
  resultsWrap: document.getElementById("resultsWrapper"),
  resultsBody: document.getElementById("resultsBody"),
  previewSec: document.getElementById("previewSection"),
  previewGrid: document.getElementById("previewGrid"),
  updateBtn: document.getElementById("updateBtn"),
  cancelBtn: document.getElementById("cancelBtn"),
  filterInput: document.getElementById("filterInput"),
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

function setEmptyMessage(msg) {
  const p = els.empty.querySelector("p");
  if (p) p.textContent = msg;
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
    !sdkReady || !currentLeadId || !selectedMelissaRecord;
}

/* ===============================
 * ZOHO SDK INIT
 * =============================== */

ZOHO.embeddedApp.on("PageLoad", async function (data) {
  console.log("PageLoad data:", data);
  sdkReady = true;

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
    // 1) Fetch current Lead — used ONLY as Melissa Search input + final update target
    currentLeadRecord = await fetchCurrentLead(currentLeadId);
    console.log("Current Lead Data:", currentLeadRecord);

    // 2) Build initial Melissa Search params from Lead values
    const baseParams = buildMelissaSearchParams(currentLeadRecord);
    console.log("Melissa Search request params:", baseParams);

    /*
     * 3) Fallback ladder.
     * Personator Search is strict by default. If the full-input search
     * returns zero records, progressively drop fields to broaden the match.
     * As soon as any attempt returns records, stop.
     */
    const attempts = [
      { label: "first + last + state + city + postal", params: baseParams },
      { label: "first + last + state",                 params: { first: baseParams.first, last: baseParams.last, state: baseParams.state } },
      { label: "first + last",                         params: { first: baseParams.first, last: baseParams.last } },
      { label: "last + state",                         params: { last:  baseParams.last,  state: baseParams.state } },
      { label: "state only",                           params: { state: baseParams.state } },
    ];

    let rawResponse = null;
    let rawRecords  = [];
    let totalRecords = 0;
    let licenseIssueDetected = false;

    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];

      // Skip attempts whose only fields are all empty
      const anyValue = Object.values(attempt.params).some(Boolean);
      if (!anyValue) {
        console.log(`Skipping attempt #${i + 1} (${attempt.label}) — no values to search.`);
        continue;
      }

      console.log(`Melissa Search attempt #${i + 1}: ${attempt.label}`, attempt.params);

      rawResponse = await callMelissaSearchAPI(attempt.params);
      console.log("Melissa Search raw response:", rawResponse);
      console.log("TotalRecords:", rawResponse?.TotalRecords);
      console.log("TransmissionResults:", rawResponse?.TransmissionResults);
      console.log("Records:", rawResponse?.Records);

      if (hasLicenseError(rawResponse)) {
        licenseIssueDetected = true;
        break;
      }

      totalRecords = parseInt(rawResponse?.TotalRecords || "0", 10);
      rawRecords = Array.isArray(rawResponse?.Records) ? rawResponse.Records : [];

      if (totalRecords > 0 && rawRecords.length > 0) {
        console.log(`Melissa returned ${rawRecords.length} records on attempt #${i + 1} (${attempt.label}).`);
        break;
      }

      console.log(`Attempt #${i + 1} (${attempt.label}) returned 0 records — trying broader fallback.`);
    }

    setLoading(false);

    // License / access failure — distinct message
    if (licenseIssueDetected) {
      const tr = String(rawResponse?.TransmissionResults || "");
      console.error("Melissa license/access error. TransmissionResults:", tr, rawResponse);
      setEmptyMessage("Melissa license key or Personator Search access issue.");
      showEmpty(true);
      showResults(false);
      return;
    }

    // All fallback attempts exhausted with no records
    if (rawRecords.length === 0) {
      setEmptyMessage("No Melissa Search records found after broad search.");
      showEmpty(true);
      showResults(false);
      return;
    }

    // 4) Map ONLY from Melissa response.Records (never from lead)
    const mapped = mapMelissaRecords(rawRecords);
    console.log("Mapped Melissa records:", mapped);


    // 5) Filter to rows that actually have at least one usable value
    const usableRecords = mapped.filter(
      (r) =>
        r.homeAddressStreet ||
        r.homeAddressState ||
        r.homeAddressCity ||
        r.homeAddressZip ||
        r.phone ||
        r.email
    );
    console.log("Usable Melissa records:", usableRecords);

    if (usableRecords.length === 0) {
      setEmptyMessage("No Melissa Search records found after broad search.");
      showEmpty(true);
      showResults(false);
      return;
    }

    // 6) Render
    melissaRecords = usableRecords;
    filteredRecords = [...usableRecords];

    renderResults(filteredRecords);
    showResults(true);
    els.filterInput.disabled = false;
  } catch (err) {
    console.error("Widget load error:", err);
    setLoading(false);
    showBanner(
      `Failed to load Melissa Search results: ${err.message || err}`,
      "error"
    );
  }
});

/**
 * Detect Melissa license/access errors via TransmissionResults codes.
 * Common codes:
 *   GE05 — License key invalid
 *   GE06 — License key disabled
 *   GE07 — License key out of credits
 *   GE08 — License key expired / not subscribed to this product
 *   SE01 — Service error
 * (GE01/GE02/GE03 are NOT license issues — they indicate input/match problems.)
 */
function hasLicenseError(response) {
  if (!response) return false;
  const tr = String(response.TransmissionResults || "");
  return /\bGE0[5-8]\b/.test(tr) || /\bSE01\b/.test(tr);
}

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
 * MELISSA SEARCH — INPUT PARAMS
 * -------------------------------
 * Current Lead values are used ONLY to seed the search.
 * =============================== */

function buildMelissaSearchParams(lead) {
  const ha = lead.Home_Address || {};

  return {
    first: lead.First_Name || "",
    last: lead.Last_Name || "",
    city: lead.Home_Address_City || ha.City || lead.City || "",
    state: lead.Home_Address_State || ha.State || lead.State || "",
    postal: lead.Home_Address_Zip || ha.Zip || lead.Zip_Code || "",
  };
}

/* ===============================
 * MELISSA SEARCH — API CALL
 * =============================== */

async function callMelissaSearchAPI(params) {
  // Backend proxy path (preferred for production — keeps key off the wire)
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

  console.warn(
    "Calling Melissa Personator Search directly from frontend. " +
    "Do not expose your license key in production."
  );

  // ReturnAllPages:True  -> Melissa may return multiple matching records
  // SearchConditions:loose -> broaden the consumer database match
  const url =
    PERSONATOR_ENDPOINT +
    "?id=" + encodeURIComponent(PERSONATOR_LICENSE_KEY) +
    "&cols=GrpAll" +
    "&format=JSON" +
    "&first=" + encodeURIComponent(params.first || "") +
    "&last=" + encodeURIComponent(params.last || "") +
    "&city=" + encodeURIComponent(params.city || "") +
    "&state=" + encodeURIComponent(params.state || "") +
    "&postal=" + encodeURIComponent(params.postal || "") +
    "&opt=ReturnAllPages:True,SearchConditions:loose";

  // Confirm the key actually made it into the request, but mask it in console
  const keyPresent = Boolean(PERSONATOR_LICENSE_KEY) &&
                     PERSONATOR_LICENSE_KEY !== "REPLACE_WITH_YOUR_REAL_LICENSE_KEY";
  console.log("Melissa Search API URL (key masked):", maskKeyInUrl(url));
  console.log("License key present in request:", keyPresent);

  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`Melissa Search API error ${resp.status} ${resp.statusText}`);
  }
  return await resp.json();
}

/**
 * Replace the `id=` query parameter value with a masked placeholder
 * so the license key never appears in the browser console.
 */
function maskKeyInUrl(url) {
  return String(url).replace(/([?&]id=)[^&]+/i, "$1***MASKED***");
}

/* =====================================================================
 * MELISSA SEARCH — RESPONSE MAPPING
 * ---------------------------------------------------------------------
 * Reads ONLY from response.Records. Never references currentLeadRecord
 * or any Zoho lead field.
 *
 * Strict isolation rules:
 *   - Street cell holds ONLY street/address values
 *   - State  cell holds ONLY state values
 *   - City   cell holds ONLY city values
 *   - Zip    cell holds ONLY postal/zip values
 *   - Zip is never copied into Street/State/City
 * ===================================================================== */

// Guarantee a string for table/preview rendering. Prevents "[object Object]"
// if a deeply nested field unexpectedly resolves to an object or array.
function toDisplayString(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

// Pull a string from a PhoneRecords[0] / EmailRecords[0] entry, which may be
// either a plain string or an object whose value lives under one of several keys.
function extractContact(entry, keys) {
  if (!entry) return "";
  if (typeof entry === "string") return entry.trim();
  if (typeof entry === "object") {
    for (let i = 0; i < keys.length; i++) {
      const v = entry[keys[i]];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
  }
  return "";
}

function pickValue(obj, paths) {
  for (let i = 0; i < paths.length; i++) {
    const parts = paths[i].split(".");
    let v = obj;
    for (let j = 0; j < parts.length; j++) {
      if (v === null || v === undefined) { v = undefined; break; }
      v = v[parts[j]];
    }
    if (v !== null && v !== undefined && v !== "") {
      const out = typeof v === "string" ? v.trim() : v;
      if (out !== "") return out;
    }
  }
  return "";
}

function buildStreetFromParts(record) {
  return [
    record.AddressHouseNumber || record.ParsedAddressRange || record.AddressRange,
    record.AddressPreDirection || record.ParsedAddressPreDirection,
    record.AddressStreetName || record.ParsedStreetName,
    record.AddressStreetSuffix || record.ParsedStreetSuffix || record.AddressSuffix,
    record.AddressPostDirection || record.ParsedAddressPostDirection,
    record.AddressSuiteName,
    record.AddressSuiteNumber,
  ]
    .map((s) => (s == null ? "" : String(s).trim()))
    .filter(Boolean)
    .join(" ")
    .trim();
}

function mapMelissaRecords(records) {
  if (!Array.isArray(records) || records.length === 0) return [];

  console.log("FIRST RAW MELISSA RECORD:", JSON.stringify(records[0], null, 2));

  const rows = [];

  records.forEach((record) => {
    // Phone/email live at the PARENT record level — extract once and attach
    // to every address row produced from this record.
    console.log("Parent PhoneRecords:", record.PhoneRecords);
    console.log("Parent EmailRecords:", record.EmailRecords);

    const phone =
      record.PhoneRecords?.[0]?.PhoneNumber ||
      record.PhoneRecords?.[0]?.phoneNumber ||
      record.PhoneRecords?.[0]?.Phone ||
      record.PhoneNumber ||
      record.Phone ||
      "";

    const email =
      record.EmailRecords?.[0]?.Email ||
      record.EmailRecords?.[0]?.email ||
      record.EmailRecords?.[0]?.EmailAddress ||
      record.EmailAddress ||
      record.Email ||
      "";

    console.log("Extracted phone:", phone);
    console.log("Extracted email:", email);

    const buildRow = (addr) => ({
      homeAddressStreet: toDisplayString(
        addr?.AddressLine1 || addr?.AddressLine || addr?.Address || addr?.Street || ""
      ),
      homeAddressState: toDisplayString(
        addr?.State || addr?.AdministrativeArea || addr?.StateProvince || ""
      ),
      homeAddressCity: toDisplayString(addr?.City || addr?.Locality || ""),
      homeAddressZip: toDisplayString(
        addr?.PostalCode || addr?.Zip || addr?.ZipCode || ""
      ),
      phone: toDisplayString(phone),
      email: toDisplayString(email),
    });

    if (record.CurrentAddress) {
      rows.push(buildRow(record.CurrentAddress));
    }

    (record.PreviousAddresses || []).forEach((addr) => {
      rows.push(buildRow(addr));
    });

    // Fallback: if the record has neither CurrentAddress nor PreviousAddresses,
    // still emit one row using legacy flat keys so phone/email aren't lost.
    if (!record.CurrentAddress && !(record.PreviousAddresses || []).length) {
      const street =
        pickValue(record, [
          "AddressLine1", "Address1", "StreetAddress", "Street",
          "DeliveryAddress", "AddressDeliveryLine", "DeliveryLine", "AddressLine",
          "Address.AddressLine1", "Address.AddressLine",
          "AddressDetails.AddressLine1", "GrpAddressDetails.AddressLine1",
          "MailingAddress.AddressLine1",
        ]) ||
        buildStreetFromParts(record) ||
        "";

      const city = pickValue(record, [
        "City", "Locality", "AddressCity", "MailingCity",
        "Address.City", "AddressDetails.City",
        "GrpAddressDetails.City", "MailingAddress.City",
      ]);

      const state = pickValue(record, [
        "State", "AdministrativeArea", "AddressState", "MailingState", "StateProvince",
        "Address.State", "AddressDetails.State",
        "GrpAddressDetails.State", "MailingAddress.State",
      ]);

      const zip = pickValue(record, [
        "PostalCode", "Zip", "ZipCode",
        "AddressPostalCode", "MailingPostalCode", "PostalCodePlus4",
        "Address.PostalCode", "AddressDetails.PostalCode",
        "GrpAddressDetails.PostalCode", "MailingAddress.PostalCode",
      ]);

      rows.push({
        homeAddressStreet: toDisplayString(street),
        homeAddressState: toDisplayString(state),
        homeAddressCity: toDisplayString(city),
        homeAddressZip: toDisplayString(zip),
        phone: toDisplayString(phone),
        email: toDisplayString(email),
      });
    }
  });

  console.log("Flattened Melissa rows:", rows);
  return rows;
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
      <td>${escapeHtml(rec.homeAddressState) || "—"}</td>
      <td>${escapeHtml(rec.homeAddressCity) || "—"}</td>
      <td>${escapeHtml(rec.homeAddressZip) || "—"}</td>
      <td>${escapeHtml(rec.phone) || "—"}</td>
      <td>${escapeHtml(rec.email) || "—"}</td>
      <td class="action-cell">
        <button class="btn btn-select" data-action="select" data-index="${index}">
          Select
        </button>
      </td>
    `;

    tr.addEventListener("click", () => selectRecord(index));
    els.resultsBody.appendChild(tr);
  });

  if (selectedIndex >= 0) markSelectedRow(selectedIndex);
}

/* ===============================
 * SELECT RECORD
 * =============================== */

function selectRecord(index) {
  const record = filteredRecords[index];
  if (!record) return;

  selectedIndex = index;
  selectedMelissaRecord = record;
  console.log("Selected Melissa record:", selectedMelissaRecord);

  markSelectedRow(index);
  renderPreview(record);
  showPreview(true);
  refreshUpdateButton();
}

function markSelectedRow(index) {
  const rows = els.resultsBody.querySelectorAll("tr");
  rows.forEach((row) => {
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
    ["Home Address State", rec.homeAddressState],
    ["Home Address City", rec.homeAddressCity],
    ["Home Address Zip", rec.homeAddressZip],
    ["Phone", rec.phone],
    ["Email", rec.email],
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
    filteredRecords = [...melissaRecords];
  } else {
    filteredRecords = melissaRecords.filter((r) =>
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

  selectedIndex = -1;
  selectedMelissaRecord = null;
  showPreview(false);
  refreshUpdateButton();

  renderResults(filteredRecords);
});

/* ===============================
 * UPDATE LEAD IN ZOHO CRM
 * =============================== */

els.updateBtn.addEventListener("click", async () => {
  if (!sdkReady || !currentLeadId || !selectedMelissaRecord) return;

  hideBanner();
  els.updateBtn.disabled = true;
  els.updateBtn.textContent = "Updating…";

  try {
    console.log("SELECTED MELISSA RECORD:", selectedMelissaRecord);

    const updatePayload = buildUpdatePayload(currentLeadId, selectedMelissaRecord);
    console.log("ZOHO UPDATE PAYLOAD:", updatePayload);

    const updateResponse = await ZOHO.CRM.API.updateRecord({
      Entity: "Leads",
      APIData: updatePayload,
    });

    console.log("ZOHO UPDATE RESPONSE:", updateResponse);

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

    // Verify the write actually landed by reading the Lead back.
    let updatedLead = null;
    try {
      updatedLead = await fetchCurrentLead(currentLeadId);
      console.log("UPDATED LEAD AFTER SAVE:", updatedLead);
    } catch (verifyErr) {
      console.warn("Could not re-fetch Lead for verification:", verifyErr);
    }

    if (updatedLead && !addressFieldsPersisted(updatedLead, selectedMelissaRecord)) {
      console.warn(
        "Zoho returned SUCCESS but Home Address fields on the Lead do not " +
        "match the sent values. The API field names for the address block " +
        "may not match. Inspect the UPDATED LEAD AFTER SAVE log above and " +
        "compare keys against the payload."
      );
      showBanner(
        "Zoho accepted the update, but Home Address field mapping may be incorrect. Please verify exact API names.",
        "error"
      );
      els.updateBtn.disabled = false;
      els.updateBtn.textContent = "Update Lead";
      return;
    }

    showSuccessModal();
  } catch (err) {
    console.error("Update failed:", err);
    showBanner(`Update failed: ${err.message || err}`, "error");
    els.updateBtn.disabled = false;
    els.updateBtn.textContent = "Update Lead";
  }
});

// Compare the values we sent against what the Lead actually contains after
// the update. We accept either the compound (Home_Address.Street) or the
// flat (Home_Address_Street) representation because Zoho can return either
// depending on the layout. Empty sends are skipped — we only assert that
// non-empty values made it through.
function addressFieldsPersisted(lead, rec) {
  const checks = [
    [rec.homeAddressStreet, lead.Home_Address_Street, lead.Home_Address?.Street],
    [rec.homeAddressCity,   lead.Home_Address_City,   lead.Home_Address?.City],
    [rec.homeAddressState,  lead.Home_Address_State,  lead.Home_Address?.State],
    [rec.homeAddressZip,    lead.Home_Address_Zip,    lead.Home_Address?.Zip],
  ];

  for (let i = 0; i < checks.length; i++) {
    const [sent, flat, compound] = checks[i];
    if (!sent) continue;
    const got = (flat || compound || "").toString().trim();
    if (got !== sent.toString().trim()) return false;
  }
  return true;
}

/* -------------------------------------------------------------
 * BUILD UPDATE PAYLOAD
 * -------------------------------------------------------------
 * Two supported Zoho address layouts:
 *
 *   ADDRESS_UPDATE_MODE = "separate"
 *     The Lead has four independent fields (Home_Address_Street,
 *     Home_Address_State, Home_Address_City, Home_Address_Zip).
 *     Use this when those fields appear separately in the Lead layout.
 *
 *   ADDRESS_UPDATE_MODE = "compound"
 *     The Lead uses Zoho's compound address field. The whole address
 *     is written as a single Home_Address object with sub-fields.
 *     Use this when the Lead layout shows the address as a single
 *     compound block (Street/City/State/Zip inside one field group).
 *
 * Zip is NEVER copied into Street/State/City in either mode.
 * ------------------------------------------------------------- */
function buildUpdatePayload(leadId, rec) {
  if (ADDRESS_UPDATE_MODE === "compound") {
    return {
      id: leadId,
      Home_Address: {
        Street: rec.homeAddressStreet || "",
        State: rec.homeAddressState || "",
        City: rec.homeAddressCity || "",
        Zip: rec.homeAddressZip || "",
      },
      Phone: rec.phone || "",
      Email: rec.email || "",
    };
  }

  return {
    id: leadId,
    Home_Address_Street: rec.homeAddressStreet || "",
    Home_Address_State: rec.homeAddressState || "",
    Home_Address_City: rec.homeAddressCity || "",
    Home_Address_Zip: rec.homeAddressZip || "",
    Phone: rec.phone || "",
    Email: rec.email || "",
  };
}

/* ===============================
 * SUCCESS MODAL + CLOSE
 * =============================== */

function showSuccessModal() {
  // Set the success text if the modal exposes a message element.
  const msg = els.successModal.querySelector(".success-message, p, .modal-message");
  if (msg) msg.textContent = "Record update successfully";
  els.successModal.classList.remove("hidden");
}

els.successClose.addEventListener("click", closeWidget);
els.cancelBtn.addEventListener("click", closeWidget);

function closeWidget() {
  try {
    ZOHO.CRM.UI.Popup.closeReload()
      .then(() => console.log("Widget closed and CRM reloaded"))
      .catch(() => {
        if (ZOHO.CRM.UI.Popup.close) ZOHO.CRM.UI.Popup.close();
      });
  } catch (e) {
    console.warn("Popup close failed:", e);
  }
}
