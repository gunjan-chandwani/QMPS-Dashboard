const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const pdfParse = require("pdf-parse");
const zlib = require("zlib");
const crypto = require("crypto");
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

// Question-paper uploads accept PDF and Microsoft Word documents.
// Keep this validation local to question-paper routes; COE notice rules remain unchanged.
function isAllowedQuestionPaperFile(file) {
  const ext = path.extname(String(file?.originalname || '')).toLowerCase();
  const allowedMime = {
    '.pdf': ['application/pdf', 'application/x-pdf'],
    '.doc': ['application/msword'],
    '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document']
  };
  if (!allowedMime[ext]) return false;
  const mime = String(file?.mimetype || '').toLowerCase();
  return !mime || mime === 'application/octet-stream' || allowedMime[ext].includes(mime);
}

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
    CREATE TABLE IF NOT EXISTS faculty_accounts (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      department_code TEXT,
      department TEXT NOT NULL,
      school TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'FACULTY',
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE faculty_accounts ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT TRUE`);

  // Seed/update accounts from the HR-provided faculty list. Password hashes only
  // are stored in PostgreSQL; temporary passwords are distributed separately.
  const facultySeedPath = path.join(__dirname, "faculty-users.json");
  if (fs.existsSync(facultySeedPath)) {
    const seedUsers = JSON.parse(fs.readFileSync(facultySeedPath, "utf8"));
    for (const user of seedUsers) {
      // Only newly created non-Gunjan accounts receive the requested temporary password.
      // Existing account passwords are never overwritten by this startup seed.
      const isGunjanAccount = String(user.email || "").trim().toLowerCase() === "gunjan@mru.edu.in";
      const newAccountSalt = isGunjanAccount ? Buffer.from(user.salt, "hex") : crypto.randomBytes(16);
      const newAccountHash = isGunjanAccount
        ? user.passwordHash
        : crypto.scryptSync("mru123", newAccountSalt, 64).toString("hex");
      await pool.query(`
        INSERT INTO faculty_accounts
          (email, full_name, department_code, department, school, role, password_salt, password_hash, must_change_password, active)
        VALUES ($1,$2,$3,$4,$5,'FACULTY',$6,$7,TRUE,TRUE)
        ON CONFLICT (email) DO UPDATE SET
          full_name=EXCLUDED.full_name,
          department_code=EXCLUDED.department_code,
          department=EXCLUDED.department,
          school=EXCLUDED.school,
          password_salt=CASE
            WHEN LOWER(EXCLUDED.email) <> 'gunjan@mru.edu.in' AND faculty_accounts.must_change_password=TRUE
            THEN EXCLUDED.password_salt ELSE faculty_accounts.password_salt END,
          password_hash=CASE
            WHEN LOWER(EXCLUDED.email) <> 'gunjan@mru.edu.in' AND faculty_accounts.must_change_password=TRUE
            THEN EXCLUDED.password_hash ELSE faculty_accounts.password_hash END,
          updated_at=NOW()
      `, [user.email, user.name, user.departmentCode, user.department, user.school, newAccountSalt.toString("hex"), newAccountHash]);
    }
    // One-time recovery migration: align all seeded faculty accounts to the published temporary password.
    // Gunjan's account is deliberately excluded. A migration marker prevents later deployments
    // from resetting passwords that faculty have already changed.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_migrations (
        migration_key TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const resetMigration = await pool.query(
      "SELECT migration_key FROM app_migrations WHERE migration_key = $1",
      ["faculty_temp_password_reset_v1"]
    );
    if (resetMigration.rowCount === 0) {
      for (const user of seedUsers) {
        if (String(user.email || "").trim().toLowerCase() === "gunjan@mru.edu.in") continue;
        const salt = crypto.randomBytes(16);
        const hash = crypto.scryptSync("mru123", salt, 64).toString("hex");
        await pool.query(`
          UPDATE faculty_accounts
          SET password_salt = $2,
              password_hash = $3,
              must_change_password = TRUE,
              updated_at = NOW()
          WHERE LOWER(email) = LOWER($1)
        `, [user.email, salt.toString("hex"), hash]);
      }
      await pool.query(
        "INSERT INTO app_migrations (migration_key) VALUES ($1) ON CONFLICT DO NOTHING",
        ["faculty_temp_password_reset_v1"]
      );
      console.log("One-time faculty temporary-password recovery completed (Gunjan account excluded).");
    }
    // One-time Gunjan account recovery after faculty password synchronization.
    // The account must change this temporary password immediately after login.
    const gunjanRecovery = await pool.query(
      "SELECT migration_key FROM app_migrations WHERE migration_key = $1",
      ["gunjan_password_recovery_v1"]
    );
    if (gunjanRecovery.rowCount === 0) {
      const gunjanSalt = crypto.randomBytes(16);
      const gunjanHash = crypto.scryptSync("mru123", gunjanSalt, 64).toString("hex");
      await pool.query(`
        UPDATE faculty_accounts
        SET password_salt=$2, password_hash=$3, must_change_password=TRUE, active=TRUE, updated_at=NOW()
        WHERE LOWER(email)=LOWER($1)
      `, ["gunjan@mru.edu.in", gunjanSalt.toString("hex"), gunjanHash]);
      await pool.query(
        "INSERT INTO app_migrations (migration_key) VALUES ($1) ON CONFLICT DO NOTHING",
        ["gunjan_password_recovery_v1"]
      );
      console.log("One-time Gunjan account password recovery completed.");
    }
    console.log(`Faculty accounts provisioned: ${seedUsers.length}.`);
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
  await pool.query(`ALTER TABLE papers ADD COLUMN IF NOT EXISTS owner_email TEXT`);
  // All pre-existing question-paper records belong to the original administrator account.
  await pool.query(`UPDATE papers SET owner_email='gunjan@mru.edu.in' WHERE owner_email IS NULL OR TRIM(owner_email)=''`);
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
  // PDF text order is not the visual reading order. Fail closed rather than
  // assign unrelated programmes to datesheet entries.
  throw new Error('PDF text-only extraction is disabled. Use layout-aware PDF import.');
}

async function parseDatesheetScheduleLayout(pdfBuffer) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({data:new Uint8Array(pdfBuffer),disableFontFace:true,useSystemFonts:true}).promise;
  const rows=[];
  const semesterWords={FIRST:'1st',THIRD:'3rd',FIFTH:'5th',SEVENTH:'7th',NINTH:'9th',NINETH:'9th'};
  const codeRe=/(?<![A-Z0-9])(?:\d+(?:\.\d+)?[A-Z]{2}\d{2}[A-Z]\d{3}|[A-Z]{2,5}\d{2,4}[A-Z]?(?:-T)?)(?![A-Z0-9])/gi;
  for(let pageNo=1;pageNo<=doc.numPages;pageNo++){
    const page=await doc.getPage(pageNo),tc=await page.getTextContent();
    const items=tc.items.filter(i=>i.str&&i.str.trim()).map(i=>({x:i.transform[4],y:i.transform[5],str:i.str.trim()}));
    const lines=[];
    for(const item of items.sort((a,b)=>b.y-a.y||a.x-b.x)){
      let line=lines.find(l=>Math.abs(l.y-item.y)<3);
      if(!line){line={y:item.y,items:[]};lines.push(line);}
      line.items.push(item);
    }
    for(const line of lines){line.items.sort((a,b)=>a.x-b.x);line.text=line.items.map(i=>i.str).join(' ');}
    lines.sort((a,b)=>b.y-a.y);
    const semLine=lines.find(l=>/SEMESTER\s*[-:]\s*(FIRST|THIRD|FIFTH|SEVENTH|NINTH|NINETH)/i.test(l.text));
    if(!semLine)continue;
    const semester=semesterWords[semLine.text.match(/SEMESTER\s*[-:]\s*(FIRST|THIRD|FIFTH|SEVENTH|NINTH|NINETH)/i)[1].toUpperCase()];
    const headers=lines.filter(l=>/DATE\s+Timings?\s+Course\s*Code/i.test(l.text));
    for(let h=0;h<headers.length;h++){
      const header=headers[h],lower=headers[h+1]?.y??0;
      const headingLines=lines.filter(l=>l.y>header.y&&l.y<header.y+85&&!/SEMESTER|SCHEDULE FOR|MANAV RACHNA|CONTROLLER|DATE\s+Timings/i.test(l.text));
      const program=headingLines.reverse().map(l=>l.text).join(' ').trim();
      if(!program)throw new Error('Missing programme above table on PDF page '+pageNo);
      const dates=lines.filter(l=>l.y<header.y&&l.y>lower&&/\b\d{2}\.12\.2026\b/.test(l.text)&&/^\s*\d{2}\.12\.2026/.test(l.text));
      for(let d=0;d<dates.length;d++){
        const line=dates[d],date=line.text.match(/(\d{2})\.12\.2026/)[1];
        const top=d===0?header.y:(dates[d-1].y+line.y)/2;
        const bottom=d===dates.length-1?lower:(line.y+dates[d+1].y)/2;
        const cell=lines.filter(l=>l.y<top&&l.y>=bottom).flatMap(l=>l.items).filter(i=>i.x>210).map(i=>i.str).join(' ');
        const codes=[...new Set([...cell.matchAll(codeRe)].map(m=>m[0].toUpperCase()))];
        if(!codes.length)throw new Error('No course code at PDF page '+pageNo+' date '+date);
        for(const courseCode of codes)rows.push({courseCode,courseName:courseCode,school:null,department:null,program,semester,examType:'End Semester',paperDate:'2026-12-'+date});
      }
    }
  }
  if(rows.length<350)throw new Error('Incomplete PDF layout extraction: '+rows.length+' entries');
  return rows;
}

async function syncDatesheetScheduleFromPdf(pdfText, uploadedBy, pdfBuffer) {
  const parsed = await parseDatesheetScheduleLayout(pdfBuffer);
  const datedRows = (String(pdfText || '').match(/\b\d{2}\.12\.2026\s+\d{2}\.\d{2}\s*(?:AM|PM)/gi) || []).length;
  // A partial parse must never silently overwrite or append a misleading schedule.
  if (parsed.some(r => !r.school || !r.department) || !parsed.length || (datedRows >= 50 && parsed.length < datedRows * 0.8) ||
      parsed.some(r => !/[A-Z]/.test(r.courseCode) || !/\d/.test(r.courseCode))) {
    throw new Error('Datesheet extraction is incomplete or invalid; no schedule rows were written. Check PDF layout before importing.');
  }
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

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) return res.status(400).json({ok:false,error:"Enter your university email and password."});
    const result = await pool.query(`
      SELECT email, full_name, department_code, department, school, role, password_salt, password_hash, must_change_password, active
      FROM faculty_accounts WHERE email=$1 LIMIT 1
    `, [email]);
    const user = result.rows[0];
    if (!user || !user.active || user.role !== "FACULTY") {
      return res.status(401).json({ok:false,error:"Faculty account not found or inactive. Please contact QPMS administrator."});
    }
    const actual = crypto.scryptSync(password, Buffer.from(user.password_salt, "hex"), 64);
    const expected = Buffer.from(user.password_hash, "hex");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return res.status(401).json({ok:false,error:"Incorrect email or password."});
    }
    return res.json({ok:true,user:{
      name:user.full_name, email:user.email, role:user.role, avatar:(user.full_name || "F").trim().charAt(0).toUpperCase(),
      dept:`${user.school} • ${user.department}`, schoolScope:user.school, departmentScope:user.department,
      departmentCode:user.department_code, mustChangePassword: user.must_change_password
    }});
  } catch (e) {
    console.error("Faculty login failed:", e.message);
    return res.status(500).json({ok:false,error:"Login service is temporarily unavailable. Please try again."});
  }
});

app.post("/api/auth/change-password", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");
    if (newPassword.length < 12) return res.status(400).json({ok:false,error:"Choose a password with at least 12 characters."});
    const result = await pool.query(`SELECT email, password_salt, password_hash FROM faculty_accounts WHERE email=$1 AND active=TRUE LIMIT 1`, [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ok:false,error:"Account not found."});
    const actual = crypto.scryptSync(currentPassword, Buffer.from(user.password_salt, "hex"), 64);
    const expected = Buffer.from(user.password_hash, "hex");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return res.status(401).json({ok:false,error:"Current password is incorrect."});
    }
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(newPassword, salt, 64);
    await pool.query(`UPDATE faculty_accounts SET password_salt=$2, password_hash=$3, must_change_password=FALSE, updated_at=NOW() WHERE email=$1`,
      [email, salt.toString("hex"), hash.toString("hex")]);
    return res.json({ok:true,message:"Password changed successfully."});
  } catch (e) {
    console.error("Password change failed:", e.message);
    return res.status(500).json({ok:false,error:"Could not change password. Please try again."});
  }
});

app.get("/api/faculty-accounts/counts", async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT school, department, COUNT(*)::int AS accounts
      FROM faculty_accounts WHERE active=TRUE GROUP BY school, department ORDER BY school, department`);
    res.json({ok:true, total:rows.reduce((n,r)=>n+r.accounts,0), groups:rows});
  } catch (e) { res.status(500).json({ok:false,error:e.message}); }
});

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

