function setStatus(el, msg, { isError = false } = {}) {
  el.textContent = msg || "";
  el.classList.toggle("error", Boolean(isError));
}

async function getFavoriteDbIds() {
  const { favoriteDatabaseIds } = await chrome.storage.sync.get(["favoriteDatabaseIds"]);
  const ids = Array.isArray(favoriteDatabaseIds) ? favoriteDatabaseIds : [];
  return ids.map((x) => String(x)).filter(Boolean);
}

async function setFavoriteDbIds(ids) {
  const deduped = Array.from(new Set((ids || []).map((x) => String(x)).filter(Boolean)));
  await chrome.storage.sync.set({ favoriteDatabaseIds: deduped });
}

function renderDbCheckboxes(databases, favoriteIds) {
  const container = document.getElementById("dbCheckboxList");
  const favSet = new Set(favoriteIds);

  if (!databases.length) {
    container.innerHTML = `<div class="hint">No databases found. Make sure your integration token is correct and databases are shared with the integration.</div>`;
    return;
  }

  container.innerHTML = "";
  for (const db of databases) {
    const label = document.createElement("label");
    label.className = "db-checkbox-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = db.id;
    checkbox.checked = favSet.has(db.id);
    checkbox.id = `db-${db.id}`;

    checkbox.addEventListener("change", async () => {
      const currentFavs = await getFavoriteDbIds();
      const set = new Set(currentFavs);
      if (checkbox.checked) set.add(db.id);
      else set.delete(db.id);
      await setFavoriteDbIds(Array.from(set));
    });

    const span = document.createElement("span");
    span.textContent = db.title;

    label.appendChild(checkbox);
    label.appendChild(span);
    container.appendChild(label);
  }
}

async function loadDatabases({ force = false } = {}) {
  const loadDbsBtn = document.getElementById("loadDbsBtn");
  const dbLoadStatus = document.getElementById("dbLoadStatus");

  loadDbsBtn.disabled = true;
  dbLoadStatus.textContent = "Loading databases…";

  const res = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "NOTION_LIST_DATABASES", force }, (r) => resolve(r));
  });

  loadDbsBtn.disabled = false;

  if (!res?.ok) {
    dbLoadStatus.textContent = res?.error || "Failed to load databases.";
    return;
  }

  const favoriteIds = await getFavoriteDbIds();
  renderDbCheckboxes(res.databases || [], favoriteIds);
  dbLoadStatus.textContent = res.cached ? `${res.databases?.length ?? 0} databases loaded (cached).` : `${res.databases?.length ?? 0} databases loaded.`;
}

async function load() {
  const status = document.getElementById("status");
  const notionApiKey = document.getElementById("notionApiKey");
  const titlePropertyName = document.getElementById("titlePropertyName");
  const urlPropertyName = document.getElementById("urlPropertyName");
  const autoOpenAfterSave = document.getElementById("autoOpenAfterSave");

  const data = await chrome.storage.sync.get([
    "notionApiKey",
    "titlePropertyName",
    "urlPropertyName",
    "autoOpenAfterSave",
  ]);

  notionApiKey.value = data.notionApiKey || "";
  titlePropertyName.value = data.titlePropertyName || "Name";
  urlPropertyName.value = data.urlPropertyName || "URL";
  autoOpenAfterSave.value = data.autoOpenAfterSave || "none";

  setStatus(status, "");

  // Auto-load databases from cache if available
  await loadDatabases({ force: false });
}

async function save() {
  const status = document.getElementById("status");
  const saveBtn = document.getElementById("saveBtn");
  const notionApiKey = document.getElementById("notionApiKey");
  const titlePropertyName = document.getElementById("titlePropertyName");
  const urlPropertyName = document.getElementById("urlPropertyName");
  const autoOpenAfterSave = document.getElementById("autoOpenAfterSave");

  saveBtn.disabled = true;
  setStatus(status, "Saving…");

  await chrome.storage.sync.set({
    notionApiKey: (notionApiKey.value || "").trim(),
    titlePropertyName: (titlePropertyName.value || "Name").trim(),
    urlPropertyName: (urlPropertyName.value || "URL").trim(),
    autoOpenAfterSave: (autoOpenAfterSave.value || "none").trim(),
  });

  setStatus(status, "Saved.");
  saveBtn.disabled = false;
}

async function testConnection() {
  const status = document.getElementById("status");
  const testBtn = document.getElementById("testBtn");
  testBtn.disabled = true;
  setStatus(status, "Testing connection…");

  const res = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "NOTION_LIST_DATABASES", force: true }, (r) => resolve(r));
  });

  if (res?.ok) {
    setStatus(status, `OK. Found ${res.databases?.length ?? 0} database(s).`);
    // Also refresh the checkbox list
    const favoriteIds = await getFavoriteDbIds();
    renderDbCheckboxes(res.databases || [], favoriteIds);
    document.getElementById("dbLoadStatus").textContent = `${res.databases?.length ?? 0} databases loaded.`;
  } else {
    setStatus(status, res?.error || "Failed to reach Notion API.", { isError: true });
  }

  testBtn.disabled = false;
}

document.getElementById("saveBtn").addEventListener("click", () => {
  save().catch((err) => {
    const status = document.getElementById("status");
    setStatus(status, err?.message || String(err), { isError: true });
    document.getElementById("saveBtn").disabled = false;
  });
});

document.getElementById("testBtn").addEventListener("click", () => {
  testConnection().catch((err) => {
    const status = document.getElementById("status");
    setStatus(status, err?.message || String(err), { isError: true });
    document.getElementById("testBtn").disabled = false;
  });
});

document.getElementById("loadDbsBtn").addEventListener("click", () => {
  loadDatabases({ force: true }).catch((err) => {
    document.getElementById("dbLoadStatus").textContent = err?.message || String(err);
  });
});

load().catch((err) => {
  const status = document.getElementById("status");
  setStatus(status, err?.message || String(err), { isError: true });
});