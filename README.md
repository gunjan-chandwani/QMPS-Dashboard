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


## Persistent storage (fixed deployment)

This version stores question-paper metadata in PostgreSQL and uploaded files in the
Render persistent disk mounted at `/opt/render/project/src/uploads`.

### Render deployment

1. Push this folder to GitHub.
2. In Render, create a Web Service from the repository.
3. Use:
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Create a PostgreSQL database named `qpms-db`.
5. Set `DATABASE_URL` on the web service to the database's internal connection string.
6. Add a Render persistent disk mounted at `/opt/render/project/src/uploads`.
7. Redeploy.

The API endpoints are:
- `GET /api/papers`
- `POST /api/papers`
- `PATCH /api/papers/:id`
- `DELETE /api/papers/:id`
- `GET /api/papers/:id/file`
- `GET /health`
