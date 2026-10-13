const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const pdfParse = require("pdf-parse");
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
    extracted_text TEXT,
    uploaded_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`ALTER TABLE coe_notices ADD COLUMN IF NOT EXISTS extracted_text TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS datesheet_schedule (
    id BIGSERIAL PRIMARY KEY, course_name TEXT NOT NULL, course_code TEXT NOT NULL, school TEXT,
    department TEXT NOT NULL, program TEXT, semester TEXT NOT NULL, exam_type TEXT NOT NULL,
    paper_date DATE NOT NULL, faculty_name TEXT, updated_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_datesheet_schedule_lookup ON datesheet_schedule (UPPER(course_code), LOWER(department), LOWER(semester), LOWER(exam_type))`);
}

function dateVariants(isoDate) {
  const value = String(isoDate || '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return [];
  const [, yyyy, mm, dd] = m;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthLong = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthIndex = Number(mm) - 1;
  return [
    `${yyyy}-${mm}-${dd}`, `${dd}/${mm}/${yyyy}`, `${dd}-${mm}-${yyyy}`,
    `${dd}.${mm}.${yyyy}`, `${dd}/${mm}/${yyyy.slice(2)}`, `${dd}-${mm}-${yyyy.slice(2)}`,
    `${Number(dd)} ${months[monthIndex]} ${yyyy}`, `${dd} ${months[monthIndex]} ${yyyy}`,
    `${Number(dd)} ${monthLong[monthIndex]} ${yyyy}`, `${dd} ${monthLong[monthIndex]} ${yyyy}`
  ].map(v => v.toLowerCase());
}

function normalizedPdfText(text) {
  return String(text || '').replace(/[\u00a0\u200b]/g, ' ').replace(/[–—]/g, '-').toLowerCase();
}

async function getPublishedDatesheetText() {
  const { rows } = await pool.query(`SELECT id::text AS id, title, original_filename, file_mimetype, file_data, extracted_text
    FROM coe_notices
    WHERE LOWER(type) LIKE '%datesheet%' OR LOWER(title) LIKE '%datesheet%' OR LOWER(original_filename) LIKE '%datesheet%'
    ORDER BY created_at DESC`);
  const docs = [];
  for (const row of rows) {
    let extracted = row.extracted_text || '';
    if (!extracted && (String(row.file_mimetype || '').includes('pdf') || String(row.original_filename || '').toLowerCase().endsWith('.pdf'))) {
      try {
        const parsed = await pdfParse(row.file_data);
        extracted = parsed.text || '';
        if (extracted.trim()) {
          await pool.query('UPDATE coe_notices SET extracted_text=$2 WHERE id=$1', [row.id, extracted]);
        }
      } catch (e) {
        console.warn(`Could not extract text from existing datesheet ${row.id}:`, e.message);
      }
    }
    if (extracted.trim()) docs.push({ title: row.title, filename: row.original_filename, text: normalizedPdfText(extracted) });
  }
  return docs;
}

async function validatePaperDateAgainstSchedule(data) {
  const courseCode = String(data.course || '').trim();
  const department = String(data.department || '').trim();
  const semester = String(data.semester || '').trim();
  const exam = String(data.exam || '').trim();
  const program = String(data.program || '').trim();
  const submittedDate = String(data.submission_date || '').slice(0, 10);
  if (!courseCode || !department || !semester || !exam || !program || !submittedDate) {
    const error = new Error('Course code, department, programme, semester, examination type and paper date are all required for COE datesheet validation.');
    error.statusCode = 400;
    throw error;
  }

  const { rows } = await pool.query(`SELECT TO_CHAR(paper_date, 'YYYY-MM-DD') AS paper_date, course_name
    FROM datesheet_schedule
    WHERE UPPER(TRIM(course_code))=UPPER(TRIM($1))
      AND LOWER(TRIM(department))=LOWER(TRIM($2))
      AND LOWER(TRIM(semester))=LOWER(TRIM($3))
      AND LOWER(TRIM(exam_type))=LOWER(TRIM($4))
      AND (COALESCE(TRIM(program),'')='' OR LOWER(TRIM(program))=LOWER(TRIM($5)))
    ORDER BY updated_at DESC`, [courseCode, department, semester, exam, program]);
  if (!rows.length) {
    const error = new Error('Upload blocked: COE master schedule mein is course code, department, programme, semester aur examination type ka matching record nahi mila. COE ko schedule add/update karna hoga.');
    error.statusCode = 400;
    throw error;
  }
  const scheduledDates = [...new Set(rows.map(r => r.paper_date).filter(Boolean))];
  if (!scheduledDates.includes(submittedDate)) {
    const error = new Error(`Upload blocked: faculty ki entered date COE master schedule se match nahi karti. Official scheduled date: ${scheduledDates.join(', ')}.`);
    error.statusCode = 400;
    throw error;
  }

  // Validate against the actual PDF published in the COE portal, not only the editable schedule table.
  const documents = await getPublishedDatesheetText();
  if (!documents.length) {
    const error = new Error('Upload blocked: COE portal par readable, text-based official datesheet PDF publish nahi hai. COE pehle datesheet PDF publish kare. Scanned PDF ko OCR/text-searchable PDF bana kar upload karein.');
    error.statusCode = 400;
    throw error;
  }
  const codeNeedle = courseCode.toLowerCase();
  const variants = dateVariants(submittedDate);
  const evidence = documents.filter(doc => {
    const text = doc.text;
    const codeIndex = text.indexOf(codeNeedle);
    if (codeIndex < 0) return false;
    // First look near the course-code occurrence to avoid matching a date elsewhere in the document.
    const nearby = text.slice(Math.max(0, codeIndex - 220), Math.min(text.length, codeIndex + 500));
    return variants.some(v => nearby.includes(v)) || (text.includes(codeNeedle) && variants.some(v => text.includes(v)) && text.length < 2500);
  });
  if (!evidence.length) {
    const titles = documents.map(d => d.title || d.filename || 'COE datesheet').join('; ');
    const error = new Error(`Upload blocked: published COE datesheet PDF mein course code ${courseCode} ke saath ${submittedDate} date verify nahi hui. Datesheet documents checked: ${titles}. Agar PDF scanned hai, searchable PDF/OCR version upload karein.`);
    error.statusCode = 400;
    throw error;
  }
  return { matched: true, dates: scheduledDates, pdfVerified: true, documents: evidence.map(d => d.title || d.filename) };
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
    let extractedText = null;
    if (String(type).toLowerCase().includes('datesheet') || String(title).toLowerCase().includes('datesheet') || req.file.originalname.toLowerCase().includes('datesheet')) {
      const isPdf = req.file.mimetype === 'application/pdf' || req.file.originalname.toLowerCase().endsWith('.pdf');
      if (!isPdf) {
        try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(400).json({ok:false,error:'Official examination datesheet must be uploaded as a PDF.'});
      }
      try {
        const parsed = await pdfParse(fileData);
        extractedText = parsed.text || '';
        if (!extractedText.trim()) {
          try { fs.unlinkSync(req.file.path); } catch {}
          return res.status(400).json({ok:false,error:'This PDF has no extractable text. Please OCR it / make it searchable and upload again so faculty submissions can be validated against it.'});
        }
      } catch (parseError) {
        try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(400).json({ok:false,error:'Could not read the datesheet PDF. Please upload a valid, searchable PDF.'});
      }
    }
    const { rows } = await pool.query(`INSERT INTO coe_notices
      (type, title, original_filename, file_mimetype, file_size, file_data, extracted_text, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id::text AS id, type, title, original_filename AS filename, file_mimetype, file_size, uploaded_by, created_at`,
      [type, title, req.file.originalname, req.file.mimetype, req.file.size, fileData, extractedText, req.body.uploaded_by || 'COE']);
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
    if (!f) return res.status(400).json({ok:false,error:"Please attach the question paper PDF."});
    if (!(f.mimetype === 'application/pdf' || f.originalname.toLowerCase().endsWith('.pdf'))) {
      try { fs.unlinkSync(f.path); } catch {}
      return res.status(400).json({ok:false,error:"Only PDF question papers are accepted."});
    }
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
    if (!(req.file.mimetype === 'application/pdf' || req.file.originalname.toLowerCase().endsWith('.pdf'))) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ok:false,error:"Only PDF question papers are accepted."});
    }
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