app.get("/api/papers", async (req, res) => {
  try {
    const viewerEmail = String(req.query.email || '').trim().toLowerCase();
    const viewerRole = String(req.query.role || '').trim().toUpperCase();
    const canSeeAll = viewerRole === 'COE' || viewerRole === 'MODERATOR';
    const { rows } = await pool.query(`
      SELECT id::text AS id, paper_no, title, school, program, department, semester,
             course, subject, faculty, exam, submission_date, status, expected,
             original_filename, file_mimetype, file_size, comments, moderation_details,
             owner_email, created_at, updated_at, (file_data IS NOT NULL OR file_path IS NOT NULL) AS has_file
      FROM papers
      WHERE ($1::boolean = TRUE) OR LOWER(COALESCE(owner_email,'')) = $2
      ORDER BY created_at DESC
    `, [canSeeAll, viewerEmail]);
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
      scheduleImport = await syncDatesheetScheduleFromPdf(extractedText, req.body.uploaded_by || 'COE', fileData);
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
    const extension = path.extname(filename).toLowerCase();
    const wordMimeTypes = {
      ".doc": "application/msword",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    };
    // Prefer the standards-based Word MIME type when older uploads were stored
    // with a generic or incorrect content type. Keep PDF and other types intact.
    const contentType = wordMimeTypes[extension] || p.file_mimetype || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
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

app.get('/api/papers/download-by-school.zip', async (req, res) => {
  try {
    const school = String(req.query.school || '').trim();
    const category = String(req.query.category || '').trim().toUpperCase();
    const statusGroups = {
      MODERATION_APPROVED: ['APPROVED','APPROVED_BY_MODERATOR','MODERATION_APPROVED'],
      CHANGES_REQUIRED: ['CHANGES_REQUIRED','CHANGES_REQUIRED_BY_MODERATOR'],
      FINAL_APPROVED: ['FINAL_APPROVED','FINAL_APPROVED_&_ARCHIVED','FINAL_APPROVED_AND_ARCHIVED']
    };
    const statuses = statusGroups[category];
    if (!school || !statuses) return res.status(400).send('A valid school and download category are required.');
    const { rows } = await pool.query(`
      SELECT id::text AS id, original_filename, file_path, file_data, course, subject, title
      FROM papers
      WHERE UPPER(REPLACE(COALESCE(status,''), ' ', '_')) = ANY($1::text[])
        AND LOWER(TRIM(COALESCE(school,''))) = LOWER(TRIM($2))
        AND (file_data IS NOT NULL OR file_path IS NOT NULL)
      ORDER BY created_at ASC
    `, [statuses, school]);
    const files = [];
    const used = new Set();
    for (const p of rows) {
      let data = p.file_data;
      if (!data && p.file_path && fs.existsSync(p.file_path)) data = fs.readFileSync(p.file_path);
      if (!data) continue;
      const base = String(p.original_filename || `${p.course || p.subject || p.title || 'question-paper'}-${p.id}.pdf`).replace(/[\\/:*?"<>|]/g, '_').trim() || `question-paper-${p.id}.pdf`;
      let name = `${String(p.id).padStart(5, '0')}_${base}`;
      let suffix = 1;
      while (used.has(name.toLowerCase())) name = `${String(p.id).padStart(5, '0')}_${suffix++}_${base}`;
      used.add(name.toLowerCase());
      files.push({name,data});
    }
    if (!files.length) return res.status(404).send('No downloadable papers found for this school and category.');
    const zip = makeZip(files);
    const safeSchool = school.replace(/[^a-z0-9_-]+/gi, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="QPMS_${category}_${safeSchool}_${new Date().toISOString().slice(0,10)}.zip"`);
    res.setHeader('Content-Length', zip.length);
    res.end(zip);
  } catch (e) { res.status(500).send(`Could not package papers: ${e.message}`); }
});

app.get('/api/papers/revised-by-school.zip', async (req, res) => {
  try {
    const school = String(req.query.school || '').trim();
    if (!school) return res.status(400).send('Please select a school.');
    const { rows } = await pool.query(`
      SELECT id::text AS id, original_filename, file_path, file_data, course, subject, title
      FROM papers
      WHERE UPPER(REPLACE(COALESCE(status,''), ' ', '_')) = 'RESUBMITTED_TO_COE'
        AND LOWER(TRIM(COALESCE(school,''))) = LOWER(TRIM($1))
        AND (file_data IS NOT NULL OR file_path IS NOT NULL)
      ORDER BY created_at ASC
    `, [school]);
    const files = [];
    const used = new Set();
    for (const p of rows) {
      let data = p.file_data;
      if (!data && p.file_path && fs.existsSync(p.file_path)) data = fs.readFileSync(p.file_path);
      if (!data) continue;
      const base = String(p.original_filename || `${p.course || p.subject || p.title || 'revised-paper'}-${p.id}.pdf`)
        .replace(/[\\/:*?"<>|]/g, '_').trim() || `revised-paper-${p.id}.pdf`;
      let name = `${String(p.id).padStart(5, '0')}_${base}`;
      let suffix = 1;
      while (used.has(name.toLowerCase())) name = `${String(p.id).padStart(5, '0')}_${suffix++}_${base}`;
      used.add(name.toLowerCase());
      files.push({ name, data });
    }
    if (!files.length) return res.status(404).send('No revised papers are available for this school.');
    const zip = makeZip(files);
    const safeSchool = school.replace(/[^a-z0-9_-]+/gi, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="QPMS_Revised_Papers_${safeSchool}_${new Date().toISOString().slice(0,10)}.zip"`);
    res.setHeader('Content-Length', zip.length);
    res.end(zip);
  } catch (e) { res.status(500).send(`Could not package revised papers: ${e.message}`); }
});

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
    if (!isAllowedQuestionPaperFile(f)) {
      try { fs.unlinkSync(f.path); } catch {}
      return res.status(400).json({ok:false,error:"Upload a PDF (.pdf), Word 97–2003 (.doc), or Word Document (.docx) question paper."});
    }
    await validatePaperDateAgainstSchedule(b);

    const { rows } = await pool.query(`
      INSERT INTO papers (
        paper_no, title, school, program, department, semester, course,
        subject, faculty, exam, submission_date, status, expected, owner_email, original_filename,
        stored_filename, file_path, file_mimetype, file_size, comments, file_data
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE(NULLIF($11,'')::timestamptz,NOW()),$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
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
      String(b.ownerEmail || '').trim().toLowerCase() || 'gunjan@mru.edu.in',
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
    if (!isAllowedQuestionPaperFile(req.file)) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ok:false,error:"Upload a PDF (.pdf), Word 97–2003 (.doc), or Word Document (.docx) question paper."});
    }
    const b = req.body || {};
    await validatePaperDateAgainstSchedule(b);
    const { rows } = await pool.query(`
      UPDATE papers SET
        title=COALESCE($2,title), program=COALESCE($3,program), department=COALESCE($4,department),
        semester=COALESCE($5,semester), course=COALESCE($6,course), subject=COALESCE($7,subject),
        faculty=COALESCE($8,faculty), exam=COALESCE($9,exam), status='RESUBMITTED_TO_COE',
        original_filename=$10, stored_filename=$11, file_path=$12, file_mimetype=$13, file_size=$14,
        file_data=$15, updated_at=NOW()
      WHERE id::text=$1 RETURNING *
    `, [
      String(req.params.id), b.title || null, b.program || null, b.department || null,
      b.semester || null, b.course || null, b.subject || null, b.faculty || null, b.exam || null,
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
  .then(() => app.listen(PORT, () => console.log(`QPMS server listening on ${PORT}`)))
  .catch(err => {
    console.error("Database initialization failed:", err);
    app.listen(PORT, () => console.log(`QPMS server listening on ${PORT} (DB unavailable)`));
  });
