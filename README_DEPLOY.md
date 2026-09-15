# SongFinder Pro — FINAL

## Frontend
Deploy `index.html` to GitHub Pages.

Before production, replace the placeholder `YOUR-REAL-RAILWAY-URL` in `index.html` with the actual Railway backend URL.

## Backend
Deploy this folder to Railway. Required files:
- server.js
- package.json
- Dockerfile

Required Railway variables:
- `AUDD_API_TOKENS` = token1,token2,token3
- `FRONTEND_ORIGIN` = `https://irmangamerz-png.github.io`

After deploy, test:
`https://YOUR-RAILWAY-DOMAIN/health`

Expected JSON includes `"success": true`.

Never put AudD tokens into `index.html` or GitHub Pages.
