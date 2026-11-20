// December 2026 End Semester datesheet staging and controlled replacement.
// Default mode is READ ONLY. --apply requires explicit confirmation after backup.
// Does not write to papers, faculty_accounts, coe_notices or moderation tables.
require('dotenv').config();
const fs=require('fs');
const {Pool}=require('pg');
const crypto=require('crypto');
const source='datesheet_layout_preview.json';
if(!fs.existsSync(source))throw Error('Run datesheet-layout-preview.js first');
const data=JSON.parse(fs.readFileSync(source,'utf8'));
const rows=data.rows||[];
const normalize=x=>String(x||'').trim().toUpperCase().replace(/\s+/g,' ');
const key=r=>[normalize(r.courseCode),normalize(r.program),normalize(r.semester),normalize(r.examType),r.paperDate].join('|');
const unique=new Map(rows.map(r=>[key(r),r]));
// Repeated B.A.LL.B entries are distinct expected question papers (confirmed by COE).
// Preserve each physical PDF row; never deduplicate during import.
const issues=[];
if(rows.length!==359)issues.push('Expected 359 preview occurrences, found '+rows.length);
if(unique.size!==342)issues.push('Expected 342 distinct course/date keys, found '+unique.size);
if(rows.some(r=>r.school==='Unmapped / Other'||!r.school||!r.department||!r.program||r.program==='MANAV RACHNA UNIVERSITY'))issues.push('Unmapped or invalid programme');
if(rows.some(r=>!/^2026-12-\d{2}$/.test(r.paperDate)||!/end/i.test(r.examType)))issues.push('Date or exam out of scope');
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:!/(localhost|127\.0\.0\.1|\[::1\])/.test(process.env.DATABASE_URL||'')?{rejectUnauthorized:false}:false});
(async()=>{
const client=await pool.connect();
try{
const before=await client.query("SELECT COUNT(*)::int AS n FROM datesheet_schedule WHERE paper_date BETWEEN DATE '2026-12-01' AND DATE '2026-12-31' AND exam_type ILIKE '%end%'");
const uploads=await client.query('SELECT COUNT(*)::int AS n FROM papers');
const summary={mode:process.argv.includes('--apply')?'APPLY':'PREVIEW',existingDecemberEndRows:before.rows[0].n,allPapers:uploads.rows[0].n,extractedOccurrences:rows.length,uniqueEntries:unique.size,expectedPaperEntries:rows.length,repeatedSeparatePapers:rows.length-unique.size,issues};
console.log(JSON.stringify(summary,null,2));
if(!process.argv.includes('--apply')){console.log('READ ONLY. No changes made.');return}
if(issues.length)throw Error('Refusing apply: '+issues.join('; '));
if(process.env.QPMS_CONFIRM_DATE_REPLACE!=='YES_BACKUP_DEC2026')throw Error('Refusing apply: set QPMS_CONFIRM_DATE_REPLACE=YES_BACKUP_DEC2026 after review');
const backup='datesheet_schedule_backup_'+new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14)+'_'+crypto.randomBytes(3).toString('hex');
await client.query('BEGIN');
try{
await client.query('LOCK TABLE datesheet_schedule IN SHARE ROW EXCLUSIVE MODE');
await client.query('CREATE TABLE '+backup+' AS SELECT * FROM datesheet_schedule');
const deleted=await client.query("DELETE FROM datesheet_schedule WHERE paper_date BETWEEN DATE '2026-12-01' AND DATE '2026-12-31' AND exam_type ILIKE '%end%'");
for(const r of rows){
await client.query('INSERT INTO datesheet_schedule (course_name,course_code,school,department,program,semester,exam_type,paper_date,faculty_name,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,NULL,$9)',[r.courseName||r.courseCode,r.courseCode,r.school,r.department,r.program,r.semester,'End Semester',r.paperDate,'LAYOUT_IMPORT_DEC2026']);
}
const after=await client.query("SELECT COUNT(*)::int AS n FROM datesheet_schedule WHERE paper_date BETWEEN DATE '2026-12-01' AND DATE '2026-12-31' AND exam_type ILIKE '%end%'");
const paperCheck=await client.query('SELECT COUNT(*)::int AS n FROM papers');
if(after.rows[0].n!==rows.length||paperCheck.rows[0].n!==uploads.rows[0].n)throw Error('Post-import count verification failed');
await client.query('COMMIT');
console.log(JSON.stringify({applied:true,backupTable:backup,oldDecemberEndRowsDeleted:deleted.rowCount,newDecemberEndRows:after.rows[0].n,allPapersUnchanged:paperCheck.rows[0].n},null,2));
}catch(e){await client.query('ROLLBACK');throw e}
}finally{client.release();await pool.end()}
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});
