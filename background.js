const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const DB_CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

function okJson(res) {
  if (!res.ok) {
    return res
      .text()
      .catch(() => "")
      .then((t) => {
        throw new Error(
          `Notion API error ${res.status}: ${t || res.statusText || "Unknown"}`
        );
      });
  }
  return res.json();
}

async function getDbCache() {
  const { notionDbCache } = await chrome.storage.local.get(["notionDbCache"]);
  if (!notionDbCache || typeof notionDbCache !== "object") return null;
  return notionDbCache;
}

async function setDbCache({ notionApiKey, databases }) {
  await chrome.storage.local.set({
    notionDbCache: {
      apiKeyFingerprint: (notionApiKey || "").slice(-8),
      fetchedAt: Date.now(),
      databases,
    },
  });
}

async function getSettings() {
  const {
    notionApiKey,
    selectedDatabaseId,
    titlePropertyName = "Name",
    urlPropertyName = "URL",
    autoOpenAfterSave = "none",
  } = await chrome.storage.sync.get([
    "notionApiKey",
    "selectedDatabaseId",
    "titlePropertyName",
    "urlPropertyName",
    "autoOpenAfterSave",
  ]);

  return {
    notionApiKey: (notionApiKey || "").trim(),
    selectedDatabaseId: (selectedDatabaseId || "").trim(),
    titlePropertyName,
    urlPropertyName,
    autoOpenAfterSave,
  };
}

async function notionFetch(path, { notionApiKey, method = "GET", body } = {}) {
  if (!notionApiKey) throw new Error("Missing Notion API key. Set it in Options.");

  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${notionApiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  return okJson(res);
}

async function listDatabases({ notionApiKey }) {
  // Notion doesn't provide "list all databases" directly; search with filter works well.
  const data = await notionFetch("/search", {
    notionApiKey,
    method: "POST",
    body: {
      filter: { property: "object", value: "database" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 100,
    },
  });

  return (data.results || []).map((db) => ({
    id: db.id,
    title:
      (db.title || [])
        .map((t) => t.plain_text)
        .join("")
        .trim() || "(Untitled database)",
    url: db.url,
  }));
}

function toNotionTitle(title) {
  const safe = (title || "").toString().trim();
  return safe
    ? [{ type: "text", text: { content: safe } }]
    : [{ type: "text", text: { content: "Untitled" } }];
}

async function getDatabase({ notionApiKey, databaseId }) {
  return notionFetch(`/databases/${databaseId}`, { notionApiKey });
}

function findTitlePropertyName(db) {
  const props = db?.properties || {};
  for (const [name, def] of Object.entries(props)) {
    if (def?.type === "title") return name;
  }
  return null;
}

function paragraph(text) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: text } }],
    },
  };
}

function bulletItem(text, url) {
  const richText = url
    ? [
        {
          type: "text",
          text: { content: text },
          annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
          plain_text: text,
          href: url,
        },
      ]
    : [{ type: "text", text: { content: text } }];

  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: richText,
    },
  };
}

async function searchPageByTitle({ notionApiKey, databaseId, title }) {
  const titlePropName = await (async () => {
    const db = await getDatabase({ notionApiKey, databaseId });
    return findTitlePropertyName(db);
  })();

  if (!titlePropName) return null;

  const results = await notionFetch("/databases/" + databaseId + "/query", {
    notionApiKey,
    method: "POST",
    body: {
      filter: {
        property: titlePropName,
        title: { equals: title },
      },
      page_size: 1,
    },
  });

  const pages = results?.results || [];
  return pages.length > 0 ? pages[0] : null;
}

async function appendTimestampToPage({ notionApiKey, pageId, timestampFormatted, timestampUrl }) {
  const block = bulletItem(`- ${timestampFormatted}`, timestampUrl);
  await notionFetch(`/blocks/${pageId}/children`, {
    notionApiKey,
    method: "POST",
    body: {
      children: [block],
    },
  });
}

async function createPageWithTimestamp({
  notionApiKey,
  databaseId,
  title,
  url,
  timestampFormatted,
  timestampUrl,
  propertyNames,
}) {
  const db = await getDatabase({ notionApiKey, databaseId });
  const dbProps = db?.properties || {};

  const fallbackTitleProp = findTitlePropertyName(db);
  const titlePropName = dbProps[propertyNames.title]?.type === "title"
    ? propertyNames.title
    : fallbackTitleProp;

  if (!titlePropName) {
    throw new Error(
      "This database has no Title property. Notion databases must have a Title column."
    );
  }

  const props = {};
  props[titlePropName] = { title: toNotionTitle(title) };

  const missingLines = [];

  if (dbProps[propertyNames.url]?.type === "url") {
    props[propertyNames.url] = { url };
  } else {
    missingLines.push(`URL: ${url}`);
  }

  const children = [
    bulletItem(`- ${timestampFormatted}`, timestampUrl),
    ...(missingLines.length
      ? [
          paragraph("Saved details (because matching database properties were missing):"),
          ...missingLines.map(paragraph),
        ]
      : []),
  ];

  const created = await notionFetch("/pages", {
    notionApiKey,
    method: "POST",
    body: {
      parent: { database_id: databaseId },
      properties: props,
      children,
    },
  });
  return { created, databaseUrl: db?.url };
}

