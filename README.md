# Chrome to Notion

A Chrome extension to save the current tab into a Notion database.

## Features

- Save any page (title + URL) to Notion with one click
- YouTube titles are auto-prefixed with `[YTB]`
- Bookmark a YouTube timestamp as a linked bullet in Notion
- Pin favorite databases to the popup dropdown

## Setup

**1. Create a Notion integration**
Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) → New integration → copy the secret token.

**2. Prepare your database**
Make sure your Notion database has a `Name` (Title) and `URL` (URL) property.

**3. Share the database**
Open the database → ... → Connections → connect your integration.

**4. Load the extension**
Go to `chrome://extensions` → enable Developer mode → Load unpacked → select this folder.

**5. Configure**
Click the extension icon → Options → paste your token → Load databases → pick favorites → Save.

## Usage

- **Save page** — click the icon, select a database, click Save.
- **Add timestamp** (YouTube only) — play to the moment you want, click the icon, click Add timestamp.

## Options

| Setting | Default |
|---|---|
| Title property name | `Name` |
| URL property name | `URL` |
| Auto-open after save | Off |

## License

MIT