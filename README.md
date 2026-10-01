# QPMS – Manav Rachna University

This package is deployment-ready for a Node/Express host such as Render. The original supplied QPMS interface is retained as `index.html` so the existing CSS, layout and demo workflow remain unchanged.

## Run locally

```powershell
npm install
npm start
```

Open: http://localhost:3000

Health check: http://localhost:3000/health

## Demo login

- Faculty: faculty@mru.edu.in / demo123
- COE: coe@mru.edu.in / demo123
- Moderator: moderator@mru.edu.in / demo123

## Deploy to Render

1. Create a GitHub repository.
2. Upload all files in this folder to the repository root.
3. In Render, create a **New Web Service** and connect the GitHub repository.
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Deploy.
7. Render will provide a URL similar to `https://qpms-mru.onrender.com`.

The included `render.yaml` can also be used with Render Blueprint deployment.

## Important storage note

The supplied UI currently stores its demo workflow data in browser-side JavaScript state. Therefore this package is suitable for demonstrating the complete UI/workflow publicly, but it is **not yet a multi-user production database**. For institutional production use, the next step is to connect paper uploads, users, versions, moderation decisions and audit logs to persistent server-side storage (for example PostgreSQL plus object storage for PDFs).
