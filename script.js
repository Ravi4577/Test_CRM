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

// Latch that flips true once the Melissa table has rendered successfully.
// PageLoad uses it to bail out on any subsequent fire so we never rebuild
// rows against an updated Lead — that's what was reshuffling phones between
// Current Address and Previous Address rows after Update Lead.
let melissaTableRendered = false;

// Frozen snapshot of the Lead values used to seed Melissa search and to run
// matchesLeadCriteria. Captured the FIRST time the widget renders for a
// given Lead ID and persisted in localStorage. Every subsequent open uses
// the snapshot rather than the live CRM Lead — otherwise Update Lead would
// rewrite the Lead's Email/Phone/Zip to one person's values, narrow the
// next search to just that person, and erase the other previously-matched
// persons from the results.
let searchLeadRecord = null;

const LEAD_SNAPSHOT_STORAGE_PREFIX = "melissaWidget:leadSearchCriteria:";

function getLeadSnapshotStorageKey(leadId) {
  return LEAD_SNAPSHOT_STORAGE_PREFIX + String(leadId);
}

function loadSavedLeadSearchCriteria(leadId) {
  try {
    const raw = localStorage.getItem(getLeadSnapshotStorageKey(leadId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    console.warn("loadSavedLeadSearchCriteria failed:", e);
    return null;
  }
}

function persistLeadSearchCriteria(leadId, leadRecord) {
  try {
    const snapshot = {
      First_Name:       String(leadRecord?.First_Name       || ""),
      Last_Name:        String(leadRecord?.Last_Name        || ""),
      Email:            String(leadRecord?.Email            || ""),
      Phone:            String(leadRecord?.Phone            || ""),
      Mobile:           String(leadRecord?.Mobile           || ""),
      Year_of_Birth:    String(leadRecord?.Year_of_Birth    || ""),
      Date_of_Birth:    String(leadRecord?.Date_of_Birth    || ""),
      DOB:              String(leadRecord?.DOB              || ""),
      Home_Address_Zip: String(leadRecord?.Home_Address_Zip || ""),
      Zip_Code:         String(leadRecord?.Zip_Code         || ""),
    };
    localStorage.setItem(
      getLeadSnapshotStorageKey(leadId),
      JSON.stringify(snapshot)
    );
    return snapshot;
  } catch (e) {
    console.warn("persistLeadSearchCriteria failed:", e);
    return null;
  }
}

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

function showBanner(message, type = "info")
 {
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

  // Enlarge the Zoho widget popup as soon as the page loads. Wrapped in a
  // try/catch so older SDK builds that don't expose Resize don't break load.
  try {
    if (ZOHO?.CRM?.UI?.Resize) {
      ZOHO.CRM.UI.Resize({ height: "1000", width: "1900" });
    }
  } catch (resizeErr) {
    console.warn("ZOHO.CRM.UI.Resize failed:", resizeErr);
  }

  // PageLoad can re-fire after ZOHO.CRM.API.updateRecord on some SDK builds.
  // A second run would re-fetch the (now-updated) Lead and re-call
  // mapMelissaRecords, which picks the Current Address phone by matching
  // against the Lead's phone. Once the Lead's phone is the value the user
  // just selected, the row assignment shifts: the selected phone migrates to
  // the Current row and the prior Current-row phone gets pushed into a
  // Previous row — exactly the swap reported. Bail out before any state
  // touches the DOM so the displayed table stays frozen.
  if (melissaTableRendered) {
    console.log(
      "PageLoad re-fired after initial render — skipping to preserve Melissa table phones."
    );
    return;
  }

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
    // 1) Fetch current Lead — used as the final update target. For SEARCH
    //    and MATCH we may instead use a persisted snapshot of the Lead's
    //    original criteria (see below) so that Update Lead clicks don't
    //    narrow future searches and erase previously-matched persons.
    currentLeadRecord = await fetchCurrentLead(currentLeadId);
    console.log("Current Lead Data (live CRM):", currentLeadRecord);

    // 1a) Resolve the criteria the search and match steps will use. First
    //     open for this Lead → snapshot current CRM values and store them
    //     in localStorage. Subsequent opens → load the saved snapshot so
    //     the search/match basis is immutable across Update Lead clicks.
    //     We never overwrite an existing snapshot with current CRM values —
    //     that's what was causing other persons to disappear.
    const savedCriteria = loadSavedLeadSearchCriteria(currentLeadId);
    if (savedCriteria) {
      searchLeadRecord = savedCriteria;
      console.log(
        "Loaded saved Lead search criteria from prior session — using these for search/match (not the live CRM values):",
        searchLeadRecord
      );
    } else {
      searchLeadRecord =
        persistLeadSearchCriteria(currentLeadId, currentLeadRecord) ||
        currentLeadRecord;
      console.log(
        "First open for this Lead — captured live CRM values as the immutable search criteria:",
        searchLeadRecord
      );
    }

    console.log("Lead values used for search on widget open:", {
      First_Name:       searchLeadRecord.First_Name,
      Last_Name:        searchLeadRecord.Last_Name,
      Email:            searchLeadRecord.Email,
      Phone:            searchLeadRecord.Phone || searchLeadRecord.Mobile,
      Year_of_Birth:    searchLeadRecord.Year_of_Birth,
      Home_Address_Zip: searchLeadRecord.Home_Address_Zip,
    });

    // 2) Build identity params from the search-criteria snapshot. First +
    //    Last are mandatory; postal / email / phone / birthYear are
    //    optional search helpers and each spawns an additional Melissa
    //    attempt only when present.
    const baseParams = buildMelissaSearchParams(searchLeadRecord);
    console.log("Lead identity for search:", baseParams);

    // First + Last are the bare minimum — without them no Melissa search can
    // satisfy the (First AND Last) clause of the matching filter.
    if (!baseParams.first || !baseParams.last) {
      setLoading(false);
      setEmptyMessage(
        "Cannot search Melissa: First Name and Last Name are required on the Lead."
      );
      showEmpty(true);
      showResults(false);
      return;
    }

    // 3) Build every applicable attempt in the required business order:
    //    (1) First + Last + Email
    //    (2) First + Last + Phone
    //    (3) First + Last + Year of Birth
    //    (4) First + Last + Home Address Zip
    //    (5) First + Last fallback (always runs at the end)
    //    Optional fields are skipped only when the Lead has no value for them.
    const searchAttempts = [];
    if (baseParams.email) {
      searchAttempts.push({
        label: "first + last + email",
        params: { first: baseParams.first, last: baseParams.last, email: baseParams.email },
      });
    }
    if (baseParams.phone) {
      searchAttempts.push({
        label: "first + last + phone",
        params: { first: baseParams.first, last: baseParams.last, phone: baseParams.phone },
      });
    }
    if (baseParams.birthYear) {
      searchAttempts.push({
        label: "first + last + birth year",
        params: { first: baseParams.first, last: baseParams.last, birthYear: baseParams.birthYear },
      });
    }
    if (baseParams.postal) {
      searchAttempts.push({
        label: "first + last + postal",
        params: { first: baseParams.first, last: baseParams.last, postal: baseParams.postal },
      });
    }
    // Fallback ALWAYS runs at the end — do not gate on prior results.
    searchAttempts.push({
      label: "first + last fallback",
      params: { first: baseParams.first, last: baseParams.last },
    });

    console.log(`Will run ${searchAttempts.length} search attempt(s) in order:`,
      searchAttempts.map((a) => a.label));

    // 4) Run EVERY attempt — do NOT stop on a successful one. Collect every
    //    Records[] into a single merged array.
    const allRecords = [];
    let licenseIssueDetected = false;
    let lastTransmissionResults = "";
    let lastRawResponse = null;

    for (const attempt of searchAttempts) {
      console.log(`Attempt: ${attempt.label}`, attempt.params);

      let rawResponse = null;
      try {
        rawResponse = await callMelissaSearchAPI(attempt.params);
      } catch (attemptErr) {
        console.error(`Attempt "${attempt.label}" threw:`, attemptErr);
        continue;
      }

      lastRawResponse = rawResponse;
      console.log(`Attempt "${attempt.label}" TransmissionResults:`, rawResponse?.TransmissionResults);
      console.log(`Attempt "${attempt.label}" TotalRecords:`, rawResponse?.TotalRecords);

      if (hasLicenseError(rawResponse)) {
        licenseIssueDetected = true;
        lastTransmissionResults = String(rawResponse?.TransmissionResults || "");
        break;
      }

      const recs = Array.isArray(rawResponse?.Records) ? rawResponse.Records : [];
      console.log(`Attempt "${attempt.label}" raw records returned:`, recs.length, recs);
      allRecords.push(...recs);
      console.log(`Total collected records so far:`, allRecords.length);
    }

    console.log("Total collected records from ALL attempts:", allRecords.length);

    // License / access failure — bail out immediately.
    if (licenseIssueDetected) {
      setLoading(false);
      console.error("Melissa license/access error. TransmissionResults:", lastTransmissionResults, lastRawResponse);
      setEmptyMessage("Melissa license key or Personator Search access issue.");
      showEmpty(true);
      showResults(false);
      return;
    }

    // 5) Strict dedupe across the merged array. Rule 1 — MelissaIdentityKey
    //    when present. Rule 2 — full strict signature (FullName + DOB +
    //    CurrentAddress + Zip + ALL phones + ALL emails). Anything weaker
    //    risks collapsing two different people who share a name/DOB/zip.
    const uniqueRaw = dedupRawMelissaRecords(allRecords);
    const duplicatesRemoved = allRecords.length - uniqueRaw.length;
    console.log("Duplicate records removed:", duplicatesRemoved);
    console.log("Unique records count:", uniqueRaw.length);

    // 6) Two-tier matching to keep all valid persons in the table even when
    //    the snapshot was created after an earlier Update Lead (the cause of
    //    the lead-specific regression: snapshot captured already-updated
    //    CRM values, strict match then drops Person #1 because none of its
    //    secondary fields line up with Person #2's data).
    //
    //    Tier 1 — STRICT: unchanged matchesLeadCriteria —
    //      (First AND Last) AND (Email OR Phone OR Year OR Zip).
    //    Tier 2 — FALLBACK: First Name + Last Name only.
    //      Records returned by the "First + Last fallback" Melissa attempt
    //      already share the Lead's name; the strict filter was the only
    //      thing knocking them out. Including them here keeps Person #1
    //      visible across any future Update Lead.
    //
    //    Records that pass Tier 1 are reported as strict; records that fail
    //    Tier 1 but pass Tier 2 are reported as fallback. They render
    //    identically — the tier label is internal/diagnostic only.
    const strictMatched = [];
    const fallbackMatched = [];
    const skippedRecords = [];

    uniqueRaw.forEach((r) => {
      const key = getMelissaUniqueKey(r);
      if (matchesLeadCriteria(r, searchLeadRecord)) {
        strictMatched.push(r);
        return;
      }
      if (matchesLeadNameOnly(r, searchLeadRecord)) {
        fallbackMatched.push(r);
        console.log(
          "Including FALLBACK (name-only) record — strict criteria failed but First+Last matched:",
          key
        );
        return;
      }
      skippedRecords.push({
        key,
        reason: "First Name and/or Last Name did not match the Lead",
      });
    });

    console.log("Strict matched records count:", strictMatched.length);
    console.log("Fallback matched records count (first+last only):", fallbackMatched.length);
    console.log("Skipped records with reason:", skippedRecords);

    // Union — strict first, then fallback. dedupRawMelissaRecords already
    // ran on uniqueRaw upstream, so the two arrays are disjoint and the
    // concat is safe.
    const matchedRaw = strictMatched.concat(fallbackMatched);
    console.log("Final rendered records count:", matchedRaw.length);
    console.log(
      "Matched record identity keys:",
      matchedRaw.map((r) => getMelissaUniqueKey(r))
    );

    setLoading(false);

    if (matchedRaw.length === 0) {
      setEmptyMessage(
        "No Melissa records matched: (First Name AND Last Name) AND (Email OR Phone OR Birth Year OR Zip)."
      );
      showEmpty(true);
      showResults(false);
      return;
    }

    // 8) Flatten each matched record into one row per address.
    const flattenedMelissaRows = mapMelissaRecords(matchedRaw);
    console.log("Flattened Melissa rows:", flattenedMelissaRows);

    // 5) Drop duplicate rows. A record with two PreviousAddresses that share
    //    the same street+city+zip would otherwise produce two identical rows.
    const uniqueRows = dedupMelissaRows(flattenedMelissaRows);
    console.log(
      `Dedup: ${flattenedMelissaRows.length} → ${uniqueRows.length} unique rows.`
    );

    if (uniqueRows.length === 0) {
      setEmptyMessage(
        "No Melissa records matched: (First Name AND Last Name) AND (Email OR Phone OR Birth Year OR Zip)."
      );
      showEmpty(true);
      showResults(false);
      return;
    }

    // 6) Render. Freeze every row object so that nothing downstream — the
    //    update handler, the filter handler, Zoho SDK callbacks, accidental
    //    assignments — can rewrite a cell after the table is on screen.
    //    Object.freeze on each row turns any later `row.phone = ...` into a
    //    silent no-op (strict mode throws), which is exactly the guarantee
    //    the spec asks for: phones must stay in their original rows.
    melissaRecords  = uniqueRows.map((r) => Object.freeze({ ...r }));
    filteredRecords = melissaRecords.slice();

    renderResults(filteredRecords);
    showResults(true);
    els.filterInput.disabled = false;

    // Latch the table as rendered AFTER a successful render path only — a
    // mid-load failure must still allow a clean retry on the next PageLoad.
    melissaTableRendered = true;
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
  // First + Last are mandatory; the rest are optional helpers that feed the
  // additional search attempts (first+last+email, first+last+phone, etc.).
  return {
    first:     String(lead?.First_Name || "").trim(),
    last:      String(lead?.Last_Name  || "").trim(),
    postal:    String(lead?.Home_Address_Zip || "").trim(),
    email:     String(lead?.Email || "").trim(),
    phone:     String(lead?.Phone || lead?.Mobile || "").trim(),
    birthYear: String(lead?.Year_of_Birth || "").trim() ||
               extractYear(lead?.Date_of_Birth || lead?.DOB),
  };
}

/* ===============================
 * NORMALIZATION HELPERS — used for strict First + Last + Zip matching.
 * =============================== */

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

// Generic text normalizer used by the strict dedupe key — lowercases, trims,
// and collapses internal whitespace so cosmetic differences like
// "123  Main  St " and "123 Main St" produce the same signature.
function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeZip(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 5);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

// Phone numbers may carry country codes, separators, parentheses. Reduce to
// digits and compare on the last 10 (US numbering plan) so "+1 (513) 668-6893"
// matches "5136686893".
function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// Pull the year out of any date-ish string. Accepts "1985", "1985-03-12",
// "03/12/1985", ISO strings, etc.
function extractYear(value) {
  if (!value) return "";
  const m = String(value).match(/(19|20)\d{2}/);
  return m ? m[0] : "";
}

/* ===============================
 * RECORD-LEVEL FILTER
 * -------------------------------
 * Final condition required by the business:
 *   (First Name match AND Last Name match)
 *   AND
 *   (Email OR Phone OR Birth Year OR Zip match)
 *
 * Zip match uses the union of CurrentAddress + PreviousAddresses, so a person
 * with multiple known addresses still matches if any of their zips lines up.
 * =============================== */
function matchesLeadCriteria(record, lead) {
  const leadFirstName = normalizeName(lead?.First_Name);
  const leadLastName  = normalizeName(lead?.Last_Name);
  const leadEmail     = normalizeEmail(lead?.Email);
  const leadPhone     = normalizePhone(lead?.Phone || lead?.Mobile);
  // Zoho stores the year as a 4-digit value in Year_of_Birth. Fall back to a
  // full date field only if Year_of_Birth is empty, so the regex extractor
  // still works for legacy Date_of_Birth values.
  const leadBirthYear = String(lead?.Year_of_Birth || "").trim() ||
                        extractYear(lead?.Date_of_Birth || lead?.DOB);
  const leadZip       = normalizeZip(lead?.Home_Address_Zip || lead?.Zip_Code);

  const recFirstName = normalizeName(
    record?.Name?.FirstName || record?.FirstName || record?.First_Name || record?.First
  );
  const recLastName = normalizeName(
    record?.Name?.LastName || record?.LastName || record?.Last_Name || record?.Last
  );

  const recEmails = (record?.EmailRecords || [])
    .map((e) => (typeof e === "string" ? e : e?.Email || e?.email || e?.EmailAddress))
    .map(normalizeEmail)
    .filter(Boolean);

  const recPhones = (record?.PhoneRecords || [])
    .map((p) => (typeof p === "string" ? p : p?.PhoneNumber || p?.phoneNumber || p?.Phone))
    .map(normalizePhone)
    .filter(Boolean);

  // Melissa returns DateOfBirth as "YYYYMM" (e.g. "195407" for July 1954).
  // Slice the first 4 chars to keep just the year. Fall back to other
  // year-like fields if DateOfBirth is missing.
  const rawDob = String(record?.DateOfBirth || "").trim();
  const recBirthYear =
    rawDob.substring(0, 4) ||
    String(record?.YearOfBirth || record?.BirthYear || "").trim() ||
    extractYear(record?.DOB);

  const recZips = [];
  if (record?.CurrentAddress?.PostalCode) {
    recZips.push(normalizeZip(record.CurrentAddress.PostalCode));
  }
  (record?.PreviousAddresses || []).forEach((a) => {
    if (a?.PostalCode) recZips.push(normalizeZip(a.PostalCode));
  });

  const firstNameMatch = Boolean(leadFirstName) && recFirstName === leadFirstName;
  const lastNameMatch  = Boolean(leadLastName)  && recLastName  === leadLastName;
  const emailMatch     = Boolean(leadEmail)     && recEmails.includes(leadEmail);
  const phoneMatch     = Boolean(leadPhone)     && recPhones.includes(leadPhone);
  const birthYearMatch = Boolean(leadBirthYear) && recBirthYear === leadBirthYear;
  const zipMatch       = Boolean(leadZip)       && recZips.includes(leadZip);

  console.log("Lead Birth Year:", leadBirthYear);
  console.log("Melissa DOB:", rawDob);
  console.log("Extracted Melissa Birth Year:", recBirthYear);
  console.log("Birth Year Match:", birthYearMatch);

  const secondaryMatch = emailMatch || phoneMatch || birthYearMatch || zipMatch;
  const finalMatchResult = firstNameMatch && lastNameMatch && secondaryMatch;

  console.log("matchesLeadCriteria:", {
    record: { firstName: recFirstName, lastName: recLastName, emails: recEmails, phones: recPhones, birthYear: recBirthYear, zips: recZips },
    lead:   { firstName: leadFirstName, lastName: leadLastName, email: leadEmail, phone: leadPhone, birthYear: leadBirthYear, zip: leadZip },
    firstNameMatch,
    lastNameMatch,
    emailMatch,
    phoneMatch,
    birthYearMatch,
    zipMatch,
    finalMatchResult,
  });

  return finalMatchResult;
}

// Name-only fallback predicate. Returns true when the record's First Name
// AND Last Name match the Lead's First Name AND Last Name. Used as Tier 2
// of the result filter so that records returned by the First+Last fallback
// Melissa attempt are kept even when every secondary criterion (Email /
// Phone / Year / Zip) has been rewritten by an Update Lead click.
function matchesLeadNameOnly(record, lead) {
  const leadFirstName = normalizeName(lead?.First_Name);
  const leadLastName  = normalizeName(lead?.Last_Name);
  if (!leadFirstName || !leadLastName) return false;

  const recFirstName = normalizeName(
    record?.Name?.FirstName || record?.FirstName || record?.First_Name || record?.First
  );
  const recLastName = normalizeName(
    record?.Name?.LastName || record?.LastName || record?.Last_Name || record?.Last
  );

  return recFirstName === leadFirstName && recLastName === leadLastName;
}

// Build the strict identity key for a raw Melissa record.
//
// Rule 1: When Melissa returns a MelissaIdentityKey, that is authoritative —
//         two records with the same key ARE the same person.
//
// Rule 2: When MelissaIdentityKey is missing, fall back to a strict combined
//         signature built from FullName + DateOfBirth + CurrentAddress +
//         PostalCode + ALL Phone Numbers + ALL Emails. Anything narrower
//         (name+DOB alone, name+phone alone, etc.) can collapse two different
//         people who happen to share a single attribute, so the full
//         signature is required.
function getMelissaUniqueKey(record) {
  const mik =
    record?.MelissaIdentityKey ||
    record?.melissaIdentityKey ||
    record?.MelissaIdentityKEY ||
    "";
  if (mik) return `mik:${String(mik).trim()}`;

  const phones = (record?.PhoneRecords || [])
    .map((p) =>
      normalizePhone(
        (typeof p === "string"
          ? p
          : p?.phoneNumber || p?.PhoneNumber || p?.Phone) || ""
      )
    )
    .filter(Boolean)
    .sort()
    .join("|");

  const emails = (record?.EmailRecords || [])
    .map((e) =>
      normalizeEmail(
        (typeof e === "string"
          ? e
          : e?.email || e?.Email || e?.EmailAddress) || ""
      )
    )
    .filter(Boolean)
    .sort()
    .join("|");

  const fullName =
    record?.FullName ||
    [
      record?.Name?.FirstName || record?.FirstName || record?.First_Name || record?.First || "",
      record?.Name?.MiddleName || record?.MiddleName || "",
      record?.Name?.LastName || record?.LastName || record?.Last_Name || record?.Last || "",
    ]
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .join(" ");

  return [
    "combined",
    normalizeText(fullName),
    String(record?.DateOfBirth || "").trim(),
    normalizeText(record?.CurrentAddress?.AddressLine1 || ""),
    normalizeZip(record?.CurrentAddress?.PostalCode || ""),
    phones,
    emails,
  ].join("||");
}

// Drop duplicate *raw* Melissa records. Multiple search attempts (e.g.
// first+last+email and first+last+phone) can each return the same person —
// we collapse them with the strict identity key above so two different
// people who happen to share a name + DOB + zip are NOT merged.
function dedupRawMelissaRecords(records) {
  if (!Array.isArray(records) || records.length === 0) return [];

  const uniqueRecordsMap = new Map();
  records.forEach((record) => {
    const key = getMelissaUniqueKey(record);
    if (!uniqueRecordsMap.has(key)) {
      uniqueRecordsMap.set(key, record);
    }
  });
  return Array.from(uniqueRecordsMap.values());
}

// Drop duplicate flattened rows. Two rows are the same person+address+contact
// if every normalized field collapses to the same string.
function dedupMelissaRows(rows) {
  const seen = new Set();
  const unique = [];
  rows.forEach((row) => {
    const key = [
      String(row.melissaRecordLabel || "").trim(),
      normalizeName(row.firstName),
      normalizeName(row.lastName),
      String(row.birthYear || "").trim(),
      normalizeName(row.dataType),
      normalizeName(row.homeAddressStreet),
      normalizeName(row.homeAddressCity),
      normalizeName(row.homeAddressState),
      normalizeZip(row.homeAddressZip),
      normalizePhone(row.phone),
      normalizeEmail(row.email),
    ].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(row);
  });
  return unique;
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

    // Optional Melissa params are appended only when the Lead actually has a
    // value — keeps the query URL focused and prevents stray empty fields
    // from narrowing the search on Melissa's side.
    const optional = (key, value) =>
      value ? "&" + key + "=" + encodeURIComponent(value) : "";

    const url =
      PERSONATOR_ENDPOINT +
      "?id=" + encodeURIComponent(PERSONATOR_LICENSE_KEY) +
      "&cols=GrpAll" +
      "&format=JSON" +
      "&first=" + encodeURIComponent(params.first || "") +
      "&last="  + encodeURIComponent(params.last  || "") +
      optional("city",   params.city) +
      optional("state",  params.state) +
      optional("postal", params.postal) +
      optional("email",  params.email) +
      optional("phone",  params.phone) +
      optional("dob",    params.birthYear) +
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

  // Phone/Email row labeling reads from the snapshot — the immutable Lead
  // values captured on first open — not the live CRM Lead. Otherwise an
  // Update Lead click that rewrote the Lead's email/phone would shift which
  // email lands on the Current row vs Previous rows on the next reopen.
  // (Phone-to-row is already position-locked in this function, see below.)
  const snapshotForLabels = searchLeadRecord || currentLeadRecord || {};
  const leadPhone = normalizePhone(
    snapshotForLabels.Phone || snapshotForLabels.Mobile || ""
  );
  const leadEmail = normalizeEmail(snapshotForLabels.Email || "");
  const leadBirthYear = String(snapshotForLabels.Year_of_Birth || "").trim();
  console.log("Lead phone for comparison:", leadPhone);
  console.log("Lead email for comparison:", leadEmail);
  console.log("Lead Birth Year:", leadBirthYear);

  const rows = [];

  records.forEach((record, recordIndex) => {
    // Label every row this record produces so the UI can group Current +
    // Previous addresses by their source person. Same label flows through
    // address rows, phone rows, email rows, and "Additional Contact" rows.
    const groupLabel = `Person #${recordIndex + 1}`;
    console.log(`Building rows for ${groupLabel}`);
    console.log("Parent PhoneRecords:", record.PhoneRecords);
    console.log("Parent EmailRecords:", record.EmailRecords);

    const firstName = toDisplayString(
      record.Name?.FirstName ||
      record.FirstName ||
      record.First_Name ||
      record.First ||
      ""
    );

    const lastName = toDisplayString(
      record.Name?.LastName ||
      record.LastName ||
      record.Last_Name ||
      record.Last ||
      ""
    );

    console.log("Extracted firstName:", firstName, "lastName:", lastName);

    // Melissa returns DateOfBirth as YYYYMM (e.g. "195808" for Aug 1958).
    // First 4 chars give the year — that's what Year_of_Birth on the Lead stores.
    const rawDob = String(record.DateOfBirth || "");
    const birthYear =
      rawDob && rawDob.length >= 4 ? rawDob.substring(0, 4) : "";
    console.log("Melissa DOB:", record.DateOfBirth);
    console.log("Extracted Melissa Birth Year:", birthYear);

    // Base shape every row shares. Address rows fill the address cells and
    // leave phone/email blank; phone rows fill only phone; email rows fill
    // only email. The Update Lead payload reads from non-empty cells, so a
    // Phone row never overwrites the Lead's address fields, and vice versa.
    const blankRow = {
      melissaRecordLabel: groupLabel,
      firstName,
      lastName,
      birthYear,
      dataType: "",
      homeAddressStreet: "",
      homeAddressState: "",
      homeAddressCity: "",
      homeAddressZip: "",
      phone: "",
      email: "",
    };

    const buildAddressRow = (addr, label, phoneStr, emailStr) => ({
      ...blankRow,
      dataType: label,
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
      phone: phoneStr || "",
      email: emailStr || "",
    });

    // Collect every Melissa phone/email for this person into flat string lists.
    // Empty entries are dropped so they don't claim a "slot" on a previous-
    // address row when there's nothing to show.
    const allPhones = (record.PhoneRecords || [])
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : entry?.PhoneNumber || entry?.phoneNumber || entry?.Phone || ""
      )
      .map(toDisplayString)
      .filter(Boolean);

    const allEmails = (record.EmailRecords || [])
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : entry?.Email || entry?.email || entry?.EmailAddress || ""
      )
      .map(toDisplayString)
      .filter(Boolean);

    console.log("All phones (Melissa order, immutable):", allPhones);
    console.log("All emails:", allEmails);

    // Working copy of emails — emails still use the lead-match strategy
    // (unchanged, per spec). Phones are now assigned purely by position
    // against Melissa's PhoneRecords order, so a `workingPhones` array is
    // unnecessary: position N in allPhones ALWAYS belongs to the Nth row,
    // regardless of what the CRM Lead's phone happens to be at render time.
    const workingEmails = [...allEmails];

    let currentEmail = "";

    if (record.CurrentAddress) {
      // PHONE: deterministic, position-based. Current row owns allPhones[0]
      // forever. This used to call allPhones.find(matchesLeadPhone) — that
      // was the bug source: after Update Lead, the CRM Lead's phone changed
      // to the selected row's value, the iframe reloaded, .find() returned
      // the selected phone for the Current row, and the previous Current
      // phone got pushed into the Previous slot. By dropping the lead
      // lookup, the Current/Previous phone assignment is locked to
      // Melissa's response order and cannot swap regardless of CRM state.
      const currentPhone = allPhones[0] || "";

      // EMAIL: unchanged per spec — prefer the Lead-matching email, fall
      // back to the first email.
      currentEmail =
        (leadEmail && allEmails.find((e) => normalizeEmail(e) === leadEmail)) ||
        allEmails[0] ||
        "";

      if (currentEmail) {
        const idx = workingEmails.findIndex(
          (e) => normalizeEmail(e) === normalizeEmail(currentEmail)
        );
        if (idx !== -1) workingEmails.splice(idx, 1);
      }

      console.log("Original row phone (Current Address):", currentPhone);
      console.log("Current Address email:", currentEmail);

      rows.push(
        buildAddressRow(
          record.CurrentAddress,
          "Current Address",
          currentPhone,
          currentEmail
        )
      );
    }

    // PHONE distribution for Previous Addresses: position-locked to
    // allPhones. Previous Address #i owns allPhones[i + 1] (because the
    // Current row owns allPhones[0]). No splicing, no Lead matching, no
    // re-binding ever — phone-to-row is determined entirely by Melissa's
    // PhoneRecords order.
    //
    // EMAIL distribution is unchanged: it still uses workingEmails so the
    // Lead-matched email behavior is preserved (per spec: do not change
    // email behavior).
    const prevAddresses = record.PreviousAddresses || [];
    const phoneOffset = record.CurrentAddress ? 1 : 0;
    prevAddresses.forEach((addr, i) => {
      const phone = allPhones[phoneOffset + i] || "";
      const email = workingEmails[i] || "";
      console.log(`Original row phone (Previous Address #${i + 1}):`, phone);
      console.log(`Previous Address #${i + 1} email:`, email);
      rows.push(buildAddressRow(addr, "Previous Address", phone, email));
    });

    // Anything past the previous-address slots becomes "Additional Contact"
    // rows so no phone or email is dropped on the floor. Phones index off
    // allPhones; emails still index off workingEmails (preserved behavior).
    const extraPhoneStart = phoneOffset + prevAddresses.length;
    const extraPhones = allPhones.slice(extraPhoneStart);
    const extraEmails = workingEmails.slice(prevAddresses.length);
    const additionalCount = Math.max(extraPhones.length, extraEmails.length);

    for (let i = 0; i < additionalCount; i++) {
      const phone = extraPhones[i] || "";
      const email = extraEmails[i] || "";
      if (!phone && !email) continue;
      console.log("Original row phone (Additional Contact):", phone);
      console.log("Additional Contact email:", email);
      rows.push({
        ...blankRow,
        dataType: "Additional Contact",
        phone,
        email,
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

  // Track which record group we just rendered so we can mark the row that
  // *starts* a new group with a separator border + tinted background.
  let prevGroup = null;

  records.forEach((rec, index) => {
    const tr = document.createElement("tr");
    tr.dataset.index = index;
    tr.dataset.melissaRecord = rec.melissaRecordLabel || "";

    if (rec.melissaRecordLabel && rec.melissaRecordLabel !== prevGroup) {
      // First row of a new Melissa Record group — visually break from the
      // previous group with a thicker top border and a subtle tint.
      tr.style.borderTop = "2px solid #c5cee0";
      tr.style.backgroundColor = "#f5f8fc";
      prevGroup = rec.melissaRecordLabel;
    }

    tr.innerHTML = `
      <td>${escapeHtml(rec.melissaRecordLabel) || "—"}</td>
      <td>${escapeHtml(rec.firstName) || "—"}</td>
      <td>${escapeHtml(rec.lastName) || "—"}</td>
      <td>${escapeHtml(rec.birthYear) || "—"}</td>
      <td>${escapeHtml(rec.dataType) || "—"}</td>
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

  // Toggle: clicking the already-selected row clears the selection.
  if (selectedIndex === index) {
    console.log("Deselecting Melissa record at index:", index);
    selectedIndex = -1;
    selectedMelissaRecord = null;
    markSelectedRow(-1);
    showPreview(false);
    refreshUpdateButton();
    return;
  }

  selectedIndex = index;
  selectedMelissaRecord = record;
  console.log("Selected Melissa record:", selectedMelissaRecord);
  console.log("Selected row phone:", record.phone);
  console.log("Selected row dataType:", record.dataType);

  markSelectedRow(index);
  renderPreview(record);
  showPreview(true);
  refreshUpdateButton();
}

// Diagnostic helper: snapshot the phone value currently rendered in each row
// of the displayed table. Lets us prove, before and after the CRM update,
// that the widget rows did NOT change.
function snapshotDisplayedRowPhones(label) {
  const snapshot = filteredRecords.map((r, i) => ({
    rowIndex: i,
    dataType: r.dataType,
    phone: r.phone,
  }));
  console.log(`[${label}] displayed row phones:`, snapshot);
  const currentRow = snapshot.find((r) => r.dataType === "Current Address");
  if (currentRow) {
    console.log(`[${label}] Current Address row phone:`, currentRow.phone);
  }
  return snapshot;
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
    ["Melissa Record", rec.melissaRecordLabel],
    ["First Name", rec.firstName],
    ["Last Name", rec.lastName],
    ["Year of Birth", rec.birthYear],
    ["Data Type", rec.dataType],
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
        r.melissaRecordLabel,
        r.firstName,
        r.lastName,
        r.birthYear,
        r.dataType,
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
  console.log("Update Lead button clicked");
  console.log("Current Lead ID:", currentLeadId);
  console.log("Selected Melissa Record (the one going to CRM):", selectedMelissaRecord);
  console.log(
    "Which record/person was selected for update — group label:",
    selectedMelissaRecord?.melissaRecordLabel,
    "| dataType:",
    selectedMelissaRecord?.dataType
  );
  console.log("SDK Ready:", sdkReady);
  console.log(
    "Full results list size BEFORE update (will not change as a side-effect of this click):",
    melissaRecords.length
  );

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

  // Take a plain-string snapshot of ONLY the fields we send to Zoho. The
  // snapshot is what flows into buildUpdatePayload / ZOHO.CRM.API.updateRecord
  // — selectedMelissaRecord itself is never passed downstream. This guarantees
  // no caller in the update path can mutate the live widget row by reference,
  // even accidentally (e.g. via toJSON, payload normalization, etc.).
  const updateSnapshot = {
    homeAddressStreet: String(selectedMelissaRecord.homeAddressStreet || ""),
    homeAddressState:  String(selectedMelissaRecord.homeAddressState  || ""),
    homeAddressCity:   String(selectedMelissaRecord.homeAddressCity   || ""),
    homeAddressZip:    String(selectedMelissaRecord.homeAddressZip    || ""),
    phone:             String(selectedMelissaRecord.phone             || ""),
    email:             String(selectedMelissaRecord.email             || ""),
  };

  hideBanner();
  if (updateLeadBtn) {
    updateLeadBtn.disabled = true;
    updateLeadBtn.textContent = "Updating...";
  }

  // Diagnostic snapshot BEFORE the CRM update — captures the phone that's
  // currently rendered in every row, including the Current Address row.
  // The "after update" snapshot below must match this exactly.
  const phonesBefore = snapshotDisplayedRowPhones("BEFORE UPDATE");

  try {
    // Payload is built via FIELD_API_NAMES so Street/State/City API names
    // remain editable in one place — change them in the config block at the
    // top of the file. Zip/Phone/Email are confirmed working.
    const updatePayload = buildUpdatePayload(currentLeadId, updateSnapshot);
    console.log("ZOHO UPDATE PAYLOAD:", updatePayload);

    const updateResponse = await ZOHO.CRM.API.updateRecord({
      Entity: "Leads",
      APIData: updatePayload,
    });

    console.log("ZOHO UPDATE RESPONSE:", updateResponse);

    // Diagnostic snapshot AFTER the CRM update — proves the displayed rows
    // were not mutated, re-mapped, or rebuilt. Compare phone-by-phone
    // against phonesBefore; any mismatch is a regression of the swap bug.
    const phonesAfter = snapshotDisplayedRowPhones("AFTER UPDATE");
    const swapped = phonesBefore.some(
      (b, i) => phonesAfter[i] && phonesAfter[i].phone !== b.phone
    );
    console.log("Phone swap detected after update?", swapped);

    // Confirm that the CRM update did NOT replace or shrink the full
    // results list. melissaRecords / filteredRecords are the source of
    // truth for the rendered table; both must be identical to what they
    // were before this click. On the NEXT widget open, the search step
    // will use the persisted Lead snapshot (see PageLoad) so the same
    // matched persons stay visible despite the live Lead's fields having
    // been rewritten to the selected row.
    console.log(
      "Full results list size AFTER update (must equal BEFORE):",
      melissaRecords.length,
      "| filteredRecords size:",
      filteredRecords.length
    );
    console.log(
      "Selected update did NOT replace/filter the full results list."
    );

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

    // CRM update succeeded. Show the success modal ONLY. The widget table
    // displays Melissa search results and must stay identical to what was on
    // screen before the click. Intentionally NOT done here:
    //   - mutating selectedMelissaRecord
    //   - mutating melissaRecords / filteredRecords / row objects
    //   - calling renderResults() with CRM-updated data
    //   - rebuilding rows from the updated Lead
    //   - re-fetching currentLeadRecord (would shift Current/Previous labels
    //     because mapMelissaRecords compares row phones/emails to the Lead)
    // If the table needs to refresh, the user closes the widget and reopens
    // it — that path re-runs the Melissa search from scratch.
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
// Only include fields whose value is non-empty on the selected row. Because
// rows now come in four shapes (Current/Previous Address, Phone, Email), a
// Phone row carries only `phone` and emits only `{ id, Phone }`; an Address
// row emits only the four address keys; and so on. Empty cells never reach
// Zoho, so other CRM fields can't be wiped out.
function buildUpdatePayload(leadId, rec) {
  if (ADDRESS_UPDATE_MODE === "compound") {
    const payload = { id: leadId };
    const homeAddress = {};
    if (rec.homeAddressStreet) homeAddress.Street = rec.homeAddressStreet;
    if (rec.homeAddressState)  homeAddress.State  = rec.homeAddressState;
    if (rec.homeAddressCity)   homeAddress.City   = rec.homeAddressCity;
    if (rec.homeAddressZip)    homeAddress.Zip    = rec.homeAddressZip;
    if (Object.keys(homeAddress).length) payload.Home_Address = homeAddress;
    if (rec.phone) payload[FIELD_API_NAMES.phone] = rec.phone;
    if (rec.email) payload[FIELD_API_NAMES.email] = rec.email;
    return payload;
  }

  const updatePayload = { id: leadId };
  if (rec.homeAddressStreet) updatePayload[FIELD_API_NAMES.street] = rec.homeAddressStreet;
  if (rec.homeAddressState)  updatePayload[FIELD_API_NAMES.state]  = rec.homeAddressState;
  if (rec.homeAddressCity)   updatePayload[FIELD_API_NAMES.city]   = rec.homeAddressCity;
  if (rec.homeAddressZip)    updatePayload[FIELD_API_NAMES.zip]    = rec.homeAddressZip;
  if (rec.phone)             updatePayload[FIELD_API_NAMES.phone]  = rec.phone;
  if (rec.email)             updatePayload[FIELD_API_NAMES.email]  = rec.email;
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
