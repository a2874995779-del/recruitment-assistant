import { z } from "zod";
import { browserJobSchema, containsKeyword, evaluateBrowserJob, type BrowserJob } from "./boss-browser.js";

import { searchConfigSchema, type BossSearchConfig } from "./boss-search-config.js";
export * from "./boss-search-config.js";
export const searchAdvanceSchema=z.object({action:z.enum(['SCROLL','NEXT_PAGE','END','UNSUPPORTED','SECURITY']),moved:z.boolean(),at_end:z.boolean(),top:z.number().min(0).max(10000000),max:z.number().min(0).max(10000000),cards:z.number().int().min(0).max(10000),target:z.string().max(200),reason:z.string().max(300)}).strict();
export type SearchAdvance=z.infer<typeof searchAdvanceSchema>;
export const searchPairSchema=z.object({city:z.string(),keyword:z.string(),status:z.enum(["WAITING","RUNNING","STALLED","LIMIT","BLOCKED","FAILED","STOPPED","END"]),rounds:z.number().int().min(0),seen:z.number().int().min(0),reason:z.string().max(300),advance:searchAdvanceSchema.optional()}).strict();
export const searchResultSchema=z.object({job:browserJobSchema,observed_at:z.iso.datetime({offset:true}),queries:z.array(z.string().max(100)).max(12),discovery:z.enum(['NEW','SEEN']).optional(),first_read_at:z.iso.datetime({offset:true}).optional(),verification:z.object({status:z.enum(['DONE','FAILED','BLOCKED']),reason:z.string().max(300),observed_at:z.iso.datetime({offset:true})}).strict().optional()}).strict();
export const searchRunSchema=z.object({id:z.string().uuid(),config:searchConfigSchema,started_at:z.iso.datetime({offset:true}),finished_at:z.iso.datetime({offset:true}).nullable(),
  status:z.enum(["RUNNING","PARTIAL","STOPPED","INTERRUPTED"]),pairs:z.array(searchPairSchema).max(12),results:z.array(searchResultSchema).max(2000),reason:z.string().max(300),
  salary_progress:z.object({total:z.number().int().min(0).max(2000),checked:z.number().int().min(0).max(50),updated:z.number().int().min(0).max(50),failed:z.number().int().min(0).max(50),running:z.boolean(),reason:z.string().max(300)}).strict().optional(),
  active_pair:z.number().int().min(0).max(11).optional(),
  detail_progress:z.object({total:z.number().int().min(0).max(2000),checked:z.number().int().min(0).max(50),updated:z.number().int().min(0).max(50),failed:z.number().int().min(0).max(50),running:z.boolean(),reason:z.string().max(300)}).strict().optional(),
  activity:z.enum(['SCAN','VERIFY']).optional(),skipped_saved:z.number().int().min(0).optional(),
  skipped_processed:z.number().int().min(0).optional(),
  segment:z.object({number:z.number().int().min(1),started_at:z.iso.datetime({offset:true}),previous_total:z.number().int().min(0).max(2000),added:z.number().int().min(0).max(2000),refreshed:z.number().int().min(0).max(2000)}).strict().optional(),
}).strict();
export type BossSearchRun=z.infer<typeof searchRunSchema>;
export type BossSearchResult=z.infer<typeof searchResultSchema>;
const normalized=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
function internship(job:BrowserJob):'YES'|'NO'|'UNKNOWN'{
  const fields=[job.title,job.experience,...job.tags].map(normalized);
  if(fields.some(value=>/非实习|不招实习|不接受实习|不提供实习|正式岗位|全职岗位|仅限全职/.test(value)))return 'NO';
  if(/实习|\bintern(?:ship)?\b/.test(normalized(job.title)))return 'YES';
  if([job.experience,...job.tags].map(normalized).some(value=>/^(?:(?:岗位|职位|招聘|工作)类型\s*[:：]?\s*)?(?:实习|实习生|实习岗位|实习岗|实习职位|在校实习|intern|internship)$/.test(value)))return 'YES';
  if(/\d+\s*[-~至]?\s*\d*\s*年/.test(job.experience) || job.tags.some(value=>/^(全职|正式员工)$/.test(value)))return 'NO';
  return 'UNKNOWN';
}
function keywordEvaluation(job:BrowserJob,keyword:string){
  const query=normalized(keyword),requiresIntern=/实习|\bintern(?:ship)?\b/.test(query);
  const terms=query.replace(/实习生?|\bintern(?:ship)?\b/g,' ').match(/[a-z0-9+#.]+|[\u4e00-\u9fff]+/g)??[];
  // Company names and unrelated mentions in a description are not job-direction evidence.
  const fields=[job.title,...job.tags].map(normalized);
  const missing=terms.filter(term=>!fields.some(field=>containsKeyword(field,term)));
  if(missing.length)return {status:'EXCLUDED' as const,reason:`岗位方向不符：缺少 ${missing.join('、')}`};
  const kind=requiresIntern?internship(job):'YES';
  return kind==='NO'?{status:'EXCLUDED' as const,reason:'岗位类型不符：不是实习岗位'}:kind==='UNKNOWN'?{status:'UNKNOWN' as const,reason:'关键词要求实习，但岗位未明确实习类型'}:{status:'MATCH' as const,reason:''};
}
export const needsSearchVerification=(job:BrowserJob,config:BossSearchConfig)=>!job.salary.trim() || /[\uE000-\uF8FF]/.test(job.salary) || !job.location.trim() || (!!config.education && !job.education.trim()) || (config.experience!=='ALL' && !job.experience.trim()) || (config.experience==='INTERN' && internship(job)==='UNKNOWN');
export function evaluateSearchJob(job:BrowserJob,config:BossSearchConfig){
  const base=evaluateBrowserJob(job,{keyword:"",city:config.cities.join("；"),education:config.education,exclude:config.exclude});
  const excluded=base.status==="EXCLUDED"?[...base.reasons]:[],unknown=base.status==="UNKNOWN"?[...base.reasons]:[];
  const keywords=config.keywords.map(keyword=>keywordEvaluation(job,keyword));
  if(!keywords.some(value=>value.status==='MATCH')){
    const pending=keywords.find(value=>value.status==='UNKNOWN');
    if(pending)unknown.push(pending.reason);else excluded.push([...new Set(keywords.map(value=>value.reason))].join('；'));
  }
  if(config.experience!=="ALL"){
    const value=job.experience.trim();
    if(config.experience==="INTERN"){
      const kind=internship(job);
      if(kind==='NO')excluded.push('岗位类型不符：不是实习岗位');
      else if(kind==='UNKNOWN')unknown.push('实习类型待核实：应届、在校或经验不限不等于实习');
    }else if(!/应届|经验不限|不限经验|在校/.test(value)){
      if(/\d+\s*[-~至]?\s*\d*\s*年/.test(value))excluded.push(`经验不符：${value}`);
      else unknown.push("应届或经验不限条件待核实");
    }
  }
  if(config.salary_min!==null || config.salary_max!==null){
    const raw=job.salary_ocr?.confirmed?job.salary_ocr.candidate:job.salary;
    const match=config.salary_period==='DAY'?/^\s*(?:每日|日薪|日结)?\s*(\d+(?:\.\d+)?)\s*[-~至–—]\s*(\d+(?:\.\d+)?)\s*(?:元\s*(?:\/\s*天|\/\s*日|每天|每日)|元)?\s*$/.exec(raw):/^\s*(\d+(?:\.\d+)?)\s*[Kk]?\s*[-~至–—]\s*(\d+(?:\.\d+)?)\s*[Kk](?:\s*(?:\/月|·\d+薪))?\s*$/.exec(raw);
    const dailyUnit=config.salary_period!=='DAY' || /每日|日薪|日结|\/\s*[天日]|每天/.test(raw);
    if(!match || !dailyUnit)unknown.push(config.salary_period==='DAY'?"日薪区间待核实，不换算月薪或年薪":"薪资区间待核实，不换算日薪或年薪");
    else if(Number(match[1])>Number(match[2]))unknown.push("薪资区间格式异常");
    else if((config.salary_min!==null && Number(match[2])<config.salary_min) || (config.salary_max!==null && Number(match[1])>config.salary_max))excluded.push(`薪资区间不相交：${raw}`);
  }
  return {status:excluded.length?"EXCLUDED" as const:unknown.length?"UNKNOWN" as const:"MATCH" as const,reasons:[...excluded,...unknown]};
}
