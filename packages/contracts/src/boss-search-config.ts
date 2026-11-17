import { z } from "zod";
export const searchCities={武汉:"101200100",北京:"101010100",上海:"101020100",深圳:"101280600",广州:"101280100",杭州:"101210100"} as const;
export const searchConfigSchema=z.object({
  keywords:z.array(z.string().trim().min(1).max(60)).min(1).max(6).transform(words=>words.filter((word,index)=>words.findIndex(candidate=>candidate.normalize('NFKC').toLowerCase()===word.normalize('NFKC').toLowerCase())===index)),
  cities:z.array(z.enum(["武汉","北京","上海","深圳","广州","杭州"])).min(1).max(3),
  education:z.enum(["","大专","本科","硕士","博士","学历不限"]),
  experience:z.enum(["ALL","GRADUATE","INTERN"]),exclude:z.string().max(200),
  salary_min:z.number().min(0).max(100000).nullable(),salary_max:z.number().min(0).max(100000).nullable(),rounds:z.number().int().min(1).max(30),
  salary_enrichment:z.boolean().default(true),
  salary_period:z.enum(['MONTH','DAY']).default('MONTH'),
  skip_saved:z.boolean().default(true),
  skip_processed:z.boolean().default(true),
}).strict().refine(v=>v.salary_period==='DAY' || (v.salary_min ?? 0)<=500 && (v.salary_max ?? 0)<=500,'月薪最多 500K').refine(v=>v.cities.length*v.keywords.length<=12,"每轮最多 12 个城市与关键词组合")
  .refine(v=>v.salary_min===null || v.salary_max===null || v.salary_min<=v.salary_max,"薪资下限不能大于上限");
export type BossSearchConfig=z.infer<typeof searchConfigSchema>;
export const defaultSearchConfig:BossSearchConfig={keywords:["Java"],cities:["武汉"],education:"",experience:"GRADUATE",exclude:"",salary_min:null,salary_max:null,rounds:15,salary_enrichment:true,salary_period:'MONTH',skip_saved:true,skip_processed:true};
export const searchPresetSchema=z.object({id:z.string().uuid(),name:z.string().trim().min(1).max(60),config:searchConfigSchema,updated_at:z.iso.datetime({offset:true})}).strict();
export const searchPresetInput=z.object({id:z.string().uuid().optional(),name:z.string().trim().min(1).max(60),config:searchConfigSchema}).strict();
export type SearchPreset=z.infer<typeof searchPresetSchema>;
/** Processing applies only to the same search criteria; scan budgets and read preferences are excluded. */
export function searchCriteriaKey(config:BossSearchConfig){
  const words=(values:string[])=>[...new Set(values.map(v=>v.normalize('NFKC').trim().toLowerCase()))].sort();
  return JSON.stringify({filter_version:2,keywords:words(config.keywords),cities:words(config.cities),education:config.education,experience:config.experience,exclude:config.exclude.normalize('NFKC').trim().toLowerCase(),salary_period:config.salary_period,salary_min:config.salary_min,salary_max:config.salary_max});
}
export function bossSearchUrl(city:keyof typeof searchCities,keyword:string):string {
  const url=new URL("https://www.zhipin.com/web/geek/jobs");url.searchParams.set("city",searchCities[city]);url.searchParams.set("query",keyword);return url.href;
}

/** Tracking parameters and URL encoding can change during normal SPA navigation. */
export function sameBossSearch(actualUrl:string,expectedUrl:string):boolean {
  try {
    const actual=new URL(actualUrl),expected=new URL(expectedUrl);
    if(actual.protocol!=="https:" || actual.hostname!=="www.zhipin.com" || actual.username || actual.password || actual.port || actual.pathname.replace(/\/$/,"")!=="/web/geek/jobs")return false;
    if(expected.protocol!=="https:" || expected.hostname!==actual.hostname || expected.pathname.replace(/\/$/,"")!==actual.pathname.replace(/\/$/,""))return false;
    const query=(url:URL)=>(url.searchParams.get("query") ?? "").normalize("NFKC").trim().toLowerCase();
    return actual.searchParams.getAll("city").length===1 && actual.searchParams.getAll("query").length===1 && actual.searchParams.get("city")===expected.searchParams.get("city") && query(actual)===query(expected) && !!query(expected);
  }catch{return false;}
}
