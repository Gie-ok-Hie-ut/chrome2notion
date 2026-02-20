async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found.");
  return tab;
}

function setStatus(el, msg, { isError = false } = {}) {
  el.textContent = msg || "";
  el.classList.toggle("error", Boolean(isError));
}

async function openOptions() {
  if (chrome.runtime.openOptionsPage) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  window.open(chrome.runtime.getURL("options.html"));
}

async function getStoredSelectedDbId() {
  const { selectedDatabaseId } = await chrome.storage.sync.get(["selectedDatabaseId"]);
  return (selectedDatabaseId || "").trim();
}

async function setStoredSelectedDbId(databaseId) {
  await chrome.storage.sync.set({ selectedDatabaseId: databaseId });
}

async function getFavoriteDbIds() {
  const { favoriteDatabaseIds } = await chrome.storage.sync.get(["favoriteDatabaseIds"]);
  const ids = Array.isArray(favoriteDatabaseIds) ? favoriteDatabaseIds : [];
  return ids.map((x) => String(x)).filter(Boolean);
}

async function fetchDatabases({ force = false } = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "NOTION_LIST_DATABASES", force }, (res) =>
      resolve(res)
    );
  });
}

async function savePage({ databaseId, title, url }) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "NOTION_SAVE_PAGE", databaseId, title, url },
      (res) => resolve(res)
    );
  });
}

async function openUrl(url) {
  const u = (url || "").trim();
  if (!u) return;
  await chrome.tabs.create({ url: u });
}

async function getBetterTitle(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_METADATA" });
    if (res?.ok && res?.title) return res.title;
  } catch {
    // content script may not run on restricted pages; ignore.
  }
  return "";
}

async function getYouTubeTimestamp(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "GET_YOUTUBE_TIMESTAMP" });
    if (res?.ok) return res;
  } catch {
    // ignore
  }
  return null;
}

async function addTimestamp({ databaseId, title, url, timestampSeconds, timestampFormatted, timestampUrl }) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: "NOTION_ADD_TIMESTAMP",
        databaseId,
        title,
        url,
        timestampSeconds,
        timestampFormatted,
        timestampUrl,
      },
      (res) => resolve(res)
    );
  });
}

function isYouTubeUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (
      u.hostname === "www.youtube.com" ||
      u.hostname === "m.youtube.com" ||
      u.hostname === "youtu.be"
    );
  } catch {
    return false;
  }
}

function fillDbSelect(selectEl, databases, selectedId, favoriteIds) {
  selectEl.innerHTML = "";

  const favSet = new Set((favoriteIds || []).map(String));
  const favorites = databases.filter((db) => favSet.has(db.id));
  const displayList = favorites.length ? favorites : databases;
  const usingFallback = !favorites.length && databases.length > 0;

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = displayList.length
    ? (usingFallback ? "Select a database… (set favorites in Options)" : "Select a database…")
    : "No favorites — set them in Options";
  selectEl.appendChild(placeholder);

  for (const db of displayList) {
    const opt = document.createElement("option");
    opt.value = db.id;
    opt.textContent = db.title;
    selectEl.appendChild(opt);
  }

  // Determine selection: prefer stored (if in list), else first favorite, else first db
  if (selectedId && displayList.some((d) => d.id === selectedId)) {
    selectEl.value = selectedId;
  } else if (favorites.length) {
    selectEl.value = favorites[0].id;
    setStoredSelectedDbId(favorites[0].id).catch(() => {});
  } else if (databases.length) {
    selectEl.value = databases[0].id;
    setStoredSelectedDbId(databases[0].id).catch(() => {});
  }
}

