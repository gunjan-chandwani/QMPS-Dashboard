// Read-only December 2026 upload reconciliation. Does not modify database.
require('dotenv').config();
const fs=require('fs'),{Pool}=require('pg');
const url=process.env.DATABASE_URL||'';
const local=/localhost|127\.0\.0\.1/i.test(url);
const pool=new Pool({connectionString:url,ssl:local?false:{rejectUnauthorized:false}});
const norm=x=>String(x??'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const code=x=>String(x??'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const sem=x=>String(x??'').match(/\d+/)?.[0]||'';
const date=x=>x instanceof Date?x.toISOString().slice(0,10):String(x??'').slice(0,10);
const csv=x=>'"'+String(x??'').replace(/"/g,'""')+'"';
(async()=>{
 const [sr,pr]=await Promise.all([
 pool.query("SELECT id,course_code,course_name,program,school,department,semester,exam_type,paper_date FROM datesheet_schedule WHERE paper_date BETWEEN DATE '2026-12-01' AND DATE '2026-12-31' AND exam_type ILIKE '%end%' ORDER BY id"),
 pool.query("SELECT id,course,title,program,school,department,semester,exam,status,exam_date,owner_email FROM papers ORDER BY id")
 ]);
 const schedules=sr.rows, papers=pr.rows.filter(p=>/end/i.test(p.exam||''));
 const out=papers.map(p=>{
  const exact=schedules.filter(s=>code(s.course_code)===code(p.course)&&sem(s.semester)===sem(p.semester));
  const byCode=schedules.filter(s=>code(s.course_code)===code(p.course));
  const exactProgramme=exact.filter(s=>norm(s.program)===norm(p.program));
  const sameDate=exact.filter(s=>date(s.paper_date)===date(p.exam_date));
  return {paperId:p.id,course:p.course,semester:p.semester,programme:p.program,examDate:date(p.exam_date),status:p.status,courseCodeExists:byCode.length,courseSemesterCandidates:exact.length,exactProgrammeCandidates:exactProgramme.length,sameExamDateCandidates:sameDate.length,officialScheduleIds:exact.map(s=>s.id).join(';'),officialProgrammes:[...new Set(exact.map(s=>s.program))].join(' | '),officialExamDates:[...new Set(exact.map(s=>date(s.paper_date)))].join(' | '),issue:!byCode.length?'COURSE_CODE_NOT_IN_DEC_DATESHEET':!exact.length?'SEMESTER_MISMATCH':exactProgramme.length?'EXACT_PROGRAMME_AVAILABLE':sameDate.length?'PROGRAMME_LABEL_DIFFERS_DATE_MATCH':'PROGRAMME_AND_DATE_REVIEW'};
 });
 const headers=Object.keys(out[0]||{});
 fs.writeFileSync('coe_dec2026_reconciliation_detail.csv',[headers.join(','),...out.map(row=>headers.map(h=>csv(row[h])).join(','))].join('\r\n'),'utf8');
 const summary={scheduled:schedules.length,allPaperRecords:pr.rows.length,endTermPapers:papers.length,issues:out.reduce((a,r)=>(a[r.issue]=(a[r.issue]||0)+1,a),{}),output:'coe_dec2026_reconciliation_detail.csv',readOnly:true};
 console.log(JSON.stringify(summary,null,2));
 await pool.end();
})().catch(async e=>{console.error(e.message);await pool.end();process.exitCode=1});
