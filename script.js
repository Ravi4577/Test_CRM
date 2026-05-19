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
// Zip + Phone + Email already persist with these flat names, so the Lead
// layout uses individual fields (not the compound Home_Address object).
// Stay on "separate" and override Street/State/City API names below if Zoho
// turns out to use non-default labels for those three fields.
const ADDRESS_UPDATE_MODE = "separate"; // "separate" | "compound"

/**
 * Zoho CRM Lead field API names. Edit ONLY this block if a field doesn't
 * update — no other code change needed; the payload is built from this map.
 *
 * How to confirm the right names:
 *   1. Open the browser console after running an update.
 *   2. Inspect the "ZOHO FIELDS METADATA" log — every Lead field is printed
 *      with its `api_name` and human label. Find the Street/State/City rows.
 *   3. Paste those exact `api_name` strings here.
 */
const FIELD_API_NAMES = {
  street: "LOCATION_ADDRESS",
  state:  "LOCATION_ADDRESS_STATE",
  city:   "LOCATION_ADDRESS_CITY",
  zip:    "Home_Address_Zip",
  phone:  "Phone",
  email:  "Email",
};

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

// Module-level reference to the Update Lead <button>. Assigned in
// attachUpdateLeadHandler() once the DOM is ready, then shared by
// refreshUpdateButton() and updateLeadRecord().
let updateLeadBtn = null;

function refreshUpdateButton() {
  if (!updateLeadBtn) return;
  updateLeadBtn.disabled =
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
    // The strict UI filter requires First + Last + Zip to match every row, so
    // there is no point widening the API search beyond those three fields —
    // any extra rows would just be discarded by the filter.
    const attempts = [
      { label: "first + last + postal", params: baseParams },
      { label: "first + last",          params: { first: baseParams.first, last: baseParams.last } },
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
    const flattenedMelissaRows = mapMelissaRecords(rawRecords);
    console.log("Flattened Melissa rows before strict filter:", flattenedMelissaRows);

    // 5) Strict filter — only keep rows where First Name + Last Name + Zip
    //    all match the currently opened Lead.
    const leadFirstName = normalizeName(currentLeadRecord.First_Name);
    const leadLastName  = normalizeName(currentLeadRecord.Last_Name);
    const leadZip       = normalizeZip(currentLeadRecord.Home_Address_Zip);

    console.log("STRICT FILTER ACTIVE: first + last + zip");
    console.log("Lead First Name:", leadFirstName);
    console.log("Lead Last Name:", leadLastName);
    console.log("Lead Zip:", leadZip);

    const strictlyFilteredRecords = flattenedMelissaRows.filter((record) => {
      const recordFirstName = normalizeName(record.firstName);
      const recordLastName  = normalizeName(record.lastName);
      const recordZip       = normalizeZip(record.homeAddressZip);

      const firstNameMatch = recordFirstName === leadFirstName;
      const lastNameMatch  = recordLastName  === leadLastName;
      const zipMatch       = recordZip       === leadZip;

      console.log("Compare:", {
        leadFirstName,
        recordFirstName,
        firstNameMatch,
        leadLastName,
        recordLastName,
        lastNameMatch,
        leadZip,
        recordZip,
        zipMatch,
      });

      return (
        leadFirstName &&
        leadLastName &&
        leadZip &&
        firstNameMatch &&
        lastNameMatch &&
        zipMatch
      );
    });

    console.log("Filtered records with first + last + zip match:", strictlyFilteredRecords);

    if (strictlyFilteredRecords.length === 0) {
      setEmptyMessage(
        "No Melissa records found where First Name, Last Name, and Home Address Zip match this Lead."
      );
      showEmpty(true);
      showResults(false);
      return;
    }

    // 6) Render
    melissaRecords  = strictlyFilteredRecords;
    filteredRecords = [...strictlyFilteredRecords];

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
  return {
    first: lead.First_Name || "",
    last: lead.Last_Name || "",
    postal: lead.Home_Address_Zip || "",
  };
}

/* ===============================
 * NORMALIZATION HELPERS — used for strict First + Last + Zip matching.
 * =============================== */

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeZip(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 5);
}

/* ===============================
 * MELISSA SEARCH — API CALL
 * =============================== */

const MELISSA_FETCH_TIMEOUT_MS = 20000;

// Public entry point — wraps the actual fetch in a 20s AbortController timeout
// and retries once on failure (timeout, network error, non-2xx). The browser's
// own connection-timeout (ERR_CONNECTION_TIMED_OUT) can take ~90s, so the
// client-side AbortController gives the user a faster, more predictable
// failure mode.
async function callMelissaSearchAPI(params) {
  console.log("Using proxy:", Boolean(PERSONATOR_PROXY_URL));
  console.log("Melissa Search params:", params);

  const maxAttempts = 2; // initial + 1 retry
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchMelissaOnce(params);
    } catch (error) {
      lastError = error;
      console.error(
        `Melissa Search fetch failed (attempt ${attempt}/${maxAttempts}):`,
        error
      );
      if (attempt < maxAttempts) {
        console.log("Retrying Melissa Search...");
      }
    }
  }

  throw lastError;
}

