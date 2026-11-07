#!/usr/bin/env node
/**
 * Prepare Chart Beat before publication, never on a visitor request.
 *
 * Required to rewrite drafts with an LLM:
 *   EDITORIAL_API_KEY=... EDITORIAL_MODEL=... node scripts/build-chart-beat.mjs
 *
 * By default drafts go to data/chart-beat-drafts.json for editorial fact review.
 * PUBLISH=1 writes data/chart-beat-editorial.json; publish only after reviewing.
 * CHART_DATE=YYYY-MM-DD selects a historical chart week (default: latest).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const workbook='1t6_7SOlspmNYrXq8PSfJ74frIdrWwQBFITQ3bQmRzeg';
const sheet=(gid)=>'https://docs.google.com/spreadsheets/d/'+workbook+'/gviz/tq?tq=select%20*&tqx=out:csv&gid='+gid;
const configs={
  hot100:{gid:'904867620',title:'Daegon 100',entity:'Song',chartLink:'/chart/daegon-100/'},
  top100Albums:{gid:'1940039611',title:'Top 100 Albums',entity:'Album',chartLink:'/chart/daegon-albums-100/'},
  artists:{gid:'1568177610',title:'Artist 50',entity:'Artist',chartLink:'/chart/daegon-artists-50/'}
};
const limit=Math.max(1,Math.min(3,Number(process.env.ARTICLE_LIMIT||3)));
function parseCSV(s){
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<s.length;i++){
    const ch=s[i];
    if(ch==='"'){
      if(quoted&&s[i+1]==='"'){field+='"';i++} else quoted=!quoted;
    }else if(ch===','&&!quoted){row.push(field);field=''}
    else if((ch==='\n'||ch==='\r')&&!quoted){
      if(ch==='\r'&&s[i+1]==='\n')i++;
      row.push(field);field='';
      if(row.some(x=>x!==''))rows.push(row);
      row=[];
    }else field+=ch;
  }
  row.push(field);if(row.some(x=>x!==''))rows.push(row);
  return rows;
}
const norm=v=>String(v??'').trim().toLowerCase();
function getDate(value){
  const m=String(value||'').match(/^(\d\d?)\/(\d\d?)\/(\d{4})$/);
  return m?m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0'):String(value||'').slice(0,10);
}
function displayDate(iso){const [y,m,d]=iso.split('-');return d+'/'+m+'/'+y}
function toNumber(v){
  let s=String(v??'').replace(/[^\d.,-]/g,'');
  if(!s)return 0;
  // Google Sheet's 1.000 means one thousand; commas are decimals.
  if(/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(s))s=s.replace(/\./g,'');
  s=s.replace(',','.');
  return Number(s)||0;
}
function parseChart(rows,conf){
  const h=rows[0].map(norm);
  const ix=(...keys)=>h.findIndex(x=>keys.includes(x));
  const idx={date:ix('date','chart date'),rank:ix('rank'),name:ix(norm(conf.entity)),artist:ix('artist'),
    diff:ix('dif'),weeks:ix('weeks'),peak:ix('peak'),no1:ix('weeks at #1'),units:ix('units'),sales:ix('sales'),streams:ix('streams','streaming')};
  if(idx.date<0||idx.rank<0||idx.name<0)throw new Error('Cannot parse '+conf.title+' headers');
  const parsed=rows.slice(1).map(r=>({
    date:getDate(r[idx.date]),rank:toNumber(r[idx.rank]),
    name:r[idx.name]||'',artist:idx.artist<0?'':r[idx.artist]||'',
    diff:idx.diff<0?'':r[idx.diff]||'',weeks:idx.weeks<0?0:toNumber(r[idx.weeks]),
    peak:idx.peak<0?0:toNumber(r[idx.peak]),
    weeksAt1:idx.no1<0?0:toNumber(r[idx.no1]),
    units:idx.units<0?null:toNumber(r[idx.units]),
    sales:idx.sales<0?null:toNumber(r[idx.sales]),
    streams:idx.streams<0?null:toNumber(r[idx.streams])
  })).filter(r=>r.date&&r.name&&r.rank>0);
  parsed.sort((a,b)=>a.date.localeCompare(b.date)||a.rank-b.rank);
  return parsed;
}
function focusHistory(all,focus,date){
  const artist=norm(focus.artist||focus.name),title=norm(focus.name);
  const earlier=all.filter(r=>r.date<=date&&norm(r.artist||r.name)===artist);
  const same=earlier.filter(r=>norm(r.name)===title);
  const leaders=earlier.filter(r=>r.rank===1);
  const uniqueTitles=[...new Set(leaders.map(x=>x.name))];
  const first=same[0];
  const priorNo1=[...leaders].reverse().slice(0,10).map(x=>({date:x.date,name:x.name}));
  return {
    entity:focus.name,artist:focus.artist||focus.name,firstChartDate:first?.date??null,
    totalChartWeeksForTitle:same.length,bestRankForTitle:Math.min(...same.map(r=>r.rank)),
    weeksAtNo1ForTitle:same.filter(r=>r.rank===1).length,
    artistNo1WeeksThroughDate:leaders.length,
    distinctArtistNo1TitlesThroughDate:uniqueTitles.length,
    priorNo1,previousChartAppearances:same.slice(-8).map(x=>({date:x.date,rank:x.rank}))
  };
}
function buildEvidence(all,conf,iso){
  const prior=all.filter(r=>r.date<=iso);
  const dates=[...new Set(prior.map(r=>r.date))];
  const current=prior.filter(r=>r.date===iso).sort((a,b)=>a.rank-b.rank);
  if(!current.length)throw new Error('No weekly data for '+conf.title+' on '+iso);
  const previousDate=dates.at(-2);
  const previous=prior.filter(r=>r.date===previousDate);
  const at=(r)=>previous.find(p=>norm(p.name)===norm(r.name)&&norm(p.artist)===norm(r.artist));
  const biggestMove=current.map(x=>({entry:x,previousRank:at(x)?.rank??null,gain:(at(x)?.rank??x.rank)-x.rank}))
    .filter(x=>x.previousRank!==null).sort((a,b)=>b.gain-a.gain).slice(0,5);
  const focus=current[0];
  return {
    CHART:conf.title,CHART_DATE:iso,PREVIOUS_CHART_DATE:previousDate,
    CURRENT_WEEK:current.slice(0,15),
    PRIOR_WEEK:previous.slice(0,10),
    NOTABLE_GAINS:biggestMove,
    HISTORICAL_EVIDENCE:{
      chartExistsSince:'2017-06-24',
      leader:focusHistory(prior,focus,iso),
      standout:biggestMove.length?focusHistory(prior,biggestMove[0].entry,iso):null,
      otherTopFive:current.slice(1,5).map(e=>focusHistory(prior,e,iso))
    },
    VERIFIED_EXTERNAL_CONTEXT:[],
    DATA_RULE:'No comparisons to other charts, no unsourced release histories, and no later-than-article-date facts.'
  };
}
async function generateArticle(prompt,evidence,conf){
  const key=process.env.EDITORIAL_API_KEY;
  const model=process.env.EDITORIAL_MODEL;
  if(!key||!model)throw new Error('Set EDITORIAL_API_KEY and EDITORIAL_MODEL to generate editorial drafts');
  const endpoint=process.env.EDITORIAL_API_URL||'https://api.openai.com/v1/chat/completions';
  const response=await fetch(endpoint,{
    method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
    body:JSON.stringify({model,temperature:0.35,response_format:{type:'json_object'},messages:[
      {role:'system',content:prompt},{role:'user',content:JSON.stringify(evidence)}
    ]})
  });
  if(!response.ok)throw new Error('Editorial API HTTP '+response.status+': '+(await response.text()).slice(0,300));
  const body=await response.json();
  const parsed=JSON.parse(body?.choices?.[0]?.message?.content||'{}');
  if(!parsed.headline||!parsed.text||!parsed.subtitle)throw new Error('Editorial model returned an incomplete article');
  return {key:Number(evidence.CHART_DATE.replace(/-/g,''))*10+Number(Object.keys(configs).indexOf(Object.keys(configs).find(k=>configs[k]===conf)))+1,
    date:displayDate(evidence.CHART_DATE),title:String(parsed.headline),subtitle:String(parsed.subtitle),
    artist:evidence.CURRENT_WEEK[0]?.artist||evidence.CURRENT_WEEK[0]?.name||'',image:'',
    chartLink:conf.chartLink+evidence.CHART_DATE,text:String(parsed.text),factual_checks:parsed.factual_checks||[]};
}
async function main(){
  const prompt=await fs.readFile('prompts/chart-beat-editorial-v2.md','utf8');
  const existingPath='data/chart-beat-editorial.json';
  let published={version:2,posts:{hot100:[],top100Albums:[],artists:[]}};
  try{published=JSON.parse(await fs.readFile(existingPath,'utf8'))}catch{}
  const drafts={version:2,generatedAt:new Date().toISOString(),posts:{}};
  for(const [key,conf] of Object.entries(configs).slice(0,limit)){
    const r=await fetch(sheet(conf.gid));
    if(!r.ok)throw Error('Sheet HTTP '+r.status+' for '+conf.title);
    const all=parseChart(parseCSV(await r.text()),conf);
    const dates=[...new Set(all.map(x=>x.date))];
    const iso=process.env.CHART_DATE||dates.at(-1);
    const evidence=buildEvidence(all,conf,iso);
    const article=await generateArticle(prompt,evidence,conf);
    drafts.posts[key]=[article];
    console.log(key+': '+article.title);
  }
  if(process.env.PUBLISH==='1'){
    for(const [key,articles] of Object.entries(drafts.posts)){
      published.posts[key]=[...articles,...(published.posts[key]||[]).filter(x=>!articles.some(a=>a.date===x.date))];
    }
    published.generatedAt=drafts.generatedAt;
    await fs.mkdir(path.dirname(existingPath),{recursive:true});
    await fs.writeFile(existingPath,JSON.stringify(published,null,2)+'\n');
    console.log('Published editorial JSON to '+existingPath);
  }else{
    const draftPath='data/chart-beat-drafts.json';
    await fs.writeFile(draftPath,JSON.stringify(drafts,null,2)+'\n');
    console.log('Drafts saved for human fact-checking: '+draftPath);
  }
}
main().catch(e=>{console.error(e);process.exitCode=1});
