/* =============================================================
 * Melissa Personator Search — Lead Update Widget
 * -------------------------------------------------------------
 * Flow:
 *   1. Zoho SDK PageLoad -> get current Lead ID
 *   2. Fetch current Lead from Zoho CRM (input only)
 *   3. Build Melissa Personator Search request from Lead fields
 *   4. Call Melissa Personator Search API (broad consumer search)
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
const PERSONATOR_LICENSE_KEY = "REPLACE_WITH_YOUR_REAL_LICENSE_KEY";

/**
 * Address update mode for Zoho CRM Leads:
 *   "separate" -> Home_Address_Street, Home_Address_State, ...
 *                 Use this if your Lead layout shows the address as
 *                 four independent fields.
 *   "compound" -> single Home_Address object with sub-fields.
 *                 Use this if your Lead layout uses Zoho's compound
 *                 address field (one block, multiple sub-fields).
 */
const ADDRESS_UPDATE_MODE = "separate"; // "separate" | "compound"

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

    // 2) Build Melissa Search params from Lead values
    const params = buildMelissaSearchParams(currentLeadRecord);
    console.log("Melissa Search request params:", params);

    // 3) Call Melissa Personator Search API
    const rawResponse = await callMelissaSearchAPI(params);
    console.log("Melissa Search raw response:", rawResponse);
    console.log("Melissa Search records:", rawResponse?.Records);

    const trResult     = String(rawResponse?.TransmissionResults || "");
    const totalRecords = parseInt(rawResponse?.TotalRecords || "0", 10);
    const rawRecords   = Array.isArray(rawResponse?.Records) ? rawResponse.Records : [];

    console.log("TransmissionResults:", trResult);
    console.log("TotalRecords:", totalRecords);
    console.log("Raw Records count:", rawRecords.length);

    setLoading(false);

    // Case 1: Melissa reports no matches at all
    if (totalRecords === 0 || rawRecords.length === 0) {
      setEmptyMessage("No Melissa Search records found for this Lead.");
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
      setEmptyMessage("No Melissa Search records found for this Lead.");
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
    first:  lead.First_Name || "",
    last:   lead.Last_Name  || "",
    city:   lead.Home_Address_City  || ha.City  || lead.City  || "",
    state:  lead.Home_Address_State || ha.State || lead.State || "",
    postal: lead.Home_Address_Zip   || ha.Zip   || lead.Zip_Code || "",
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
    "?id="     + encodeURIComponent(PERSONATOR_LICENSE_KEY) +
    "&cols=GrpAll" +
    "&format=JSON" +
    "&first="  + encodeURIComponent(params.first  || "") +
    "&last="   + encodeURIComponent(params.last   || "") +
    "&city="   + encodeURIComponent(params.city   || "") +
    "&state="  + encodeURIComponent(params.state  || "") +
    "&postal=" + encodeURIComponent(params.postal || "") +
    "&opt=ReturnAllPages:True,SearchConditions:loose";

  console.log("Melissa Search API URL:", url);

  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`Melissa Search API error ${resp.status} ${resp.statusText}`);
  }
  return await resp.json();
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
    record.AddressHouseNumber || record.ParsedAddressRange    || record.AddressRange,
    record.AddressPreDirection || record.ParsedAddressPreDirection,
    record.AddressStreetName  || record.ParsedStreetName,
    record.AddressStreetSuffix || record.ParsedStreetSuffix   || record.AddressSuffix,
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

  // Diagnostic: print the first record so unknown key names are discoverable
  console.log("FIRST RAW MELISSA RECORD:", JSON.stringify(records[0], null, 2));
  Object.keys(records[0]).forEach((key) => {
    console.log("MELISSA KEY:", key, "VALUE:", records[0][key]);
  });
  Object.keys(records[0]).forEach((key) => {
    const lower = key.toLowerCase();
    if (
      lower.includes("address") ||
      lower.includes("street")  ||
      lower.includes("delivery") ||
      lower.includes("mailing") ||
      lower.includes("premise")
    ) {
      console.log("POSSIBLE STREET KEY:", key, records[0][key]);
    }
  });

  return records.map((record) => {
    // STREET — every known Melissa street key, then parsed parts.
    // Plus4 deliberately excluded (it is the ZIP+4 extension, not street).
    const street =
      record.AddressLine1 ||
      record.Address ||
      record.DeliveryAddress ||
      record.MailingAddress ||
      record.Address1 ||
      record.StreetAddress ||
      record.Street ||
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
      buildStreetFromParts(record) ||
      "";

    if (!street) {
      console.warn("Street not returned by Melissa for this record.", record);
    }

    // CITY — only city keys
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

    // STATE — only state keys
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

    // ZIP — only postal keys; never leaks anywhere else
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

    const phone = pickValue(record, [
      "PhoneNumber",
      "Phone",
      "Phone_Number",
      "Phone1",
      "ParsedPhoneNumber",
      "HomePhone",
      "PhoneDetails.PhoneNumber",
      "ParsedPhone.PhoneNumber",
      "GrpParsedPhone.PhoneNumber",
      "GrpPhone.PhoneNumber",
    ]);

    const email = pickValue(record, [
      "EmailAddress",
      "Email",
      "Email_Address",
      "Email1",
      "EmailDetails.EmailAddress",
      "ParsedEmail.EmailAddress",
      "GrpParsedEmail.EmailAddress",
      "GrpEmail.EmailAddress",
    ]);

    return {
      homeAddressStreet: street || "",
      homeAddressState:  state  || "",
      homeAddressCity:   city   || "",
      homeAddressZip:    zip    || "",
      phone:             phone  || "",
      email:             email  || "",
    };
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
    const payload = buildUpdatePayload(currentLeadId, selectedMelissaRecord);
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
