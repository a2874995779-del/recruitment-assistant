import { z } from "zod";
import { containsKeyword, evaluateBrowserJob, type BrowserJob } from "./boss-browser.js";

export const matchingPreferencesSchema = z.object({
  enabled:z.boolean(),title:z.string().max(200),city:z.string().max(80),skills:z.string().max(300),exclude:z.string().max(200),
}).strict();
export type MatchingPreferences = z.infer<typeof matchingPreferencesSchema>;
export const emptyMatchingPreferences: MatchingPreferences = {enabled:false,title:"",city:"",skills:"",exclude:""};
const words = (s:string) => [...new Set(s.normalize("NFKC").toLowerCase().split(/[\s,，;；、]+/).filter(Boolean))];
export type JobMatch = {score:number|null;coverage:number;excluded:boolean;reasons:string[]};
// A transparent keyword score, not a hiring probability. Unknown evidence cannot earn points.
export function scoreBrowserJob(job:BrowserJob, preferences:MatchingPreferences):JobMatch {
  let total=0,earned=0,known=0;
  const reasons:string[]=[];
  const add=(weight:number,status:"YES"|"NO"|"UNKNOWN",reason:string)=>{total+=weight;if(status!=="UNKNOWN")known+=weight;if(status==="YES")earned+=weight;reasons.push(reason);};
  const titles=words(preferences.title);
  if(titles.length) {const hit=titles.filter(word=>containsKeyword(job.title,word));add(50,hit.length?"YES":"NO",hit.length?`岗位名称命中：${hit.join("、")}`:`岗位名称未命中：${titles.join("、")}`);}
  if(preferences.city.trim()) {
    const location=job.location || job.detail?.address || "";
    const result=evaluateBrowserJob({...job,location},{keyword:"",city:preferences.city,education:"",exclude:""});
    add(20,result.status==="MATCH"?"YES":result.status==="UNKNOWN"?"UNKNOWN":"NO",result.status==="MATCH"?`地区符合：${location}`:result.reasons.join("；"));
  }
  const fields=[job.title,job.company,job.location,job.experience,...job.tags,job.detail?.description ?? "",job.detail?.address ?? ""];
  const skills=words(preferences.skills);
  for(const skill of skills) {
    const hit=fields.some(field=>containsKeyword(field,skill));
    const complete=!!job.detail?.description;
    add(30/skills.length,hit?"YES":complete?"NO":"UNKNOWN",hit?`技能词命中：${skill}`:complete?`详情未命中技能词：${skill}`:`技能词待核实：${skill}（尚未读取职位描述）`);
  }
  const exclusions=words(preferences.exclude), blocked=exclusions.filter(word=>fields.some(field=>containsKeyword(field,word)));
  if(blocked.length)reasons.push(`命中排除词：${blocked.join("、")}`);
  else if(exclusions.length)reasons.push(job.detail?.description?"已读字段未命中排除词":"排除词待核实：尚未读取职位描述");
  return {score:total?Math.round(earned/total*100):null,coverage:total?Math.round(known/total*100):0,excluded:!!blocked.length,reasons};
}