async function fetchMelissaOnce(params) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    MELISSA_FETCH_TIMEOUT_MS
  );

  try {
    // Backend proxy path (preferred for production — keeps key off the wire).
    if (PERSONATOR_PROXY_URL) {
      const response = await fetch(PERSONATOR_PROXY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      console.log("Melissa Search response status:", response.status);

      if (!response.ok) {
        throw new Error(`Proxy returned ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      console.log("Melissa Search raw response:", data);
      return data;
    }

    // Direct browser-to-Melissa call (testing only — exposes the license key).
    console.warn(
      "Calling Melissa Personator Search directly from frontend. " +
      "Do not expose your license key in production."
    );

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

    const maskedUrl = maskKeyInUrl(url);
    console.log("Melissa Search URL:", maskedUrl);

    const response = await fetch(url, { method: "GET", signal: controller.signal });
    console.log("Melissa Search response status:", response.status);

    if (!response.ok) {
      throw new Error(
        `Melissa Search API error ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();
    console.log("Melissa Search raw response:", data);
    return data;
  } catch (error) {
    // AbortError fires when the 20s timer trips controller.abort(). Surface
    // a user-friendly message so the PageLoad catch can show it in the banner.
    if (error && error.name === "AbortError") {
      throw new Error("Melissa Search request timed out. Please try again.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
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
    // Identity, phone, email live at the PARENT record level — extract once
    // and attach to every address row produced from this record so the strict
    // First + Last + Zip filter has firstName/lastName on every flattened row.
    console.log("Parent PhoneRecords:", record.PhoneRecords);
    console.log("Parent EmailRecords:", record.EmailRecords);

    const firstName =
      record.Name?.FirstName ||
      record.FirstName ||
      record.First_Name ||
      record.First ||
      "";

    const lastName =
      record.Name?.LastName ||
      record.LastName ||
      record.Last_Name ||
      record.Last ||
      "";

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

    console.log("Extracted firstName:", firstName, "lastName:", lastName);
    console.log("Extracted phone:", phone);
    console.log("Extracted email:", email);

    const buildRow = (addr) => ({
      firstName: toDisplayString(firstName),
      lastName: toDisplayString(lastName),
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
        firstName: toDisplayString(firstName),
        lastName: toDisplayString(lastName),
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
      <td>${escapeHtml(rec.firstName) || "—"}</td>
      <td>${escapeHtml(rec.lastName) || "—"}</td>
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
    ["First Name", rec.firstName],
    ["Last Name", rec.lastName],
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
        r.firstName,
        r.lastName,
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

// Attach the Update Lead click handler after the DOM has parsed. The script
// tag is at the end of <body>, so the element exists by now in normal flow,
// but the readyState branch covers the case where this file is bundled or
// loaded async/defer.
function attachUpdateLeadHandler() {
  updateLeadBtn = document.getElementById("updateLeadBtn");
  if (!updateLeadBtn) {
    console.error("attachUpdateLeadHandler: #updateLeadBtn not found in DOM.");
    return;
  }

  updateLeadBtn.addEventListener("click", async function () {
    console.log("Update Lead button clicked");
    await updateLeadRecord();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", attachUpdateLeadHandler);
} else {
  attachUpdateLeadHandler();
}

async function updateLeadRecord() {
  try {
    console.log("Update Lead button clicked");
    console.log("Current Lead ID:", currentLeadId);
    console.log("Selected Melissa Record:", selectedMelissaRecord);
    console.log("SDK Ready:", sdkReady);

    if (!sdkReady) {
      showBanner("Zoho SDK is not ready.", "error");
      return;
    }
    if (!currentLeadId) {
      showBanner("Current Lead ID not found.", "error");
      return;
    }
    if (!selectedMelissaRecord) {
      showBanner("Please select a Melissa record first.", "error");
      return;
    }

    hideBanner();
    if (updateLeadBtn) {
      updateLeadBtn.disabled = true;
      updateLeadBtn.textContent = "Updating...";
    }

    // Payload is built via FIELD_API_NAMES so Street/State/City API names
    // remain editable in one place — change them in the config block at the
    // top of the file. Zip/Phone/Email are confirmed working.
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
      throw new Error(
        updateResponse?.data?.[0]?.message || "Zoho update failed."
      );
    }

    showSuccessModal("Record update successfully");
  } catch (error) {
    console.error("Update Lead failed:", error);
    showBanner("Update failed: " + (error.message || error), "error");
  } finally {
    if (updateLeadBtn) {
      updateLeadBtn.disabled = false;
      updateLeadBtn.textContent = "Update Lead";
    }
  }
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
      [FIELD_API_NAMES.phone]: rec.phone || "",
      [FIELD_API_NAMES.email]: rec.email || "",
    };
  }

  // Separate-fields mode — payload assembled from FIELD_API_NAMES so the
  // mapping is editable in one place. Zip stays isolated from Street/State/City.
  const updatePayload = { id: leadId };
  updatePayload[FIELD_API_NAMES.street] = rec.homeAddressStreet || "";
  updatePayload[FIELD_API_NAMES.state]  = rec.homeAddressState  || "";
  updatePayload[FIELD_API_NAMES.city]   = rec.homeAddressCity   || "";
  updatePayload[FIELD_API_NAMES.zip]    = rec.homeAddressZip    || "";
  updatePayload[FIELD_API_NAMES.phone]  = rec.phone             || "";
  updatePayload[FIELD_API_NAMES.email]  = rec.email             || "";
  return updatePayload;
}

/* ===============================
 * SUCCESS MODAL + CLOSE
 * =============================== */

function showSuccessModal(message) {
  const modal = document.getElementById("successModal");
  const text = message || "Record update successfully";

  if (!modal) {
    alert(text);
    return;
  }

  const msgEl =
    document.getElementById("successMessage") ||
    modal.querySelector(".success-message, .modal-message, h3, p");
  if (msgEl) msgEl.textContent = text;

  modal.classList.remove("hidden");
  modal.style.display = "flex";
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
