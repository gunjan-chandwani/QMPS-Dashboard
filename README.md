# QMPS Dashboard – Persistent File Upload Fix

This build fixes the deployment file-storage problem in the QMPS Dashboard.

## What is fixed

- Question-paper uploads are sent to the Express API instead of being kept only in browser JavaScript state.
- File bytes are stored in PostgreSQL (`BYTEA`), so the app does not depend on Render's ephemeral filesystem.
- Uploaded paper metadata and version history are stored in PostgreSQL.
- **View** opens the stored file in a new browser tab.
- **Download** downloads the stored file.
- Refreshing the page reloads saved papers from PostgreSQL.
- Revisions are persisted and version history is retained.
- The frontend now uses the persistent API records instead of only demo/browser state.

## Run locally

```powershell
npm install
npm start
```

Open `http://localhost:3000`.

For persistent data locally, set `DATABASE_URL` to a PostgreSQL database connection string.

## Render deployment

This version does **not** require a Render persistent disk for uploads.

1. Push the project files to GitHub.
2. In Render, connect the repository as a Web Service.
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Create/connect a Render PostgreSQL database.
6. Set `DATABASE_URL` on the web service to the database's connection string.
7. Deploy.

The included `render.yaml` creates the web service and a PostgreSQL database.

### Important Render note

Render's normal service filesystem is ephemeral. This build deliberately stores uploaded files in PostgreSQL instead, so the files do not disappear just because the service restarts or redeploys.

A Render Free PostgreSQL database is intended for temporary/free use and currently expires after 30 days. For an institutional production deployment where files must remain available long-term, use a paid PostgreSQL database and/or object storage such as S3-compatible storage.

## API

- `GET /health`
- `GET /api/papers`
- `POST /api/papers`
- `POST /api/papers/:id/revision`
- `PATCH /api/papers/:id`
- `DELETE /api/papers/:id`
- `GET /api/papers/:id/file` — view
- `GET /api/papers/:id/download` — download

## Demo login

- Faculty: `faculty@mru.edu.in` / `demo123`
- COE: `coe@mru.edu.in` / `demo123`
- Moderator: `moderator@mru.edu.in` / `demo123`
