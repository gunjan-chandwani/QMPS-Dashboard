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


## School-wise COE reporting (updated)

The COE dashboard includes a live school/department report, counts for uploaded, datesheet-pending, moderated and final-approved papers, direct View/Download links for moderated and final-approved files, and CSV export. Department grouping supports School of Engineering (CST, ME, ECE, Robotics & AI), School of Law, School of Sciences (Physics, Chemistry, Mathematics), School of Education and School of Business.

**Important:** report figures reflect records currently available in the configured database and the datesheet courses entered into the schedule. For reliable multi-user institutional use, keep `DATABASE_URL` configured and ensure the COE enters every course from the official datesheet. Uploaded paper records are persistent in PostgreSQL; the current datesheet course schedule is held in the browser session and should be moved to a database-backed datesheet import workflow before production-wide use.

## Update: live data, reports and moderator scope

- The fabricated demo paper records, demo datesheet rows and preset school/department report rows have been removed. The dashboard now shows papers returned by the configured PostgreSQL database; an empty report means the configured database has no paper rows available to this app.
- Use **Export Report CSV** on the report panel to download the current report. Moderator report/export and moderation lists are filtered to the moderator email's assigned school and, for CST/ECE/ME/IDE, that department.
- Moderator email scopes configured in the UI: `moderator_cst@mru.edu.in` (School of Engineering/CST), `moderator_ece@mru.edu.in` (School of Engineering/ECE), `moderator_me@mru.edu.in` (School of Engineering/ME), `moderator_ide@mru.edu.in` (School of Engineering/IDE), `moderator_sciences@mru.edu.in` (School of Sciences), `moderator_sob@mru.edu.in` (School of Business), `moderator_law@mru.edu.in` (School of Law), `moderator_soeh@mru.edu.in` (School of Education).

### Important production/security notes

This supplied app's login is still a **demo client-side role selector**, not password-backed authentication. The moderator scope is a UI filter only and is **not a secure authorization boundary** until login is replaced with server-side identity verification and every API read/write/file endpoint enforces the authenticated user's school/department scope. Do not deploy this as a secure production portal before that step.

The app does not delete database paper records during startup. If earlier uploads are missing, check that the deployment is connected to the same `DATABASE_URL`/PostgreSQL database that received the uploads. The earlier version also held sample papers and the datesheet in browser JavaScript, not PostgreSQL; those demo-only records cannot be recovered from the database. This package cannot restore records that were never persisted or that were deleted from the database. Files saved only on an ephemeral host filesystem may also be lost after redeploy; uploaded file bytes are stored in PostgreSQL by this version when uploads go through `/api/papers`.

The current database schema stores paper school/program/department as entered during upload. It does not magically discover MRU's authoritative programme catalogue or mid-term datesheet. For a complete dynamic pending-upload report, import the official mid-term datesheet into a database-backed schedule table/API; this ZIP removes fake schedule values rather than presenting them as real.


### COE Datesheet / Format visibility and file preview
- COE-published datesheets and paper formats are stored in PostgreSQL (`coe_notices`) with the original file bytes, rather than only in browser memory.
- The same live documents list is shown on Faculty, COE, and Moderator dashboards.
- View opens the stored original file in a new tab (`/api/notices/:id/view`); Download retrieves the original file.
- Existing paper records and the `papers` table are not reset or modified by this feature. The new table is created automatically when `DATABASE_URL` is configured.

## Backend COE Datesheet PDF Validation

The `/api/papers` and `/api/papers/:id/replace-file` endpoints validate submissions on the server before saving them. A submission must match the COE structured schedule (course code, department, programme when specified, semester, exam type and date) and the text extracted from a published COE Datesheet PDF. Datesheet PDFs are parsed at publication time and their extracted text is stored in PostgreSQL. Older published PDFs are parsed on demand when possible.

- Install dependencies with `npm install` (includes `pdf-parse`).
- Keep `DATABASE_URL` configured in Render.
- COE must publish the official datesheet as a text-searchable PDF under the **Examination Datesheet** category.
- Scanned/image-only PDFs must be OCR-processed and saved as searchable PDFs before upload.
- COE must also maintain the matching structured schedule row in the portal. A PDF upload alone does not create programme/semester schedule records.
- If the PDF or structured schedule does not verify the course/date, the backend returns HTTP 400 and rejects the paper upload/revision.

## October 2026 report update
- Moderator audit checklist responses and comments are now persisted in PostgreSQL (`papers.moderation_details` JSONB) along with the status/comments. The server creates this column safely for existing deployments.
- Moderator and COE workflow CSV exports include the moderator review date and feedback/changes-required comments.
- COE has a **Download All Records** CSV export containing all available paper records, status/count summary, moderator comments, and audit checklist answers.
- Existing paper records are not deleted or replaced by this migration. Older records without stored audit details will show existing `comments` where available.


## Latest update: Faculty moderator feedback + COE bulk paper download

- Faculty paper rows now show the saved moderator comments, review date, available audit checklist answers, and a clear resubmission reminder when changes are required.
- COE report tools include **Download All Papers (ZIP)**. It packages all question-paper files currently available in the database/storage into one ZIP; it does not include datesheets or replace the separate CSV workflow report.
- The ZIP endpoint is `GET /api/papers/download-all.zip`. The portal currently uses client-side role selection rather than server-side authentication, so deploy only in the existing trusted environment and add server-side authorization before exposing the service publicly.

## Reporting count and datesheet pending-count behaviour

- Dashboard/workflow status counts are normalized across common legacy labels (for example, `Approved by Moderator`, `APPROVED_BY_MODERATOR`, and `Final Approved & Archived`). A moderator report is intentionally limited to that moderator's assigned school/department, while the COE report can include all records; their totals will differ when the moderator is scoped to only part of the university.
- Scheduled-vs-uploaded comparisons use course code, mapped department, semester, exam type, and programme where both sides provide it. A paper marked `Changes Required` is still an uploaded paper; it should not be counted as a missing upload.
- The uploaded PDF is used for validating submissions, but PDF upload alone does not create structured course schedule rows. COE must add/import the datesheet courses into the COE Datesheet Schedule for the portal to calculate a numeric pending count. When no structured schedule rows exist, the dashboard now shows `—` and an explanatory message rather than incorrectly showing `0`.
