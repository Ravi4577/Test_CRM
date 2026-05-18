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

const PERSONATOR_ENDPOINT =
"https://personator.melissadata.net/v3/WEB/ContactVerify/doContactVerify";

/**
 * Backend proxy URL (preferred). Leave empty string to call Personator directly.
 * SECURITY: Do NOT expose the API key in frontend production code.
 */
const PERSONATOR_PROXY_URL = ""; // <-- SET THIS for production

/**
 * TEMPORARY/TESTING ONLY — direct license key.
 * Do not expose API key in frontend production. Use backend proxy.
 */
const PERSONATOR_LICENSE_KEY = "NNyQiGBQttkIhzONLxAqXx**";

const PERSONATOR_COLUMNS = "GrpAddress,GrpName,GrpPhone,GrpEmail,GrpCensus,GrpAddressDetails";

/**
 * Address update mode for Zoho CRM Leads:
 *   "separate" -> Home_Address_Street, Home_Address_State, ...
 *   "compound" -> single Home_Address object with sub-fields
 */
const ADDRESS_UPDATE_MODE = "separate"; // "separate" | "compound"

/* ===============================
 * STATE
 * =============================== */

let sdkReady = false;
let currentLeadId = null;
let currentLeadRecord = null;
let personatorRecords = [];
let filteredRecords = [];
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

/**
 * Update the empty-state message text without touching design.
 */
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
    !sdkReady || !currentLeadId || !selectedPersonatorRecord;
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
    // 1) Fetch current Lead
    currentLeadRecord = await fetchCurrentLead(currentLeadId);
    console.log("Current Lead Data:", currentLeadRecord);

    // 2) Call Personator Consumer API using Lead data
    const params = buildPersonatorParams(currentLeadRecord);
    console.log("Personator API request params:", params);

    const rawResponse = await callPersonatorAPI(params);
    console.log("Personator API raw response:", rawResponse);

    // ----------------------------------------------------------
    // Check Melissa transmission result and TotalRecords FIRST
    // ----------------------------------------------------------
    const trResult = String(rawResponse?.TransmissionResults || "");
    const totalRecords = parseInt(rawResponse?.TotalRecords || "0", 10);
    const rawRecords = Array.isArray(rawResponse?.Records) ? rawResponse.Records : [];

    console.log("TransmissionResults:", trResult);
    console.log("TotalRecords:", totalRecords);
    console.log("Raw Records count:", rawRecords.length);

    setLoading(false);

    // Case 1: No exact match according to Melissa
    if (trResult.indexOf("GE02") !== -1 || totalRecords === 0) {
      setEmptyMessage("No exact Personator match found for this Lead.");
      showEmpty(true);
      showResults(false);
      return;
    }

    // 3) Map records
    const mapped = mapPersonatorRecords(rawResponse);
    console.log("Mapped Personator records:", mapped);

    // 4) Filter to usable records (must have at least one field with a value)
    const usableRecords = mapped.filter(
      (r) =>
        r.homeAddressStreet ||
        r.homeAddressState ||
        r.homeAddressCity ||
        r.homeAddressZip ||
        r.phone ||
        r.email
    );
    console.log("Usable Personator records after filter:", usableRecords);

    // Case 2: Records exist but none have usable data
    if (usableRecords.length === 0) {
      if (rawRecords.length > 0) {
        console.log(
          "Raw response contained records but no usable address/contact data:",
          rawResponse
        );
        setEmptyMessage(
          "Personator returned a response, but no usable address/contact data was found."
        );
      } else {
        setEmptyMessage("No usable Personator Consumer data found for this Lead.");
      }
      showEmpty(true);
      showResults(false);
      return;
    }

    // 5) Render only usable records
    personatorRecords = usableRecords;
    filteredRecords = [...usableRecords];

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
  const fullName =
    lead.Full_Name ||
    [lead.First_Name, lead.Last_Name].filter(Boolean).join(" ").trim();

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
    ctry:   "US",
  };

  Object.keys(params).forEach((k) => {
    if (!params[k]) delete params[k];
  });

  return params;
}

/* ===============================
 * PERSONATOR — API CALL
 * =============================== */

