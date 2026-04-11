# Dual Performance — Athlete Portal

## Setup

### 1. Add Notion token to Vercel
In your Vercel project → Settings → Environment Variables → Add:
- Name: `NOTION_TOKEN`
- Value: `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`

### 2. Deploy
Push this folder to GitHub → Import in Vercel → Deploy

### 3. Share athlete links
`https://yoursite.vercel.app?code=KHANG1`

## Structure
```
api/
  notion.js    ← Serverless function (proxies Notion API securely)
public/
  index.html   ← Athlete portal app
vercel.json    ← Vercel config
```

## Notion Databases Connected
- Athlete Database: 4a25a96cc70b82ffa6790139eaa8b458
- Training Calendar: 0b85a96cc70b836898fd013e0e15c4f2
- Performance Tracking: af15a96cc70b821f9f1a012240490fda
