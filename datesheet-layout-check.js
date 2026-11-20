// Read-only diagnostic for the original COE PDF. Does not modify PostgreSQL.
const fs = require('fs');
const pdf = require('pdf-parse');
const filename = process.argv[2] || 'EndTerm_Dec2026_Original.pdf';
if (!fs.existsSync(filename)) { console.error('PDF not found:', filename); process.exit(1); }
const pages = [];
const options = {
  pagerender: async page => {
    const tc = await page.getTextContent({normalizeWhitespace:false, disableCombineTextItems:false});
    const items = tc.items.filter(x=>x.str && x.str.trim()).map(x=>({
      text:x.str.trim(),
      x:Math.round(x.transform[4]*10)/10,
      y:Math.round(x.transform[5]*10)/10
    }));
    pages.push({page:page.pageNumber,items});
    return items.map(x=>x.text).join(' ');
  }
};
pdf(fs.readFileSync(filename),options).then(()=>{
  fs.writeFileSync('datesheet_layout.json',JSON.stringify(pages,null,2));
  const lines=[];
  for (const page of pages) {
    lines.push('=== PAGE '+page.page+' ===');
    const grouped = new Map();
    for (const item of page.items) {
      const key=Math.round(item.y/3)*3;
      if (!grouped.has(key)) grouped.set(key,[]);
      grouped.get(key).push(item);
    }
    const sorted=[...grouped.entries()].sort((a,b)=>b[0]-a[0]);
    for (const [y,items] of sorted) {
      const line=items.sort((a,b)=>a.x-b.x).map(i=>'['+i.x+']'+i.text).join(' ');
      if (/SEMESTER|BACHELOR|MASTER|B\.\s?TECH|BBA|MBA|M\.SC|B\.SC|LLB|DATE|COURSE|\d{1,2}\.12\.2026/i.test(line))
        lines.push('y='+y+' '+line);
    }
  }
  fs.writeFileSync('datesheet_layout_report.txt',lines.join('\r\n'));
  console.log('Read',pages.length,'pages. Saved datesheet_layout_report.txt and datesheet_layout.json');
  console.log('First 25 report lines:');
  console.log(lines.slice(0,25).join('\n'));
}).catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
