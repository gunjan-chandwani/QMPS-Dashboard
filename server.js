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

const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safe}`);
  }
});
const upload = multer({ storage });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL is not set. Persistent database features will not work.");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS papers (
      id BIGSERIAL PRIMARY KEY,
      paper_no TEXT,
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
      comments TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      file_data BYTEA
    )
  `);
  await pool.query(`ALTER TABLE papers ADD COLUMN IF NOT EXISTS file_data BYTEA`);
  await pool.query(`CREATE TABLE IF NOT EXISTS coe_notices (
    id BIGSERIAL PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    file_mimetype TEXT,
    file_size BIGINT,
    file_data BYTEA NOT NULL,
    uploaded_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS datesheet_schedule (
    id BIGSERIAL PRIMARY KEY, course_name TEXT NOT NULL, course_code TEXT NOT NULL, school TEXT,
    department TEXT NOT NULL, program TEXT, semester TEXT NOT NULL, exam_type TEXT NOT NULL,
    paper_date DATE NOT NULL, faculty_name TEXT, updated_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_datesheet_schedule_lookup ON datesheet_schedule (UPPER(course_code), LOWER(department), LOWER(semester), LOWER(exam_type))`);
}

async function validatePaperDateAgainstSchedule(data) {
  const { rows } = await pool.query(`SELECT TO_CHAR(paper_date, 'YYYY-MM-DD') AS paper_date
    FROM datesheet_schedule
    WHERE UPPER(TRIM(course_code))=UPPER(TRIM($1))
      AND LOWER(TRIM(department))=LOWER(TRIM($2))
      AND LOWER(TRIM(semester))=LOWER(TRIM($3))
      AND LOWER(TRIM(exam_type))=LOWER(TRIM($4))
      AND (COALESCE(TRIM(program),'')='' OR LOWER(TRIM(program))=LOWER(TRIM($5)))
    ORDER BY updated_at DESC`, [data.course || '', data.department || '', data.semester || '', data.exam || '', data.program || '']);
  if (!rows.length) {
    const error = new Error('No matching COE master schedule entry was found for this course, department, program, semester and exam. Ask COE to add or update the schedule before uploading.');
    error.statusCode = 400;
    throw error;
  }
  const dates = [...new Set(rows.map(r => r.paper_date).filter(Boolean))];
  const submittedDate = String(data.submission_date || '').slice(0,10);
  if (dates.length && !dates.includes(submittedDate)) {
    const error = new Error(`Paper date does not match the COE datesheet. Scheduled date: ${dates.join(', ')}.`);
    error.statusCode = 400;
    throw error;
  }
  return {matched:true, dates};
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

app.get("/api/config", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/papers", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id::text AS id, paper_no, title, school, program, department, semester,
             course, subject, faculty, exam, submission_date, status, expected,
             original_filename, file_mimetype, file_size, comments,
             created_at, updated_at, (file_data IS NOT NULL OR file_path IS NOT NULL) AS has_file
      FROM papers
      ORDER BY created_at DESC
    `);
    res.json({ ok: true, papers: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Structured COE schedule is separate from the uploaded datesheet file.
// Adding the same course/program/semester/exam again updates the existing schedule row.
app.get('/api/datesheet-schedule', async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id::text AS id, course_name AS "courseName", course_code AS "courseCode",
      school, department, program, semester, exam_type AS "examType", TO_CHAR(paper_date,'YYYY-MM-DD') AS "paperDate",
      faculty_name AS "facultyName", updated_at FROM datesheet_schedule ORDER BY paper_date, course_code`);
    res.json({ok:true,schedules:rows});
  } catch (e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/api/datesheet-schedule', async (req, res) => {
  try {
    const b = req.body || {};
    const required = ['courseName','courseCode','department','program','semester','examType','paperDate','facultyName'];
    const missing = required.filter(k => !String(b[k] || '').trim());
    if (missing.length) return res.status(400).json({ok:false,error:`Required schedule fields missing: ${missing.join(', ')}`});
    const found = await pool.query(`SELECT id FROM datesheet_schedule
      WHERE UPPER(TRIM(course_code))=UPPER(TRIM($1)) AND LOWER(TRIM(department))=LOWER(TRIM($2))
      AND LOWER(TRIM(program))=LOWER(TRIM($3)) AND LOWER(TRIM(semester))=LOWER(TRIM($4))
      AND LOWER(TRIM(exam_type))=LOWER(TRIM($5)) ORDER BY updated_at DESC LIMIT 1`,
      [b.courseCode,b.department,b.program,b.semester,b.examType]);
    let rows, updated = found.rows.length > 0;
    if (updated) {
      ({rows} = await pool.query(`UPDATE datesheet_schedule SET course_name=$2, school=$3, paper_date=$4::date,
        faculty_name=$5, updated_by=$6, updated_at=NOW() WHERE id=$1
        RETURNING id::text AS id, course_name AS "courseName", course_code AS "courseCode", school, department, program,
        semester, exam_type AS "examType", TO_CHAR(paper_date,'YYYY-MM-DD') AS "paperDate", faculty_name AS "facultyName", updated_at`,
        [found.rows[0].id,b.courseName,b.school || null,b.paperDate,b.facultyName,b.updated_by || 'COE']));
    } else {
      ({rows} = await pool.query(`INSERT INTO datesheet_schedule
        (course_name,course_code,school,department,program,semester,exam_type,paper_date,faculty_name,updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10)
        RETURNING id::text AS id, course_name AS "courseName", course_code AS "courseCode", school, department, program,
        semester, exam_type AS "examType", TO_CHAR(paper_date,'YYYY-MM-DD') AS "paperDate", faculty_name AS "facultyName", updated_at`,
        [b.courseName,b.courseCode.toUpperCase(),b.school || null,b.department,b.program,b.semester,b.examType,b.paperDate,b.facultyName,b.updated_by || 'COE']));
    }
    res.status(updated ? 200 : 201).json({ok:true,updated,schedule:rows[0]});
  } catch (e) { res.status(e.statusCode || 500).json({ok:false,error:e.message}); }
});

