// Read-only COE December 2026 dashboard reconciliation. Does not change PostgreSQL.
require('dotenv').config();
const fs=require('fs');
const {Pool}=require('pg');
const file='datesheet_layout_preview.json';
if(!fs.existsSync(file)){console.error('Missing '+file+'; run node datesheet-layout-preview.js first');process.exit(1)}
const preview=JSON.parse(fs.readFileSync(file,'utf8'));
const norm=x=>String(x||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const sem=x=>{const m=String(x||'').match(/\d+/);return m?m[0]:''};
const exam=x=>/end\\s*(semester|term)/i.test(String(x||''))?'END':'OTHER';
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:false});
(async()=>{
const client=await pool.connect();
try{
const [schedule,papers]=await Promise.all([
client.query("SELECT id,course_code,program,school,department,semester,exam_type,paper_date FROM datesheet_schedule WHERE paper_date BETWEEN DATE '2026-12-01' AND DATE '2026-12-31' AND (exam_type ILIKE '%end%')"),
client.query("SELECT id,course,program,school,department,semester,exam,status,exam_date FROM papers WHERE exam ILIKE '%end%'")
]);
const keys=new Map();
for(const r of preview.rows){const key=[norm(r.courseCode),sem(r.semester),norm(r.program),r.paperDate].join('|');keys.set(key,(keys.get(key)||0)+1)}
const unique=[...keys.keys()];
const byCode=new Map();
for(const p of papers.rows){const k=[norm(p.course),sem(p.semester)].join('|');if(!byCode.has(k))byCode.set(k,[]);byCode.get(k).push(p)}
const ambiguous=[],matched=[],notMatched=[];
for(const r of preview.rows){const k=[norm(r.courseCode),sem(r.semester)].join('|');const candidates=byCode.get(k)||[];
if(candidates.length===1)matched.push({courseCode:r.courseCode,programme:r.program,paperId:candidates[0].id});
else if(candidates.length>1)ambiguous.push({courseCode:r.courseCode,semester:r.semester,paperIds:candidates.map(p=>p.id)});
else notMatched.push({courseCode:r.courseCode,semester:r.semester,program:r.program});
}
const report={generatedAt:new Date().toISOString(),database:{decEndScheduleRows:schedule.rowCount,endTermPapers:papers.rowCount},preview:{rows:preview.rows.length,uniqueKeys:unique.length,duplicateOccurrences:preview.rows.length-unique.length,unmapped:preview.rows.filter(r=>r.school==='Unmapped / Other').length},courseSemesterOnly:{candidateRows:matched.length,ambiguousRows:ambiguous.length,notMatchedRows:notMatched.length,NOTE:'Diagnostic only; NOT validated programme/exam matching or final dashboard counts'},examples:{ambiguous:ambiguous.slice(0,30),notMatched:notMatched.slice(0,30)}};
fs.writeFileSync('coe_dashboard_reconciliation.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({database:report.database,preview:report.preview,courseSemesterOnly:report.courseSemesterOnly},null,2));
console.log('Saved coe_dashboard_reconciliation.json (READ ONLY). No tables modified.');
}finally{client.release();await pool.end()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