async function main() {
  const dbSelect = document.getElementById("dbSelect");
  const refreshDbs = document.getElementById("refreshDbs");
  const saveBtn = document.getElementById("saveBtn");
  const status = document.getElementById("status");
  const previewTitle = document.getElementById("previewTitle");
  const previewUrl = document.getElementById("previewUrl");
  const openOptionsLink = document.getElementById("openOptions");
  const actions = document.getElementById("actions");
  const openPageBtn = document.getElementById("openPageBtn");
  const openDbBtn = document.getElementById("openDbBtn");
  const addTimestampBtn = document.getElementById("addTimestampBtn");

  openOptionsLink.addEventListener("click", (e) => {
    e.preventDefault();
    openOptions().catch(() => {});
  });

  const tab = await getActiveTab();
  const url = tab.url || "";
  previewUrl.textContent = url;

  const better = await getBetterTitle(tab.id);
  const fallbackTitle = (tab.title || "").replace(/\s+-\s+YouTube\s*$/i, "").trim();
  const rawTitle = (better || fallbackTitle || "").trim() || "Untitled";
  const title = isYouTubeUrl(url) ? `[YTB] ${rawTitle}` : rawTitle;
  previewTitle.textContent = title;

  const isYouTube = isYouTubeUrl(url);
  addTimestampBtn.hidden = !isYouTube;

  let lastDatabases = [];
  let lastCreatedPageUrl = "";
  let lastDatabaseUrl = "";

  function setActionsVisible(visible) {
    actions.hidden = !visible;
  }

  function updateActionButtons() {
    openPageBtn.disabled = !lastCreatedPageUrl;
    openDbBtn.disabled = !lastDatabaseUrl;
  }

  openPageBtn.addEventListener("click", () => openUrl(lastCreatedPageUrl).catch(() => {}));
  openDbBtn.addEventListener("click", () => openUrl(lastDatabaseUrl).catch(() => {}));

  // Fast path: load from cache immediately (no spinner, instant UI)
  async function populateFromCache() {
    const res = await fetchDatabases({ force: false });
    if (!res?.ok || !res.databases?.length) return false;

    const [selected, favoriteIds] = await Promise.all([
      getStoredSelectedDbId(),
      getFavoriteDbIds(),
    ]);

    lastDatabases = res.databases;
    lastDatabaseUrl = lastDatabases.find((d) => d.id === dbSelect.value)?.url || "";
    fillDbSelect(dbSelect, lastDatabases, selected, favoriteIds);
    updateActionButtons();
    return res.cached;
  }

  // Then silently refresh in background if cache is stale
  async function refreshInBackground() {
    const res = await fetchDatabases({ force: true });
    if (!res?.ok) return;

    const [selected, favoriteIds] = await Promise.all([
      getStoredSelectedDbId(),
      getFavoriteDbIds(),
    ]);

    lastDatabases = res.databases || [];
    const currentVal = dbSelect.value;
    fillDbSelect(dbSelect, lastDatabases, currentVal || selected, favoriteIds);
    lastDatabaseUrl = lastDatabases.find((d) => d.id === dbSelect.value)?.url || "";
    updateActionButtons();
  }

  // Load databases: show instantly from cache, refresh silently in background
  setStatus(status, "");
  const wasCached = await populateFromCache();

  if (wasCached) {
    // Already had fresh cache — done instantly, no spinner needed
  } else {
    // No cache yet — show a brief loading indicator while we fetch
    if (!lastDatabases.length) {
      setStatus(status, "Loading databases…");
    }
    await refreshInBackground();
    setStatus(status, "");
  }

  // Silently keep cache warm (if it was cached, refresh quietly in background)
  if (wasCached) {
    refreshInBackground().catch(() => {});
  }

  refreshDbs.addEventListener("click", async () => {
    refreshDbs.disabled = true;
    setStatus(status, "Refreshing…");
    await refreshInBackground();
    refreshDbs.disabled = false;
    setStatus(status, "");
  });

  dbSelect.addEventListener("change", () => {
    const id = (dbSelect.value || "").trim();
    setStoredSelectedDbId(id).catch(() => {});
    lastDatabaseUrl = lastDatabases.find((d) => d.id === id)?.url || "";
    updateActionButtons();
  });

  saveBtn.addEventListener("click", async () => {
    const databaseId = (dbSelect.value || "").trim();
    if (!databaseId) {
      setStatus(status, "Pick a database first.", { isError: true });
      return;
    }

    saveBtn.disabled = true;
    refreshDbs.disabled = true;
    dbSelect.disabled = true;
    setStatus(status, "Saving to Notion…");
    setActionsVisible(false);

    const res = await savePage({ databaseId, title, url });

    if (res?.ok) {
      setStatus(status, "Saved.");
      lastCreatedPageUrl = res.url || "";
      lastDatabaseUrl =
        res.databaseUrl || lastDatabases.find((d) => d.id === databaseId)?.url || "";
      updateActionButtons();
      setActionsVisible(Boolean(lastCreatedPageUrl || lastDatabaseUrl));

      if (res.autoOpenAfterSave === "page") {
        openUrl(lastCreatedPageUrl).catch(() => {});
      } else if (res.autoOpenAfterSave === "database") {
        openUrl(lastDatabaseUrl).catch(() => {});
      }
    } else {
      setStatus(status, res?.error || "Failed to save.", { isError: true });
    }

    saveBtn.disabled = false;
    refreshDbs.disabled = false;
    dbSelect.disabled = false;
  });

  addTimestampBtn.addEventListener("click", async () => {
    const databaseId = (dbSelect.value || "").trim();
    if (!databaseId) {
      setStatus(status, "Pick a database first.", { isError: true });
      return;
    }

    addTimestampBtn.disabled = true;
    saveBtn.disabled = true;
    refreshDbs.disabled = true;
    dbSelect.disabled = true;
    setStatus(status, "Capturing timestamp…");

    const timestampData = await getYouTubeTimestamp(tab.id);
    if (!timestampData || !timestampData.ok) {
      setStatus(
        status,
        timestampData?.error || "Could not get timestamp. Make sure you're on a YouTube video page and the video has loaded.",
        { isError: true }
      );
      addTimestampBtn.disabled = false;
      saveBtn.disabled = false;
      refreshDbs.disabled = false;
      dbSelect.disabled = false;
      return;
    }

    if (typeof timestampData.seconds !== "number" || !timestampData.formatted || !timestampData.url) {
      setStatus(status, "Invalid timestamp data. Please try again.", { isError: true });
      addTimestampBtn.disabled = false;
      saveBtn.disabled = false;
      refreshDbs.disabled = false;
      dbSelect.disabled = false;
      return;
    }

    setStatus(status, "Adding timestamp to Notion…");

    const res = await addTimestamp({
      databaseId,
      title,
      url,
      timestampSeconds: timestampData.seconds,
      timestampFormatted: timestampData.formatted,
      timestampUrl: timestampData.url,
    });

    if (res?.ok) {
      setStatus(status, `Added timestamp ${timestampData.formatted}.`);
      lastCreatedPageUrl = res.url || lastCreatedPageUrl;
      lastDatabaseUrl =
        res.databaseUrl || lastDatabases.find((d) => d.id === databaseId)?.url || "";
      updateActionButtons();
      setActionsVisible(Boolean(lastCreatedPageUrl || lastDatabaseUrl));

      if (res.autoOpenAfterSave === "page") {
        openUrl(lastCreatedPageUrl).catch(() => {});
      } else if (res.autoOpenAfterSave === "database") {
        openUrl(lastDatabaseUrl).catch(() => {});
      }
    } else {
      setStatus(status, res?.error || "Failed to add timestamp.", { isError: true });
    }

    addTimestampBtn.disabled = false;
    saveBtn.disabled = false;
    refreshDbs.disabled = false;
    dbSelect.disabled = false;
  });
}

main().catch((err) => {
  const status = document.getElementById("status");
  if (status) setStatus(status, err?.message || String(err), { isError: true });
});