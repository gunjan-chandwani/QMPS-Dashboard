const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const pdfParse = require("pdf-parse");
const zlib = require("zlib");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
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

const databaseUrl = process.env.DATABASE_URL || "";
const isLocalDatabase = databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1") || databaseUrl.includes("[::1]");
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl && !isLocalDatabase ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000
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
  await pool.query(`ALTER TABLE papers ADD COLUMN IF NOT EXISTS exam_date DATE`);
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

// December 2026 End Semester source files contain some dates mistyped as 2029.
// Normalize for matching/import only; retain original COE documents unchanged.
function normalizeEndTerm2026Date(value, examType = 'End Semester') {
  const raw = String(value || '');
  if (!/end\s*(?:semester|term)/i.test(String(examType))) return raw;
  return raw.replace(/2029-12-(\d{2})/g, '2026-12-$1')
    .replace(/(\d{1,2}[.\/-]12[.\/-])2029/g, '$12026');
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
  const lines = String(pdfText || '').replace(/\r/g, '\n').split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const rows = [];
  let currentProgram = '';
  let currentSemester = '';
  let currentExam = 'Mid Semester';
  const dateRe = /(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/;
  const codeRe = /\b(?=[A-Z0-9.]*[A-Z])(?=[A-Z0-9.]*\d)[A-Z0-9.]{6,}\b/i;
  const isHeader = x => /^(date|timings?|course code|course name|manav rachna|schedule for|controller of examination|semester\s*[-:])/i.test(x);
  const cleanName = x => String(x || '').replace(dateRe, ' ').replace(codeRe, ' ').replace(/\d{1,2}\.\d{2}\s*(?:am|pm)?\s*[-–]\s*\d{1,2}\.\d{2}\s*(?:am|pm)?/ig, ' ').replace(/\s+/g, ' ').replace(/^[|: -]+|[|: -]+$/g, '').trim();
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
    if (/^(Bachelor|Master|B\.?\s?Tech|M\.?\s?Tech|BCA|MCA|MBA|BBA|LLB|LLM|B\.?\s?Sc|M\.?\s?Sc)/i.test(line) && !/course code|course name/i.test(line)) currentProgram = line;
    const cm = line.match(codeRe);
    if (!cm) continue;
    const code = cm[0].replace(/[.,;:]$/, '').toUpperCase();
    // Ignore headings/IDs and require a date on this line or the immediately adjacent line.
    let dateMatch = line.match(dateRe), dateLine = i;
    if (!dateMatch && i > 0) { dateMatch = lines[i-1].match(dateRe); dateLine = i-1; }
    if (!dateMatch && i+1 < lines.length) { dateMatch = lines[i+1].match(dateRe); dateLine = i+1; }
    if (!dateMatch) continue;
    const dd = String(dateMatch[1]).padStart(2,'0'), mm = String(dateMatch[2]).padStart(2,'0'), yyyy = dateMatch[3];
    const paperDate = normalizeEndTerm2026Date(`${yyyy}-${mm}-${dd}`, currentExam);
    let name = cleanName(line.replace(code, ''));
    if (!name || name.length < 3 || /^\d/.test(name)) {
      const candidates = [lines[i+1], lines[i-1], lines[i+2]].filter(Boolean).filter(x => !dateRe.test(x) && !codeRe.test(x) && !isHeader(x) && !/^(manav rachna|schedule for|controller of examination)/i.test(x));
      name = cleanName(candidates[0] || '');
    }
    if (!name || name.length < 3) name = code;
    const program = currentProgram || 'Unmapped Programme';
    // Academic ownership comes from the PDF programme heading, never the subject title.
    const low = program.toLowerCase();
    let department = /b\.?\s*sc\.?\s*b\.?\s*ed|b\.?\s*ed|education/i.test(low) ? 'Education & Humanities' : /robot|artificial intelligence/i.test(low) ? 'Robotics & AI' : /electronics|electrical|vlsi/i.test(low) ? 'Electronics & Communication' : /mechanical|manufacturing/i.test(low) ? 'Mechanical Engineering' : /computer science|csti|aiml|gen ai|quantum computing/i.test(low) ? 'Computer Science & Technology' : /law|llb|llm/i.test(low) ? 'Law' : /business|management|mba|bba/i.test(low) ? 'Business' : /education|itep|b\.ed/i.test(low) ? 'Education & Humanities' : /physics|chemistry|mathematics|science/i.test(low) ? 'Sciences' : 'Unmapped Department';
    const school = ['Computer Science & Technology','Robotics & AI','Electronics & Communication','Mechanical Engineering'].includes(department) ? 'School of Engineering' : department === 'Law' ? 'School of Law' : department === 'Business' ? 'School of Business' : department === 'Sciences' ? 'School of Sciences' : department === 'Education & Humanities' ? 'School of Education & Humanities' : 'Unmapped / Other';
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
  const submittedDate = normalizeEndTerm2026Date(isoMatch ? `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}` : rawSubmittedDate.slice(0, 10), exam);
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
  const scheduledDates = [...new Set(rows.map(r => normalizeEndTerm2026Date(r.paper_date, exam)).filter(Boolean))];
  if (scheduledDates.length && !scheduledDates.includes(submittedDate)) {
    const error = new Error(`Date mismatch: COE schedule record shows ${scheduledDates.join(', ')}. Please use the official date or ask COE to correct the schedule/PDF.`);
    error.statusCode = 400;
    throw error;
  }

  const variants = new Set(dateVariants(submittedDate));
  const codeNeedle = courseCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const evidence = [];
  // PDF text may merge date + time + code (07.12.202601.00PM5.0CH01O009),
  // or split combined codes over lines. Work from date-to-next-date spans.
  const datePattern = /(?:^|[^0-9])(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4}|\d{4}-\d{2}-\d{2})(?=\d{2}[.:]\d{2}|[^0-9]|$)/gm;
  const canonicalDate = value => {
    const m = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/.exec(value);
    return m ? `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}` : value;
  };
  // Support both ECH303C and 5.0CH01O009 (including wrapped combined codes).
  const codePattern = /\d+(?:\s*\.\s*\d+)?\s*[a-z]{2,5}\s*\d+\s*[a-z]\s*\d+|[a-z]{2,5}\s*\d{2,5}\s*[a-z]?/gi;
  for (const doc of documents) {
    const pdfText = normalizeEndTerm2026Date(doc.text || '', exam);
    const dates = [...pdfText.matchAll(datePattern)].map(m => ({
      date: canonicalDate(m[1]), index: m.index + m[0].indexOf(m[1]), length: m[1].length
    }));
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      if (date.date !== submittedDate) continue;
      const start = date.index + date.length;
      const end = Math.min(pdfText.length, start + 1400, dates[i + 1]?.index ?? pdfText.length);
      const row = pdfText.slice(start, end);
      const candidates = row.match(codePattern) || [];
      // pdf-parse often joins a time and course code without spaces:
      // e.g. "01.00PMEDH421B". A regex may read PMEDH421B as one token.
      // Also allow whitespace/newline splits within a course code, but only
      // inside the matching exam-date row (never across a different date).
      const compactRow = row.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const codePos = compactRow.indexOf(codeNeedle);
      const embeddedCode = codePos >= 0 &&
        (codePos + codeNeedle.length === compactRow.length ||
         !/[A-Z0-9]/.test(compactRow.charAt(codePos + codeNeedle.length)) ||
         // Following text may be a course title; the course code itself is exact.
         /[A-Z]/.test(compactRow.charAt(codePos + codeNeedle.length)));
      if (candidates.some(candidate => candidate.toUpperCase().replace(/[^A-Z0-9]/g, '') === codeNeedle) || embeddedCode) {
        evidence.push(doc);
        break;
      }
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

// Short-lived faculty sessions used for ownership-checked paper deletion.
const facultyDeleteSessions = new Map();
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
    const deleteToken = crypto.randomBytes(32).toString("hex");
    facultyDeleteSessions.set(deleteToken, { email, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
    return res.json({ok:true,deleteToken,user:{
      name:user.full_name, email:user.email, role:user.role, avatar:(user.full_name || "F").trim().charAt(0).toUpperCase(),
      dept:`${user.school} • ${user.department}`, schoolScope:user.school, departmentScope:user.department,
      departmentCode:user.department_code, mustChangePassword: user.must_change_password
    }});
  } catch (e) {
    console.error("Faculty login failed:", e.message);
    return res.status(500).json({ok:false,error:"Login service is temporarily unavailable. Please try again."});
  }
});

// COE-mediated faculty recovery. No SMTP or public reset tokens.
const resetAttempts = new Map();
const coeResetSessions = new Map();
const recoveryLimit = (map,key,ms) => {
  const now=Date.now(),last=map.get(key)||0;
  if(now-last<ms)return false;
  map.set(key,now);return true;
};
async function ensureRecoveryTable(){
  await pool.query(`CREATE TABLE IF NOT EXISTS faculty_password_reset_requests(
    id BIGSERIAL PRIMARY KEY,email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    reviewed_by TEXT
  )`);
}
app.post("/api/auth/forgot-password",async(req,res)=>{
  const email=String(req.body?.email||"").trim().toLowerCase();
  if(!email.includes("@")||!email.split("@")[1]?.includes(".")||email.includes(" "))
    return res.status(400).json({ok:false,error:"Enter a valid registered email."});
  const message="If your faculty account exists, a password reset request has been sent to COE. Contact COE to receive your temporary password securely.";
  if(!recoveryLimit(resetAttempts,email,60000))return res.json({ok:true,message});
  try{
    await ensureRecoveryTable();
    const user=await pool.query("SELECT email FROM faculty_accounts WHERE email=$1 AND active=TRUE AND role='FACULTY'",[email]);
    if(user.rowCount){
      await pool.query(`INSERT INTO faculty_password_reset_requests(email)
        SELECT $1 WHERE NOT EXISTS(SELECT 1 FROM faculty_password_reset_requests WHERE email=$1 AND status='PENDING')`,[email]);
    }
    return res.json({ok:true,message});
  }catch(e){console.error("Recovery request failed:",e.message);return res.status(500).json({ok:false,error:"Could not submit request. Contact COE."});}
});
// COE approval requires a server-side secret, never the client-side COE role.
app.post("/api/coe/reset-admin-login", (req,res)=>{
  const configured=String(process.env.COE_RESET_ADMIN_PASSWORD||"");
  const password=String(req.body?.password||"");
  if(configured.length<12)return res.status(503).json({ok:false,error:"COE reset approval is not configured on server."});
  const a=crypto.createHash("sha256").update(password).digest(),b=crypto.createHash("sha256").update(configured).digest();
  if(!crypto.timingSafeEqual(a,b))return res.status(401).json({ok:false,error:"Invalid COE approval password."});
  const token=crypto.randomBytes(32).toString("hex");
  coeResetSessions.set(token,Date.now()+30*60*1000);
  res.json({ok:true,token});
});
function authorizedCoeReset(req,res){
  const token=String(req.headers["x-coe-reset-token"]||"");
  const expiry=coeResetSessions.get(token);
  if(!expiry||expiry<Date.now()){res.status(401).json({ok:false,error:"COE approval session expired. Authenticate again."});return false;}
  return true;
}
app.get("/api/coe/password-reset-requests",async(req,res)=>{
  if(!authorizedCoeReset(req,res))return;
  try{
    await ensureRecoveryTable();
    const {rows}=await pool.query(`SELECT r.id,r.email,r.requested_at,f.full_name,f.department,f.school
      FROM faculty_password_reset_requests r JOIN faculty_accounts f ON f.email=r.email
      WHERE r.status='PENDING' ORDER BY r.requested_at DESC LIMIT 200`);
    res.json({ok:true,requests:rows});
  }catch(e){res.status(500).json({ok:false,error:"Unable to load requests."});}
});
app.post("/api/coe/password-reset-requests/:id/approve",async(req,res)=>{
  if(!authorizedCoeReset(req,res))return;
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({ok:false,error:"Invalid request."});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const {rows}=await client.query("SELECT email FROM faculty_password_reset_requests WHERE id=$1 AND status='PENDING' FOR UPDATE",[id]);
    if(!rows.length){await client.query("ROLLBACK");return res.status(404).json({ok:false,error:"Request already handled."});}
    const temporaryPassword=crypto.randomBytes(18).toString("base64url");
    const salt=crypto.randomBytes(16);
    const hash=crypto.scryptSync(temporaryPassword,salt,64);
    const updated=await client.query(`UPDATE faculty_accounts SET password_salt=$2,password_hash=$3,
      must_change_password=TRUE,updated_at=NOW() WHERE email=$1 AND active=TRUE AND role='FACULTY'`,
      [rows[0].email,salt.toString("hex"),hash.toString("hex")]);
    if(!updated.rowCount)throw new Error("Faculty account inactive.");
    await client.query("UPDATE faculty_password_reset_requests SET status='APPROVED',reviewed_at=NOW(),reviewed_by='COE' WHERE id=$1",[id]);
    await client.query("COMMIT");
    res.json({ok:true,email:rows[0].email,temporaryPassword,message:"Share this temporary password privately after verifying faculty identity. It will not be shown again."});
  }catch(e){await client.query("ROLLBACK");console.error("COE reset approval failed:",e.message);res.status(500).json({ok:false,error:"Approval failed."});}
  finally{client.release();}
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
             course, subject, faculty, exam, submission_date, TO_CHAR(exam_date,'YYYY-MM-DD') AS exam_date, status, expected,
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
  let uploadClient;
  try {
    const b = req.body || {};
    const f = req.file;
    if (!f) return res.status(400).json({ok:false,error:"Please attach the question paper PDF."});
    if (!isAllowedQuestionPaperFile(f)) {
      try { fs.unlinkSync(f.path); } catch {}
      return res.status(400).json({ok:false,error:"Upload a PDF (.pdf), Word 97–2003 (.doc), or Word Document (.docx) question paper."});
    }
    let programs;
    try { programs = b.programs ? JSON.parse(b.programs) : [b.program]; }
    catch { return res.status(400).json({ok:false,error:'Invalid programme selection.'}); }
    if (!Array.isArray(programs) || !programs.length || programs.length > 30 || programs.some(p => typeof p !== 'string' || !p.trim()))
      return res.status(400).json({ok:false,error:'Select between 1 and 30 valid programmes.'});
    programs = [...new Set(programs.map(p => p.trim()))];
    // Validate every selected programme against the official datesheet before writing anything.
    for (const program of programs) await validatePaperDateAgainstSchedule({...b, program});

    // One upload per course code per exam session across ALL faculty and
    // specializations. Keep existing records intact; block only NEW duplicates.
    // Multiple selected programmes share the same single paper record.
    const ownerEmail = String(b.ownerEmail || '').trim().toLowerCase() || 'gunjan@mru.edu.in';
    const normalizedCourse = String(b.course || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const examKey = v => /end\\s*(?:semester|term)/i.test(v || '') ? 'end semester' : /mid\\s*(?:semester|term)/i.test(v || '') ? 'mid semester' : String(v || '').trim().toLowerCase();
    const normalizedExam = examKey(b.exam);
    if (!normalizedCourse || !normalizedExam) {
      if (f?.path) { try { fs.unlinkSync(f.path); } catch {} }
      return res.status(400).json({ok:false,error:'Course code and exam session are required.'});
    }
    uploadClient = await pool.connect();
    await uploadClient.query('BEGIN');
    const lockKey = [normalizedCourse, normalizedExam].join('|');
    await uploadClient.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['qpms-one-paper-per-course', lockKey]);
    const existing = await uploadClient.query(`
      SELECT id, owner_email, status FROM papers
      WHERE UPPER(REGEXP_REPLACE(COALESCE(course,''), '[^A-Za-z0-9]', '', 'g')) = $1
        AND (CASE WHEN LOWER(COALESCE(exam,'')) ~ 'end[[:space:]]*(semester|term)' THEN 'end semester'
                  WHEN LOWER(COALESCE(exam,'')) ~ 'mid[[:space:]]*(semester|term)' THEN 'mid semester'
                  ELSE LOWER(TRIM(COALESCE(exam,''))) END) = $2
      ORDER BY id DESC LIMIT 1
    `, [normalizedCourse, normalizedExam]);
    if (existing.rows.length) {
      await uploadClient.query('ROLLBACK');
      uploadClient.release(); uploadClient = null;
      if (f?.path) { try { fs.unlinkSync(f.path); } catch {} }
      return res.status(409).json({ok:false,
        error:`Course code ${b.course} already has a question paper uploaded for this exam session (paper #${existing.rows[0].id}). Only one paper is allowed across all specializations. Contact COE if it needs revision.`});
    }
    const created = [];
    const program = programs[0];
    const { rows } = await uploadClient.query(`
      INSERT INTO papers (
        paper_no, title, school, program, department, semester, course,
        subject, faculty, exam, submission_date, exam_date, status, expected, owner_email, original_filename,
        stored_filename, file_path, file_mimetype, file_size, comments, file_data
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE(NULLIF($11,'')::timestamptz,NOW()),NULLIF($22,'')::date,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *
    `, [
      b.paper_no || null,
      b.title || b.subject || "Question Paper",
      b.school || null,
      program,
      b.department || null,
      b.semester || null,
      b.course || null,
      b.subject || null,
      b.faculty || null,
      b.exam || null,
      null, // submission timestamp is generated by PostgreSQL NOW(); exam date is validated separately
      b.status || "Submitted to COE",
      b.expected === undefined ? true : String(b.expected) !== "false",
      ownerEmail,
      f?.originalname || null,
      f?.filename || null,
      f?.path || null,
      f?.mimetype || null,
      f?.size || null,
      b.comments || null,
      f ? fs.readFileSync(f.path) : null,
      String(b.paperDate || b.paper_date || b.exam_date || b.submission_date || '').slice(0,10)
    ]);

    created.push(rows[0]);
    await uploadClient.query('COMMIT');
    uploadClient.release(); uploadClient = null;
    res.status(201).json({ ok: true, paper: created[0], papers: created });
  } catch (e) {
    if (uploadClient) { try { await uploadClient.query('ROLLBACK'); } catch {} uploadClient.release(); }
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
        file_data=$15, exam_date=NULLIF($16,'')::date, updated_at=NOW()
      WHERE id::text=$1 RETURNING *
    `, [
      String(req.params.id), b.title || null, b.program || null, b.department || null,
      b.semester || null, b.course || null, b.subject || null, b.faculty || null, b.exam || null,
      req.file.originalname, req.file.filename, req.file.path, req.file.mimetype,
      req.file.size, fs.readFileSync(req.file.path),
      String(b.paperDate || b.paper_date || b.exam_date || b.submission_date || '').slice(0,10)
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
    const token = String(req.headers["x-faculty-delete-token"] || "");
    const session = facultyDeleteSessions.get(token);
    if (!token || !session || session.expiresAt < Date.now()) {
      return res.status(401).json({ok:false,error:"Please log in again before deleting a paper."});
    }
    const client = await pool.connect();
    let deleted;
    try {
      await client.query("BEGIN");
      const found = await client.query(
        "SELECT id, owner_email, status, moderation_details, file_path FROM papers WHERE id::text=$1 FOR UPDATE",
        [req.params.id]
      );
      if (!found.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ok:false,error:"Paper not found"});
      }
      const paper = found.rows[0];
      if (String(paper.owner_email || "").trim().toLowerCase() !== session.email) {
        await client.query("ROLLBACK");
        return res.status(403).json({ok:false,error:"You can delete only your own uploaded paper."});
      }
      const status = String(paper.status || "").trim().toUpperCase().replace(/[ -]+/g,"_");
      if (!["SUBMITTED_TO_COE","SUBMITTED","UPLOADED"].includes(status) || paper.moderation_details != null) {
        await client.query("ROLLBACK");
        return res.status(409).json({ok:false,error:"Deletion is allowed only before the paper enters moderation."});
      }
      await client.query("DELETE FROM papers WHERE id=$1", [paper.id]);
      await client.query("COMMIT");
      deleted = paper;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    if (deleted.file_path && fs.existsSync(deleted.file_path)) {
      try { fs.unlinkSync(deleted.file_path); } catch (err) { console.warn("Could not remove deleted paper file:",err.message); }
    }
    return res.json({ok:true});
  } catch (e) {
    res.status(500).json({ok:false,error:"Could not delete paper. Please contact the administrator."});
  }
});

// Keep frontend files served by the same Render service.
app.use(express.static(__dirname));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Start HTTP independently of database migrations so the portal never remains
// unreachable just because an existing PostgreSQL table is locked.
const server = app.listen(PORT, () => {
  console.log(`QPMS server listening on ${PORT}`);
});
server.on("error", err => console.error("QPMS HTTP startup failed:", err));

initDb()
  .then(() => console.log("QPMS database initialization completed."))
  .catch(err => console.error("Database initialization failed:", err));
