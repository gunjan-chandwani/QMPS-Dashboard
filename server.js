const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const pdfParse = require("pdf-parse");
const zlib = require("zlib");
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
      moderation_details JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      file_data BYTEA
    )
  `);
  await pool.query(`ALTER TABLE papers ADD COLUMN IF NOT EXISTS file_data BYTEA`);
  await pool.query(`ALTER TABLE papers ADD COLUMN IF NOT EXISTS moderation_details JSONB`);
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


function parseDatesheetScheduleRows(pdfText) {
  // PDF text extraction may put date, course code and course name on separate lines.
  // Parse each date block rather than requiring all fields to be on the same line.
  const lines = String(pdfText || '').replace(/\f/g, '\n').replace(/\r/g, '\n')
    .split('\n').map(x => x.replace(/[\u00a0\u200b]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const rows = [];
  let currentProgram = '';
  let currentSemester = '';
  let currentExam = 'Mid Semester';
  const dateRe = /\b(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})\b/;
  // Supports numeric-prefixed course codes (4.5PH01O001) and legacy codes (CSH301C, CDO331).
  const codeRe = /\b(?:\d+\.\d+[A-Z]{2,4}\d{2}[A-Z]\d{3}|[A-Z]{2,4}\d{3,4}[A-Z]?|\d+(?:\.\d+)?[A-Z]{2,4}\d{2,4}[A-Z]\d{0,4})\b/i;
  const isHeader = x => /^(date|timings?|course code|course name|manav rachna|schedule for|controller of examination|semester\s*[-:])/i.test(x);
  const isProgramHeading = x => /^(bachelor|bachelors|master|masters|b\.?\s?tech|m\.?\s?tech|bca|mca|mba|bba|llb|llm|b\.?\s?sc|m\.?\s?sc)\b/i.test(x);
  const cleanName = x => String(x || '').replace(dateRe, ' ')
    .replace(codeRe, ' ')
    .replace(/\d{1,2}\.\d{2}\s*(?:noon|am|pm)?\s*[-–]\s*\d{1,2}\.\d{2}\s*(?:noon|am|pm)?/ig, ' ')
    .replace(/\d{1,2}\.\d{2}\s*(?:noon|am|pm)/ig, ' ')
    .replace(/\b(?:DATE|TIMINGS?|COURSE CODE|COURSE NAME)\b/ig, ' ')
    .replace(/\s+/g, ' ').replace(/^[|: -]+|[|: -]+$/g, '').trim();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sem = line.match(/SEMESTER\s*[-:]?\s*(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|[1-8](?:ST|ND|RD|TH)?)/i);
    if (sem) {
      const v = sem[1].toUpperCase();
      const map = {FIRST:'1st',SECOND:'2nd',THIRD:'3rd',FOURTH:'4th',FIFTH:'5th',SIXTH:'6th',SEVENTH:'7th',EIGHTH:'8th'};
      currentSemester = map[v] || (/^\d/.test(v) ? v.replace(/ST|ND|RD|TH/, '') : v);
    }
    if (/SCHEDULE FOR .*EXAMINATION/i.test(line)) {
      if (/END\s*SEM/i.test(line)) currentExam = 'End Semester';
      else if (/SUPPLEMENT/i.test(line)) currentExam = 'Supplementary';
      else if (/MID\s*SEM/i.test(line)) currentExam = 'Mid Semester';
    }
    if (isProgramHeading(line) && !isHeader(line)) currentProgram = line;

    const dateMatch = line.match(dateRe);
    if (!dateMatch) continue;
    // Use the text up to the next dated row as the block for this paper.
    let block = line;
    for (let j = i + 1; j < lines.length && j <= i + 8 && !dateRe.test(lines[j]); j++) {
      block += ' ' + lines[j];
    }
    const codeMatch = block.match(codeRe);
    if (!codeMatch) continue;
    const code = codeMatch[0].toUpperCase();
    const dd = String(dateMatch[1]).padStart(2, '0');
    const mm = String(dateMatch[2]).padStart(2, '0');
    const paperDate = dateMatch[3] + '-' + mm + '-' + dd;
    let name = cleanName(block.slice(block.indexOf(codeMatch[0]) + codeMatch[0].length));
    // If PDF column extraction places the subject before the code, try text immediately preceding it.
    if (!name || name.length < 3) {
      const beforeCode = block.slice(0, block.indexOf(codeMatch[0]));
      name = cleanName(beforeCode);
    }
    if (!name || name.length < 3) name = code;
    const program = currentProgram || 'Unmapped Programme';
    const low = (program + ' ' + name).toLowerCase();
    const department = /robot|artificial intelligence/i.test(low) ? 'Robotics & AI'
      : /electronics|electrical|vlsi|chip design/i.test(low) ? 'Electronics & Communication'
      : /mechanical|manufacturing/i.test(low) ? 'Mechanical Engineering'
      : /computer science|csti|aiml|gen ai|quantum computing|cloud computing/i.test(low) ? 'Computer Science & Technology'
      : /law|llb|llm/i.test(low) ? 'Law'
      : /business|management|mba|bba|fintech/i.test(low) ? 'Business'
      : /education|itep|b\.ed/i.test(low) ? 'Education & Humanities'
      : /physics|chemistry|mathematics|science/i.test(low) ? 'Sciences' : 'Unmapped Department';
    const school = ['Computer Science & Technology','Robotics & AI','Electronics & Communication','Mechanical Engineering'].includes(department) ? 'School of Engineering'
      : department === 'Law' ? 'School of Law'
      : department === 'Business' ? 'School of Business'
      : department === 'Sciences' ? 'School of Sciences'
      : department === 'Education & Humanities' ? 'School of Education & Humanities' : 'Unmapped / Other';
    rows.push({courseCode:code,courseName:name,school,department,program,semester:currentSemester || 'Not specified',examType:currentExam,paperDate});
  }
  const unique = new Map();
  for (const r of rows) unique.set([r.courseCode,r.program,r.semester,r.examType,r.paperDate].join('|'),r);
  return [...unique.values()];
}

async function syncDatesheetScheduleFromPdf(pdfText, uploadedBy) {
  const parsed = parseDatesheetScheduleRows(pdfText);
  let inserted = 0, updated = 0;
  for (const r of parsed) {
    const existing = await pool.query(`SELECT id FROM datesheet_schedule
      WHERE UPPER(TRIM(course_code))=UPPER(TRIM($1)) AND LOWER(TRIM(program))=LOWER(TRIM($2))
      AND LOWER(TRIM(semester))=LOWER(TRIM($3)) AND LOWER(TRIM(exam_type))=LOWER(TRIM($4))
      AND paper_date=$5::date ORDER BY updated_at DESC LIMIT 1`, [r.courseCode,r.program,r.semester,r.examType,r.paperDate]);
    if (existing.rows.length) {
      await pool.query(`UPDATE datesheet_schedule SET course_name=$2, school=$3, department=$4, updated_by=$5, updated_at=NOW() WHERE id=$1`,
        [existing.rows[0].id,r.courseName,r.school,r.department,uploadedBy || 'COE']);
      updated++;
    } else {
      await pool.query(`INSERT INTO datesheet_schedule
        (course_name, course_code, school, department, program, semester, exam_type, paper_date, faculty_name, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,NULL,$9)`,
        [r.courseName,r.courseCode,r.school,r.department,r.program,r.semester,r.examType,r.paperDate,uploadedBy || 'COE']);
      inserted++;
    }
  }
  return {count: parsed.length, inserted, updated, rows: parsed};
}

async function backfillDatesheetSchedulesFromExistingNotices() {
  const result = await pool.query(`SELECT extracted_text, uploaded_by FROM coe_notices
    WHERE (LOWER(type) LIKE '%datesheet%' OR LOWER(title) LIKE '%datesheet%' OR LOWER(original_filename) LIKE '%datesheet%')
      AND COALESCE(extracted_text, '') <> '' ORDER BY created_at ASC`);
  let total = 0;
  for (const notice of result.rows) {
    const synced = await syncDatesheetScheduleFromPdf(notice.extracted_text, notice.uploaded_by || 'COE');
    total += synced.count || 0;
  }
  console.log('Datesheet startup sync complete; parsed course/date rows:', total);
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
  // The exam date is a calendar date, not a timestamp. Normalize to YYYY-MM-DD
  // before comparing with PostgreSQL DATE values (avoids timezone-dependent parsing).
  const rawSubmittedDate = String(data.paperDate || data.paper_date || data.exam_date || data.submission_date || '').trim();
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(rawSubmittedDate);
  const submittedDate = isoMatch ? `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}` : rawSubmittedDate.slice(0, 10);
  if (!courseCode || !department || !semester || !exam || !program || !submittedDate) {
    const error = new Error('Course code, department, programme, semester, examination type and paper date are required.');
    error.statusCode = 400;
    throw error;
  }

  // The published COE PDF is the source of truth. Do not force COE to duplicate
  // every row manually in datesheet_schedule before the PDF can be used.
  const documents = await getPublishedDatesheetText();
  if (!documents.length) {
    const error = new Error('No readable COE Examination Datesheet PDF was found in the portal. COE must publish a searchable PDF (scanned PDFs need OCR).');
    error.statusCode = 400;
    throw error;
  }

  // If COE has also maintained a structured row, use it as an additional check.
  const { rows } = await pool.query(`SELECT TO_CHAR(paper_date, 'YYYY-MM-DD') AS paper_date, course_name
    FROM datesheet_schedule
    WHERE UPPER(TRIM(course_code))=UPPER(TRIM($1))
      AND LOWER(TRIM(department))=LOWER(TRIM($2))
      AND LOWER(TRIM(semester))=LOWER(TRIM($3))
      AND LOWER(TRIM(exam_type))=LOWER(TRIM($4))
      AND (COALESCE(TRIM(program),'')='' OR LOWER(TRIM(program))=LOWER(TRIM($5)))
    ORDER BY updated_at DESC`, [courseCode, department, semester, exam, program]);
  const scheduledDates = [...new Set(rows.map(r => r.paper_date).filter(Boolean))];
  if (scheduledDates.length && !scheduledDates.includes(submittedDate)) {
    const error = new Error(`Date mismatch: COE schedule record shows ${scheduledDates.join(', ')}. Please use the official date or ask COE to correct the schedule/PDF.`);
    error.statusCode = 400;
    throw error;
  }

  const variants = dateVariants(submittedDate);
  const codeNeedle = courseCode.toLowerCase();
  const evidence = [];
  for (const doc of documents) {
    const text = doc.text || '';
    let from = 0;
    while (from < text.length) {
      const codeIndex = text.indexOf(codeNeedle, from);
      if (codeIndex < 0) break;
      // Check the same table row/nearby wrapped lines around every occurrence,
      // rather than just the first occurrence of the course code in the PDF.
      const left = Math.max(0, text.lastIndexOf('\n', codeIndex) - 220, codeIndex - 180);
      const rightNewline = text.indexOf('\n', codeIndex);
      const right = Math.min(text.length, codeIndex + 900, rightNewline >= 0 ? rightNewline + 500 : text.length);
      const nearby = text.slice(left, right);
      if (variants.some(v => nearby.includes(v))) {
        evidence.push(doc);
        break;
      }
      from = codeIndex + codeNeedle.length;
    }
  }
  if (!evidence.length) {
    const titles = documents.map(d => d.title || d.filename || 'COE datesheet').join('; ');
    const error = new Error(`Upload blocked: uploaded COE PDF was read, but course code ${courseCode} was not found with date ${submittedDate}. Checked: ${titles}. Please verify the date format/course code in the PDF; if it is scanned, upload an OCR/searchable PDF.`);
    error.statusCode = 400;
    throw error;
  }
  return { matched: true, dates: scheduledDates.length ? scheduledDates : [submittedDate], pdfVerified: true, documents: [...new Set(evidence.map(d => d.title || d.filename))] };
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
             original_filename, file_mimetype, file_size, comments, moderation_details,
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
    // Self-heal schedule on read: re-process stored PDFs uploaded before parser fixes.
    const noticeResult = await pool.query(`SELECT extracted_text, uploaded_by FROM coe_notices
      WHERE (LOWER(type) LIKE '%datesheet%' OR LOWER(title) LIKE '%datesheet%' OR LOWER(original_filename) LIKE '%datesheet%')
      AND COALESCE(extracted_text, '') <> '' ORDER BY created_at ASC`);
    let parsedFromNotices = 0;
    for (const notice of noticeResult.rows) {
      const sync = await syncDatesheetScheduleFromPdf(notice.extracted_text, notice.uploaded_by || 'COE');
      parsedFromNotices += sync.count || 0;
    }
    const { rows } = await pool.query(`SELECT id::text AS id, course_name AS "courseName", course_code AS "courseCode",
      school, department, program, semester, exam_type AS "examType", TO_CHAR(paper_date,'YYYY-MM-DD') AS "paperDate",
      faculty_name AS "facultyName", updated_at FROM datesheet_schedule ORDER BY paper_date, course_code`);
    res.json({ok:true,schedules:rows,diagnostics:{datesheetNoticesFound:noticeResult.rows.length,parsedCourseRows:parsedFromNotices,loadedScheduleRows:rows.length}});
  } catch (e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/api/datesheet-schedule', async (req, res) => {
  try {
    const b = req.body || {};
    const required = ['courseName','courseCode','department','program','semester','examType','paperDate','facultyName'];
    const missing = required.filter(k => !String(b[k] || '').trim());
    if (missing.length) return res.status(400).json({ok:false,error:`Required schedule fields missing: ${missing.join(', ')}`});
    const dateValue = String(b.paperDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue) || Number.isNaN(Date.parse(`${dateValue}T00:00:00Z`))) {
      return res.status(400).json({ok:false,error:'Exam date must be a valid date in YYYY-MM-DD format. Please select the date using the date picker.'});
    }
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
    let scheduleImport = {count:0};
    if (extractedText && (String(type).toLowerCase().includes('datesheet') || String(title).toLowerCase().includes('datesheet') || req.file.originalname.toLowerCase().includes('datesheet'))) {
      scheduleImport = await syncDatesheetScheduleFromPdf(extractedText, req.body.uploaded_by || 'COE');
    }
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(201).json({ ok: true, notice: rows[0], scheduleImported: scheduleImport.count, scheduleImportMessage: scheduleImport.count ? `Imported ${scheduleImport.count} course/date rows from datesheet.` : 'PDF uploaded, but no course/date rows were detected. Check the PDF layout or OCR.' });
  } catch (e) {
    if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch {} }
    res.status(500).json({ ok: false, error: e.message });
  }
});

// COE-only document deletion is enforced by the portal session/UI; API removes
// only the selected published document, not question papers or schedule rows.
app.delete("/api/notices/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "DELETE FROM coe_notices WHERE id::text=$1 RETURNING id::text AS id, title",
      [String(req.params.id)]
    );
    if (!rows.length) return res.status(404).json({ok:false,error:"Published document not found."});
    return res.json({ok:true,deleted:rows[0]});
  } catch (e) {
    return res.status(500).json({ok:false,error:e.message});
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


// Build a standards-compliant ZIP in memory using Node built-ins (no extra package needed).
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(files) {
  const localParts = [], centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.data);
    const compressed = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centralParts.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

app.get('/api/papers/download-all.zip', async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id::text AS id, title, course, subject, original_filename, file_path, file_data
      FROM papers WHERE file_data IS NOT NULL OR file_path IS NOT NULL ORDER BY created_at ASC`);
    const files = [];
    const used = new Set();
    for (const p of rows) {
      let data = p.file_data;
      if (!data && p.file_path && fs.existsSync(p.file_path)) data = fs.readFileSync(p.file_path);
      if (!data) continue;
      let base = String(p.original_filename || `${p.course || p.subject || p.title || 'question-paper'}-${p.id}.pdf`)
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
      if (!base) base = `question-paper-${p.id}.pdf`;
      let name = `${String(p.id).padStart(5, '0')}_${base}`;
      let suffix = 1;
      while (used.has(name.toLowerCase())) name = `${String(p.id).padStart(5, '0')}_${suffix++}_${base}`;
      used.add(name.toLowerCase());
      files.push({ name, data });
    }
    if (!files.length) return res.status(404).send('No question-paper files are available to download.');
    const zip = makeZip(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="QPMS_All_Question_Papers_${new Date().toISOString().slice(0,10)}.zip"`);
    res.setHeader('Content-Length', zip.length);
    res.end(zip);
  } catch (e) { res.status(500).send(`Could not package question papers: ${e.message}`); }
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
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE(NULLIF($11,'')::timestamptz,NOW()),$12,$13,$14,$15,$16,$17,$18,$19,$20)
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
      null, // submission timestamp is generated by PostgreSQL NOW(); exam date is validated separately
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
      null, // preserve the existing submission timestamp during file replacement
      req.file.originalname, req.file.filename, req.file.path, req.file.mimetype,
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
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, "moderationDetails")) {
      entries.push(["moderation_details", req.body.moderationDetails == null ? null : JSON.stringify(req.body.moderationDetails)]);
    }
    if (!entries.length) return res.status(400).json({ ok:false, error:"No editable fields supplied" });

    const sets = entries.map(([k], i) => k === "moderation_details" ? `"${k}"=$${i+1}::jsonb` : `"${k}"=$${i+1}`);
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
  .then(async () => {
    await backfillDatesheetSchedulesFromExistingNotices();
    app.listen(PORT, () => console.log(`QPMS server listening on ${PORT}`));
  })
  .catch(err => {
    console.error("Database initialization failed:", err);
    app.listen(PORT, () => console.log(`QPMS server listening on ${PORT} (DB unavailable)`));
  });