// COE-published datesheets and question-paper formats are stored in PostgreSQL,
// so Faculty, COE and Moderators all see the same durable documents.
app.get("/api/notices", async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id::text AS id, type, title, original_filename AS filename,
      file_mimetype, file_size, uploaded_by, created_at FROM coe_notices ORDER BY created_at DESC`);
    res.json({ ok: true, notices: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/notices", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "Please select a datesheet or format file." });
    const type = String(req.body.type || '').trim();
    const title = String(req.body.title || '').trim();
    if (!type || !title) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ ok: false, error: "Document category and title are required." });
    }
    const fileData = fs.readFileSync(req.file.path);
    const { rows } = await pool.query(`INSERT INTO coe_notices
      (type, title, original_filename, file_mimetype, file_size, file_data, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id::text AS id, type, title, original_filename AS filename, file_mimetype, file_size, uploaded_by, created_at`,
      [type, title, req.file.originalname, req.file.mimetype, req.file.size, fileData, req.body.uploaded_by || 'COE']);
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(201).json({ ok: true, notice: rows[0] });
  } catch (e) {
    if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch {} }
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/notices/:id/view", async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT original_filename, file_mimetype, file_data FROM coe_notices WHERE id::text=$1', [String(req.params.id)]);
    if (!rows.length) return res.status(404).send('Published document not found');
    const n = rows[0];
    res.setHeader('Content-Type', n.file_mimetype || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(n.original_filename || 'COE-document')}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.end(n.file_data);
  } catch (e) { res.status(500).send(e.message); }
});

app.get("/api/notices/:id/download", async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT original_filename, file_mimetype, file_data FROM coe_notices WHERE id::text=$1', [String(req.params.id)]);
    if (!rows.length) return res.status(404).send('Published document not found');
    const n = rows[0];
    res.setHeader('Content-Type', n.file_mimetype || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(n.original_filename || 'COE-document')}`);
    return res.end(n.file_data);
  } catch (e) { res.status(500).send(e.message); }
});

