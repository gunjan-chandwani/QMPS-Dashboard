// Safe, read-only PDF layout parser for December 2026 COE End Term schedule.
// Creates JSON and CSV preview; never updates any database tables.
const fs = require('fs');
const pdf = require('pdf-parse');
const filename = process.argv[2] || 'EndTerm_Dec2026_Original.pdf';
const months = {FIRST:'1st',SECOND:'2nd',THIRD:'3rd',FOURTH:'4th',FIFTH:'5th',SIXTH:'6th',SEVENTH:'7th',EIGHTH:'8th',NINTH:'9th',TENTH:'10th'};
const dateRe = /\b(\d{2})[.\/-](\d{2})[.\/-](20\d{2})\b/;
const codeRe = /(?:\d+(?:\.\d+)?[A-Z]{2,5}\d+[A-Z]\d+|[A-Z]{2,5}\d{2,5}[A-Z]?)(?![0-9])/i;
const isHeading = s => /^(?:Bachelor|Master|B\.?\s?Tech|M\.?\s?Tech|B\.?\s?Sc|M\.?\s?Sc|B\.?\s?A\.?|M\.?\s?A\.?|BBA|MBA|MCA|BCA|LLB|LLM|B\.?\s?Ed)/i.test(s.trim());
const clean = s => String(s||'').replace(/\s+/g,' ').trim();
const esc = v => '"'+String(v??'').replace(/"/g,'""')+'"';
function owner(program) {
  const s=program.toLowerCase();
  const department = /b\.?\s*sc\.?\s*b\.?\s*ed|b\.?\s*a\.?\s*b\.?\s*ed|b\.?\s*ed|education|itep/.test(s)?'Education & Humanities':
    /robotics|robot|artifical intelligence/.test(s)?'Robotics & AI':
    /electronics|electrical|vlsi/.test(s)?'Electronics & Communication':
    /mechanical|manufacturing|automation/.test(s)?'Mechanical Engineering':
    /computer science|csti|aiml|gen ai|quantum computing|full stack/.test(s)?'Computer Science & Technology':
    /law|llb|llm|l\\.?l\\.?b/.test(s)?'Law':
    /business|management|mba|bba/.test(s)?'Business':
    /chemistry|physics|mathematics|m\.?\s*sc|science/.test(s)?'Sciences':'Unmapped Department';
  const school = ['Computer Science & Technology','Robotics & AI','Electronics & Communication','Mechanical Engineering'].includes(department)?'School of Engineering':
    department==='Law'?'School of Law':department==='Business'?'School of Business':
    department==='Sciences'?'School of Sciences':department==='Education & Humanities'?'School of Education & Humanities':'Unmapped / Other';
  return {school,department};
}
if(!fs.existsSync(filename)){console.error('Missing PDF:',filename);process.exit(1)}
const pages=[];
pdf(fs.readFileSync(filename),{
  pagerender:async page=>{
    const tc=await page.getTextContent({normalizeWhitespace:false,disableCombineTextItems:false});
    pages.push({number:page.pageNumber,items:tc.items.filter(i=>i.str&&i.str.trim()).map(i=>({text:clean(i.str),x:i.transform[4],y:i.transform[5]}))});
    return '';
  }
}).then(()=>{
  const rows=[]; const warnings=[]; let sem='',lastSection='';
  for(const page of pages){
    const groups=new Map();
    for(const item of page.items){
      const y=Math.round(item.y/3)*3;
      if(!groups.has(y))groups.set(y,[]);
      groups.get(y).push(item);
    }
    const lines=[...groups.entries()].sort((a,b)=>b[0]-a[0]).map(([y,items])=>({
      y,items:items.sort((a,b)=>a.x-b.x),
      get text(){return clean(this.items.map(i=>i.text).join(' '))}
    }));
    const header=lines.map(l=>l.text).find(t=>/SEMESTER\s*[-:]\s*(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH)/i.test(t));
    if(header){const m=header.match(/SEMESTER\s*[-:]\s*(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH)/i);sem=months[m[1].toUpperCase()]}
    let program=''; let sectionStart=-1; let sectionCount=0;
    for(let i=0;i<lines.length;i++){
      const l=lines[i],t=l.text;
      if(isHeading(t)){
        program=t;sectionStart=i;sectionCount=0;
        // Some headings wrap to a second line (e.g. CSE specializations).
        for(let j=i+1;j<Math.min(lines.length,i+3);j++){
          const next=lines[j].text;
          if(/^(DATE|Timings|Course Code)/i.test(next)||dateRe.test(next)||isHeading(next))break;
          if(lines[j].y>=l.y-24 && next.length>5 && !/MANAV RACHNA|CONTROLLER|SCHEDULE/i.test(next)){
            program+=' '+next;i=j;
          }
        }
        lastSection=program;
        continue;
      }
      const date=t.match(dateRe);
      if(!date)continue;
      // Only actual course rows: date appears in the left-most column.
      const dateItem=l.items.find(x=>dateRe.test(x.text));
      if(!dateItem||dateItem.x>125||!program||!sem)continue;
      const courseItems=l.items.filter(x=>x.x>=240 && x.x<400);
      // Some PDF rows put code on a line below date, or in same text item as title.
      let code='',codeLine=i;
      // Match codes by their actual PDF x/y coordinates. Text baselines can be
      // slightly above or below the date, including split EDH307C / MAH301C.
      const nearby=lines.map((v,k)=>({v,k}))
        .filter(({v,k})=>Math.abs(v.y-l.y)<=12 && (k===i || !dateRe.test(v.text)))
        .sort((a,b)=>Math.abs(a.v.y-l.y)-Math.abs(b.v.y-l.y));
      for(const {v:candidate,k:j} of nearby){
        if(isHeading(candidate.text)||/^DATE\b/i.test(candidate.text))continue;
        const codeText=candidate.items.filter(x=>x.x>=235 && x.x<320).map(x=>x.text).join(' ');
        const found=codeText.match(codeRe);
        if(found){code=found[0].toUpperCase();codeLine=j;break}
      }
      if(!code){warnings.push('Page '+page.number+' y='+l.y+' date '+date[0]+': code not found');continue}
      let title='';
      const ci=lines[codeLine].items;
      const codeItem=ci.find(x=>x.text.toUpperCase().includes(code));
      if(codeItem){
        const after=codeItem.text.slice(codeItem.text.toUpperCase().indexOf(code)+code.length);
        title=clean(after+' '+ci.filter(x=>x.x>codeItem.x+10).map(x=>x.text).join(' '));
      }
      if(!title){
        const titleItems=lines[codeLine].items.filter(x=>x.x>=310 && !x.text.toUpperCase().includes(code));
        title=clean(titleItems.map(x=>x.text).join(' '));
      }
      if(!title && codeLine+1<lines.length && !dateRe.test(lines[codeLine+1].text) && !isHeading(lines[codeLine+1].text))
        title=clean(lines[codeLine+1].items.filter(x=>x.x>=300).map(x=>x.text).join(' '));
      const paperDate=date[3]+'-'+date[2]+'-'+date[1];
      if(paperDate<'2026-12-01'||paperDate>'2026-12-31'){warnings.push('Out-of-scope PDF date page '+page.number+' y='+l.y+': '+paperDate+' code '+code);continue}
      const {school,department}=owner(program);
      rows.push({page:page.number,program,semester:sem,courseCode:code,courseName:title,school,department,examType:'End Semester',paperDate});
      sectionCount++;
    }
  }
  const keys=new Set();const duplicates=[];
  for(const r of rows){const k=[r.program,r.semester,r.courseCode,r.paperDate].join('|');if(keys.has(k))duplicates.push(k);keys.add(k)}
  fs.writeFileSync('datesheet_layout_preview.json',JSON.stringify({rows,warnings,duplicates},null,2));
  const cols=['page','program','semester','courseCode','courseName','school','department','examType','paperDate'];
  fs.writeFileSync('datesheet_layout_preview.csv',[cols.join(','),...rows.map(r=>cols.map(c=>esc(r[c])).join(','))].join('\r\n'));
  console.log('PDF pages:',pages.length,'Extracted rows:',rows.length,'Missing-code warnings:',warnings.length,'Duplicate keys:',duplicates.length);
  console.log('Programme sections:',new Set(rows.map(r=>r.page+'|'+r.program)).size);
  console.log('Sample rows:',JSON.stringify(rows.slice(0,6),null,2));
  console.log('Saved datesheet_layout_preview.csv and datesheet_layout_preview.json (READ ONLY)');
}).catch(e=>{console.error(e.stack||e.message);process.exitCode=1});