async function callPersonatorAPI(params) {
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

/* =====================================================================
 * PERSONATOR — RESPONSE MAPPING (FIXED)
 * ---------------------------------------------------------------------
 * Handles both flat field names and nested objects.
 * Logs the first raw record in detail so unknown field names are visible.
 * Supports many possible key variants used across Melissa endpoints.
 * ===================================================================== */

/**
 * Pick the first non-empty value from a list of paths. Each path may use
 * dot-notation to walk into nested objects, e.g. "Address.City".
 */
function pickValue(obj, paths) {
  for (let i = 0; i < paths.length; i++) {
    const parts = paths[i].split(".");
    let v = obj;
    for (let j = 0; j < parts.length; j++) {
      if (v === null || v === undefined) {
        v = undefined;
        break;
      }
      v = v[parts[j]];
    }
    if (v !== null && v !== undefined && v !== "") {
      const out = typeof v === "string" ? v.trim() : v;
      if (out !== "") return out;
    }
  }
  return "";
}

/**
 * Some Melissa columns split the address into parsed parts.
 * Build a full street string from those parts as a fallback.
 */
function buildStreetFromParts(record) {
  return [
    record.AddressHouseNumber     || record.ParsedAddressRange         || record.AddressRange,
    record.AddressPreDirection    || record.ParsedAddressPreDirection,
    record.AddressStreetName      || record.ParsedStreetName,
    record.AddressStreetSuffix    || record.ParsedStreetSuffix         || record.AddressSuffix,
    record.AddressPostDirection   || record.ParsedAddressPostDirection,
    record.AddressSuiteName,
    record.AddressSuiteNumber,
  ]
    .map((s) => (s == null ? "" : String(s).trim()))
    .filter(Boolean)
    .join(" ")
    .trim();
}

function mapPersonatorRecords(response) {
  if (!response) return [];

  const records =
    response.Records ||
    response.records ||
    response.Data ||
    response.results ||
    [];

  if (!Array.isArray(records)) return [];

  // ---- Deep diagnostic logging on the first record ----
  if (records[0]) {
    console.log("FIRST RAW PERSONATOR RECORD JSON:", JSON.stringify(records[0], null, 2));
    Object.keys(records[0]).forEach((key) => {
      console.log("PERSONATOR KEY:", key, "VALUE:", records[0][key]);
    });
    // Highlight any keys that could plausibly carry the street value
    Object.keys(records[0]).forEach((key) => {
      const lower = key.toLowerCase();
      if (
        lower.includes("address") ||
        lower.includes("street") ||
        lower.includes("delivery") ||
        lower.includes("mailing") ||
        lower.includes("premise")
      ) {
        console.log("POSSIBLE STREET KEY:", key, records[0][key]);
      }
    });
  }

  return records.map((record) => {
    /*
     * STREET — try every known Personator/Melissa street key, then fall back
     * to parsed address parts. Never falls through to ZIP/State/City.
     * (Plus4 deliberately excluded — it is the ZIP+4 extension, not street.)
     */
    const street =
      record.AddressLine1 ||
      record.DeliveryAddress ||
      record.Address ||
      record.Address1 ||
      record.StreetAddress ||
      record.Street ||
      record.MailingAddress ||
      record.PremisesAddress ||
      record.PremiseAddress ||
      record.AddressDeliveryLine ||
      record.DeliveryLine ||
      record.AddressLine ||
      record.CurrentAddress ||
      pickValue(record, [
        "Address.AddressLine1",
        "Address.AddressLine",
        "AddressDetails.AddressLine1",
        "GrpAddressDetails.AddressLine1",
        "MailingAddress.AddressLine1",
      ]) ||
      [
        record.AddressHouseNumber,
        record.AddressPreDirection,
        record.AddressStreetName,
        record.AddressStreetSuffix,
        record.AddressPostDirection,
        record.AddressSuiteName,
        record.AddressSuiteNumber,
      ].filter(Boolean).join(" ") ||
      buildStreetFromParts(record) ||
      "";

    if (!street) {
      console.warn("Street value not returned by Personator API.", record);
    }

    /*
     * CITY
     */
    const city = pickValue(record, [
      "City",
      "Locality",
      "AddressCity",
      "MailingCity",
      "Address.City",
      "AddressDetails.City",
      "GrpAddressDetails.City",
      "MailingAddress.City",
    ]);

    /*
     * STATE
     */
    const state = pickValue(record, [
      "State",
      "AdministrativeArea",
      "AddressState",
      "MailingState",
      "StateProvince",
      "Address.State",
      "AddressDetails.State",
      "GrpAddressDetails.State",
      "MailingAddress.State",
    ]);

    /*
     * ZIP — strict isolation: only zip/postal fields, never street/state/city.
     */
    const zip = pickValue(record, [
      "PostalCode",
      "Zip",
      "ZipCode",
      "AddressPostalCode",
      "MailingPostalCode",
      "PostalCodePlus4",
      "Address.PostalCode",
      "AddressDetails.PostalCode",
      "GrpAddressDetails.PostalCode",
      "MailingAddress.PostalCode",
    ]);

    /*
     * PHONE
     */
    const phone = pickValue(record, [
      "Phone",
      "PhoneNumber",
      "Phone_Number",
      "Phone1",
      "ParsedPhoneNumber",
      "HomePhone",
      "PhoneDetails.PhoneNumber",
      "ParsedPhone.PhoneNumber",
      "GrpParsedPhone.PhoneNumber",
      "GrpPhone.PhoneNumber",
    ]);

    /*
     * EMAIL
     */
    const email = pickValue(record, [
      "Email",
      "EmailAddress",
      "Email_Address",
      "Email1",
      "EmailDetails.EmailAddress",
      "ParsedEmail.EmailAddress",
      "GrpParsedEmail.EmailAddress",
      "GrpEmail.EmailAddress",
    ]);

    const personatorMappedRecord = {
      homeAddressStreet: street || "",
      homeAddressState:  state  || "",
      homeAddressCity:   city   || "",
      homeAddressZip:    zip    || "",
      phone:             phone  || "",
      email:             email  || "",
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
 * ADDRESS_UPDATE_MODE = "compound". Otherwise "separate".
 * Zip is NEVER copied into Street/State/City.
 * ------------------------------------------------------------- */
function buildUpdatePayload(leadId, rec) {
  if (ADDRESS_UPDATE_MODE === "compound") {
    return {
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
  }

  return {
    id: leadId,
    Home_Address_Street: rec.homeAddressStreet || "",
    Home_Address_State:  rec.homeAddressState  || "",
    Home_Address_City:   rec.homeAddressCity   || "",
    Home_Address_Zip:    rec.homeAddressZip    || "",
    Phone:               rec.phone             || "",
    Email:               rec.email             || "",
  };
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