async function createPageInDatabase({
  notionApiKey,
  databaseId,
  title,
  url,
  propertyNames,
}) {
  const db = await getDatabase({ notionApiKey, databaseId });
  const dbProps = db?.properties || {};
  console.log("[ChromeToNotion] DB properties:", Object.keys(dbProps));

  const fallbackTitleProp = findTitlePropertyName(db);
  const titlePropName = dbProps[propertyNames.title]?.type === "title"
    ? propertyNames.title
    : fallbackTitleProp;

  if (!titlePropName) {
    throw new Error(
      "This database has no Title property. Notion databases must have a Title column."
    );
  }

  const props = {};
  props[titlePropName] = { title: toNotionTitle(title) };

  const missingLines = [];

  if (dbProps[propertyNames.url]?.type === "url") {
    props[propertyNames.url] = { url };
  } else {
    missingLines.push(`URL: ${url}`);
  }

  const children = missingLines.length
    ? [
        paragraph("Saved details (because matching database properties were missing):"),
        ...missingLines.map(paragraph),
      ]
    : undefined;
  console.log("[ChromeToNotion] Creating page with properties:", Object.keys(props));

  const created = await notionFetch("/pages", {
    notionApiKey,
    method: "POST",
    body: {
      parent: { database_id: databaseId },
      properties: props,
      ...(children ? { children } : {}),
    },
  });
  return { created, databaseUrl: db?.url };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message?.type === "NOTION_LIST_DATABASES") {
        const { notionApiKey } = await getSettings();
        const force = Boolean(message?.force);

        if (!force) {
          const cache = await getDbCache();
          const fresh =
            cache &&
            typeof cache.fetchedAt === "number" &&
            Date.now() - cache.fetchedAt < DB_CACHE_TTL_MS &&
            cache.apiKeyFingerprint === (notionApiKey || "").slice(-8) &&
            Array.isArray(cache.databases);

          if (fresh) {
            sendResponse({ ok: true, databases: cache.databases, cached: true });
            return;
          }
        }

        const databases = await listDatabases({ notionApiKey });
        await setDbCache({ notionApiKey, databases });
        sendResponse({ ok: true, databases, cached: false });
        return;
      }

      if (message?.type === "NOTION_SAVE_PAGE") {
        const settings = await getSettings();
        const databaseId = (message.databaseId || settings.selectedDatabaseId || "").trim();
        if (!databaseId) throw new Error("No database selected. Choose one in the popup.");

        const title = message.title || "";
        const url = message.url || "";
        if (!url) throw new Error("Missing page URL.");

        const { created, databaseUrl } = await createPageInDatabase({
          notionApiKey: settings.notionApiKey,
          databaseId,
          title,
          url,
          propertyNames: {
            title: settings.titlePropertyName,
            url: settings.urlPropertyName,
          },
        });

        sendResponse({
          ok: true,
          pageId: created.id,
          url: created.url,
          databaseUrl: databaseUrl || null,
          autoOpenAfterSave: settings.autoOpenAfterSave || "none",
        });
        return;
      }

      if (message?.type === "NOTION_ADD_TIMESTAMP") {
        const settings = await getSettings();
        const databaseId = (message.databaseId || settings.selectedDatabaseId || "").trim();
        if (!databaseId) throw new Error("No database selected. Choose one in the popup.");

        const title = (message.title || "").trim();
        const timestampFormatted = message.timestampFormatted || "";
        const timestampUrl = message.timestampUrl || "";

        if (!title) throw new Error("Missing page title.");
        if (!timestampFormatted) throw new Error("Missing timestamp.");

        const existingPage = await searchPageByTitle({
          notionApiKey: settings.notionApiKey,
          databaseId,
          title,
        });

        let pageUrl;
        let databaseUrl;

        if (existingPage) {
          await appendTimestampToPage({
            notionApiKey: settings.notionApiKey,
            pageId: existingPage.id,
            timestampFormatted,
            timestampUrl,
          });
          pageUrl = existingPage.url;
          const db = await getDatabase({ notionApiKey: settings.notionApiKey, databaseId });
          databaseUrl = db?.url;
        } else {
          const url = message.url || "";
          const { created, databaseUrl: dbUrl } = await createPageWithTimestamp({
            notionApiKey: settings.notionApiKey,
            databaseId,
            title,
            url,
            timestampFormatted,
            timestampUrl,
            propertyNames: {
              title: settings.titlePropertyName,
              url: settings.urlPropertyName,
            },
          });
          pageUrl = created.url;
          databaseUrl = dbUrl;
        }

        sendResponse({
          ok: true,
          url: pageUrl,
          databaseUrl: databaseUrl || null,
          autoOpenAfterSave: settings.autoOpenAfterSave || "none",
        });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type." });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;
});