app.get("/api/papers/:id/file", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT original_filename, file_path, file_mimetype, file_data FROM papers WHERE id::text=$1",
      [String(req.params.id)]
    );
    if (!rows.length) return res.status(404).send("Paper not found");
    const p = rows[0];
    const filename = p.original_filename || "question-paper";
    res.setHeader("Content-Type", p.file_mimetype || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    if (p.file_data) return res.end(p.file_data);
    if (p.file_path && fs.existsSync(p.file_path)) return fs.createReadStream(p.file_path).pipe(res);
    return res.status(404).send("File not found");
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/api/papers/:id/view", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT original_filename, file_path, file_mimetype, file_data FROM papers WHERE id::text=$1",
      [String(req.params.id)]
    );
    if (!rows.length) return res.status(404).send("Paper not found");
    const p = rows[0];
    const mime = p.file_mimetype || "application/octet-stream";
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(p.original_filename || "question-paper")}`);
    if (p.file_data) return res.end(p.file_data);
    if (p.file_path && fs.existsSync(p.file_path)) return fs.createReadStream(p.file_path).pipe(res);
    return res.status(404).send("File not found");
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.post("/api/papers", upload.single("file"), async (req, res) => {
  try {
    const b = req.body || {};
    const f = req.file;
    await validatePaperDateAgainstSchedule(b);

    const { rows } = await pool.query(`
      INSERT INTO papers (
        paper_no, title, school, program, department, semester, course,
        subject, faculty, exam, submission_date, status, expected, original_filename,
        stored_filename, file_path, file_mimetype, file_size, comments, file_data
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE(NULLIF($12,''),NOW()),$13,$14,$15,$16,$17,$18,$19,$20)
      RETURNING *
    `, [
      b.paper_no || null,
      b.title || b.subject || "Question Paper",
      b.school || null,
      b.program || null,
      b.department || null,
      b.semester || null,
      b.course || null,
      b.subject || null,
      b.faculty || null,
      b.exam || null,
      b.submission_date || null,
      b.status || "Submitted to COE",
      b.expected === undefined ? true : String(b.expected) !== "false",
      f?.originalname || null,
      f?.filename || null,
      f?.path || null,
      f?.mimetype || null,
      f?.size || null,
      b.comments || null,
      f ? fs.readFileSync(f.path) : null
    ]);

    res.status(201).json({ ok: true, paper: rows[0] });
  } catch (e) {
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(e.statusCode || 500).json({ ok: false, error: e.message });
  }
});

app.post("/api/papers/:id/replace-file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ok:false, error:"No file uploaded"});
    const b = req.body || {};
    await validatePaperDateAgainstSchedule(b);
    const { rows } = await pool.query(`
      UPDATE papers SET
        title=COALESCE($2,title), program=COALESCE($3,program), department=COALESCE($4,department),
        semester=COALESCE($5,semester), course=COALESCE($6,course), subject=COALESCE($7,subject),
        faculty=COALESCE($8,faculty), exam=COALESCE($9,exam), submission_date=COALESCE(NULLIF($10,''),submission_date), status='RESUBMITTED_TO_COE',
        original_filename=$11, stored_filename=$12, file_path=$13, file_mimetype=$14, file_size=$15,
        file_data=$16, updated_at=NOW()
      WHERE id::text=$1 RETURNING *
    `, [
      String(req.params.id), b.title || null, b.program || null, b.department || null,
      b.semester || null, b.course || null, b.subject || null, b.faculty || null, b.exam || null,
      b.submission_date || null, req.file.originalname, req.file.filename, req.file.path, req.file.mimetype,
      req.file.size, fs.readFileSync(req.file.path)
    ]);
    if (!rows.length) return res.status(404).json({ok:false,error:"Paper not found"});
    res.json({ok:true,paper:rows[0]});
  } catch (e) {
    if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch {} }
    res.status(e.statusCode || 500).json({ok:false,error:e.message});
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

    const { rows } = await pool.query(
      `UPDATE papers SET ${sets.join(", ")}, updated_at=NOW() WHERE id::text=$${values.length} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ ok:false, error:"Paper not found" });
    res.json({ ok:true, paper:rows[0] });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.delete("/api/papers/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "DELETE FROM papers WHERE id::text=$1 RETURNING file_path",
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok:false, error:"Paper not found" });

    if (rows[0].file_path && fs.existsSync(rows[0].file_path)) {
      try { fs.unlinkSync(rows[0].file_path); } catch {}
    }
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Keep frontend files served by the same Render service.
app.use(express.static(__dirname));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`QPMS server listening on ${PORT}`)))
  .catch(err => {
    console.error("Database initialization failed:", err);
    app.listen(PORT, () => console.log(`QPMS server listening on ${PORT} (DB unavailable)`));
  });
