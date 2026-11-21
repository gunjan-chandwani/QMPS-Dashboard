// Detailed read-only reconciliation: never edits database tables.
require('dotenv').config();
const fs=require('fs'); const {Pool}=require('pg');
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:false});
const code=x=>String(x||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const sem=x=>String(x||'').match(/\d+/)?.[0]||'';
const norm=x=>String(x||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const esc=x=>'"'+String(x??'').replace(/"/g,'""')+'"';
(async()=>{
 const client=await pool.connect();
 try{
  const [a,b]=await Promise.all([
   client.query("SELECT id,course_code,course_name,program,school,department,semester,exam_type,paper_date FROM datesheet_schedule WHERE paper_date BETWEEN DATE '2026-12-01' AND DATE '2026-12-31' AND exam_type ILIKE '%end%' ORDER BY id"),
   client.query("SELECT id,course,title,program,school,department,semester,exam,status,exam_date,owner_email FROM papers ORDER BY id")
  ]);
  const papers=b.rows;const schedules=a.rows;
  const end=papers.filter(p=>/end/i.test(p.exam||''));
  const sameCodeSem=p=>schedules.filter(s=>code(s.course_code)===code(p.course)&&sem(s.semester)===sem(p.semester));
  const report=papers.map(p=>{
   const candidates=sameCodeSem(p);
   const exactProgram=candidates.filter(s=>norm(s.program)===norm(p.program));
   const sameDate=candidates.filter(s=>s.paper_date&&p.exam_date&&String(s.paper_date).slice(0,10)===String(p.exam_date).slice(0,10));
   return {id:p.id,course:p.course,semester:p.semester,exam:p.exam,program:p.program,school:p.school,department:p.department,examDate:p.exam_date,status:p.status,codeSemesterCandidates:candidates.length,exactProgrammeCandidates:exactProgram.length,sameDateCandidates:sameDate.length,scheduleIds:candidates.map(s=>s.id).join(';'),classification:!(/end/i.test(p.exam||''))?'EXAM_LABEL_NOT_END':!candidates.length?'NO_COURSE_SEMESTER_CANDIDATE':exactProgram.length===1?'EXACT_PROGRAMME_CANDIDATE':exactProgram.length>1?'MULTIPLE_EXACT_PROGRAMME_CANDIDATES':'PROGRAMME_REVIEW_REQUIRED'};
  });
  const counts=report.reduce((o,r)=>(o[r.classification]=(o[r.classification]||0)+1,o),{});
  const headers=Object.keys(report[0]||{});
  fs.writeFileSync('coe_upload_mapping_audit.csv',[headers.join(','),...report.map(r=>headers.map(h=>esc(r[h])).join(','))].join('\r\n'),'utf8');
  const summary={scheduled:schedules.length,allUploadedRecords:papers.length,endTermRecords:end.length,byClassification:counts,reportFile:'coe_upload_mapping_audit.csv',warning:'Candidates only, not final matches; separate B.A.LL.B occurrences preserved'};
  fs.writeFileSync('coe_upload_mapping_audit_summary.json',JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary,null,2));console.log('READ ONLY: no database records changed.');
 }finally{client.release();await pool.end()}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
