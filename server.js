const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

/*
 * IMPORTANT:
 * Uploaded files are stored as BYTEA in PostgreSQL.
 * This intentionally does NOT use the Render local filesystem, because
 * the normal Render filesystem is ephemeral. Therefore no persistent disk
 * is required for uploads.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB per question paper
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

function makePaperNo() {
  return `QP-${Math.floor(1000 + Math.random() * 9000)}`;
}

function normalizeStatus(status) {
  return status || "SUBMITTED_TO_COE";
}

function serializePaper(row) {
  if (!row) return null;

  let versions = [];
  try {
    versions = Array.isArray(row.versions) ? row.versions : JSON.parse(row.versions || "[]");
  } catch {
    versions = [];
  }

  if (!versions.length && row.original_filename) {
    versions = [{
      version: 1,
      filename: row.original_filename,
      uploadTime: row.submission_date || row.created_at,
      uploadedBy: row.faculty || "Faculty"
    }];
  }

  return {
    // Frontend-friendly fields
    id: row.paper_no || String(row.id),
    dbId: Number(row.id),
    courseName: row.title || row.subject || "Question Paper",
    courseCode: row.course || "",
    department: row.department || "",
    program: row.program || "",
    semester: row.semester || "",
    examType: row.exam || "",
    paperDate: row.submission_date ? new Date(row.submission_date).toISOString().slice(0, 10) : "",
    facultyName: row.faculty || "",
    currentVersion: versions.length || 1,
    status: normalizeStatus(row.status),
    versions,
    originalFilename: row.original_filename || null,
    fileMimetype: row.file_mimetype || null,
    fileSize: row.file_size ? Number(row.file_size) : null,
    fileUrl: `/api/papers/${row.id}/file`,
    downloadUrl: `/api/papers/${row.id}/download`,
    auditForm: null,
    auditTrail: [{
      action: "Paper record loaded",
      role: "System",
      user: row.faculty || "System",
      timestamp: row.updated_at || row.created_at,
      details: "Persistent record loaded from PostgreSQL"
    }]
  };
}

async function findPaper(id) {
  const value = String(id);
  const numeric = /^\d+$/.test(value);
  const query = numeric
    ? `SELECT * FROM papers WHERE id=$1::bigint OR paper_no=$1 LIMIT 1`
    : `SELECT * FROM papers WHERE paper_no=$1 LIMIT 1`;
  const { rows } = await pool.query(query, [value]);
  return rows[0] || null;
}

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL is not set. Persistent upload/database features will not work.");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS papers (
      id BIGSERIAL PRIMARY KEY,
      paper_no TEXT UNIQUE,
      title TEXT,
      school TEXT,
      program TEXT,
      department TEXT,
      semester TEXT,
      course TEXT,
      subject TEXT,
      faculty TEXT,
      exam TEXT,
      submission_date TIMESTAMPTZ DEFAULT NOW(),
      status TEXT DEFAULT 'Submitted to COE',
      expected BOOLEAN DEFAULT TRUE,
      original_filename TEXT,
      stored_filename TEXT,
      file_path TEXT,
      file_mimetype TEXT,
      file_size BIGINT,
      file_data BYTEA,
      versions JSONB DEFAULT '[]'::jsonb,
      comments TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Safe migrations for databases created by the earlier version.
  await pool.query(`ALTER TABLE papers ADD COLUMN IF NOT EXISTS file_data BYTEA`);
  await pool.query(`ALTER TABLE papers ADD COLUMN IF NOT EXISTS versions JSONB DEFAULT '[]'::jsonb`);
  await pool.query(`ALTER TABLE papers ADD COLUMN IF NOT EXISTS paper_no TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS papers_paper_no_idx ON papers(paper_no) WHERE paper_no IS NOT NULL`);

  // Give older rows a stable paper number.
  await pool.query(`
    UPDATE papers
    SET paper_no = 'QP-' || LPAD(id::text, 4, '0')
    WHERE paper_no IS NULL
  `);

  // Backfill version metadata for rows created by the previous server.
  await pool.query(`
    UPDATE papers
    SET versions = jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'filename', original_filename,
        'uploadTime', COALESCE(submission_date, created_at),
        'uploadedBy', COALESCE(faculty, 'Faculty')
      )
    )
    WHERE (versions IS NULL OR versions = '[]'::jsonb)
      AND original_filename IS NOT NULL
  `);
}

app.get("/health", async (_req, res) => {
  try {
    if (process.env.DATABASE_URL) {
      await pool.query("SELECT 1");
      return res.json({ ok: true, database: "connected" });
    }
    res.json({ ok: true, database: "not-configured" });
  } catch (e) {
    res.status(503).json({ ok: false, database: "error", error: e.message });
  }
});

app.get("/api/config", (_req, res) => res.json({ ok: true }));

app.get("/api/papers", async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM papers ORDER BY created_at DESC`);
    res.json({ ok: true, papers: rows.map(serializePaper) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// VIEW in browser (PDFs/documents are served inline where the browser supports them).
app.get("/api/papers/:id/file", async (req, res) => {
  try {
    const p = await findPaper(req.params.id);
    if (!p) return res.status(404).send("Paper not found");
    if (!p.file_data) return res.status(404).send("File not found for this paper");

    res.setHeader("Content-Type", p.file_mimetype || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(p.original_filename || "question-paper")}"`);
    res.send(p.file_data);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// DOWNLOAD.
app.get("/api/papers/:id/download", async (req, res) => {
  try {
    const p = await findPaper(req.params.id);
    if (!p) return res.status(404).send("Paper not found");
    if (!p.file_data) return res.status(404).send("File not found for this paper");

    res.setHeader("Content-Type", p.file_mimetype || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(p.original_filename || "question-paper")}"`);
    res.send(p.file_data);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// NEW PAPER UPLOAD.
app.post("/api/papers", upload.single("file"), async (req, res) => {
  try {
    const b = req.body || {};
    const f = req.file;

    if (!f) return res.status(400).json({ ok: false, error: "Please select a file to upload." });

    const paperNo = b.paper_no || makePaperNo();
    const timestamp = new Date().toISOString();
    const versionInfo = [{
      version: 1,
      filename: f.originalname,
      uploadTime: timestamp,
      uploadedBy: b.faculty || "Faculty"
    }];

    const { rows } = await pool.query(`
      INSERT INTO papers (
        paper_no, title, school, program, department, semester, course,
        subject, faculty, exam, status, expected, original_filename,
        stored_filename, file_path, file_mimetype, file_size, file_data,
        versions, comments, submission_date, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW(),NOW())
      RETURNING *
    `, [
      paperNo,
      b.title || b.subject || "Question Paper",
      b.school || null,
      b.program || null,
      b.department || null,
      b.semester || null,
      b.course || null,
      b.subject || null,
      b.faculty || null,
      b.exam || null,
      b.status || "SUBMITTED_TO_COE",
      b.expected === undefined ? true : String(b.expected) !== "false",
      f.originalname,
      null,
      null,
      f.mimetype,
      f.size,
      f.buffer,
      JSON.stringify(versionInfo),
      b.comments || null
    ]);

    res.status(201).json({ ok: true, paper: serializePaper(rows[0]) });
  } catch (e) {
    console.error("Upload error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// REVISION UPLOAD: replaces the active file but preserves version history.
app.post("/api/papers/:id/revision", upload.single("file"), async (req, res) => {
  try {
    const p = await findPaper(req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: "Paper not found" });
    if (!req.file) return res.status(400).json({ ok: false, error: "Please select a revision file." });

    let versions = [];
    try {
      versions = Array.isArray(p.versions) ? p.versions : JSON.parse(p.versions || "[]");
    } catch {
      versions = [];
    }

    const nextVersion = versions.length + 1;
    versions.push({
      version: nextVersion,
      filename: req.file.originalname,
      uploadTime: new Date().toISOString(),
      uploadedBy: req.body.faculty || p.faculty || "Faculty"
    });

    const { rows } = await pool.query(`
      UPDATE papers
      SET original_filename=$1,
          file_mimetype=$2,
          file_size=$3,
          file_data=$4,
          versions=$5::jsonb,
          status=$6,
          updated_at=NOW()
      WHERE id=$7
      RETURNING *
    `, [
      req.file.originalname,
      req.file.mimetype,
      req.file.size,
      req.file.buffer,
      JSON.stringify(versions),
      "RESUBMITTED_TO_COE",
      p.id
    ]);

    res.json({ ok: true, paper: serializePaper(rows[0]) });
  } catch (e) {
    console.error("Revision upload error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.patch("/api/papers/:id", async (req, res) => {
  try {
    const allowed = [
      "paper_no","title","school","program","department","semester","course",
      "subject","faculty","exam","status","expected","comments"
    ];
    const entries = Object.entries(req.body || {}).filter(([k]) => allowed.includes(k));
    if (!entries.length) return res.status(400).json({ ok:false, error:"No editable fields supplied" });

    const sets = entries.map(([k], i) => `"${k}"=$${i+1}`);
    const values = entries.map(([,v]) => v);
    values.push(req.params.id);

    const target = values[values.length - 1];
    const numericTarget = /^\d+$/.test(String(target));
    const whereClause = numericTarget
      ? `id=$${values.length}::bigint`
      : `paper_no=$${values.length}`;

    const { rows } = await pool.query(
      `UPDATE papers SET ${sets.join(", ")}, updated_at=NOW()
       WHERE ${whereClause}
       RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ ok:false, error:"Paper not found" });
    res.json({ ok:true, paper:serializePaper(rows[0]) });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.delete("/api/papers/:id", async (req, res) => {
  try {
    const value = String(req.params.id);
    const numeric = /^\d+$/.test(value);
    const query = numeric
      ? `DELETE FROM papers WHERE id=$1::bigint RETURNING id`
      : `DELETE FROM papers WHERE paper_no=$1 RETURNING id`;
    const { rows } = await pool.query(query, [value]);
    if (!rows.length) return res.status(404).json({ ok:false, error:"Paper not found" });
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.use(express.static(__dirname));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

initDb()
  .then(() => app.listen(PORT, "0.0.0.0", () => console.log(`QPMS server listening on ${PORT}`)))
  .catch(err => {
    console.error("Database initialization failed:", err);
    app.listen(PORT, "0.0.0.0", () => console.log(`QPMS server listening on ${PORT} (DB unavailable)`));
  });
