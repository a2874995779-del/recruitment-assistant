import { z } from "zod";
import type { Job } from "./index.js";

export const jobMarkSchema = z.enum(["CONSIDERING", "INTERESTED", "CONTACTED", "REJECTED"]);
export type JobMark = z.infer<typeof jobMarkSchema>;
export const jobMarkLabels: Record<JobMark, string> = { CONSIDERING: "待考虑", INTERESTED: "优先查看", CONTACTED: "已手动沟通", REJECTED: "不合适" };
export const jobNoteSchema = z.string().max(2000);
export type SavedRefreshRecord = {status:'DONE'|'FAILED'|'STOPPED';last_attempt_at:string;last_success_at?:string;reason:string};
export type SavedRefreshState={running:boolean;total:number;checked:number;updated:number;failed:number;reason:string;items:{id:string;status:'DONE'|'FAILED'|'STOPPED';reason:string}[]};
export type JobFieldChange={field:'薪资'|'地点'|'学历'|'经验'|'职位描述'|'工作地址'|'标签';before:string;after:string};
export type JobChangeCheck={checked_at:string;status:'CHANGED'|'UNCHANGED';changes:JobFieldChange[]};
export type ManagedJob = Job & { greeting?:import('./greeting.js').GreetingRecord; personal_mark: JobMark; personal_note?:string; refresh?:SavedRefreshRecord; change_check?:JobChangeCheck; change_history?:JobChangeCheck[] };
export const savedJobQuerySchema=z.object({offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(200).default(50),search:z.string().max(200).default(''),company:z.string().max(200).default(''),city:z.string().max(100).default(''),personal_mark:jobMarkSchema.optional(),salary_period:z.enum(['MONTH','DAY']).optional(),salary_min:z.number().min(0).max(100000).optional(),salary_max:z.number().min(0).max(100000).optional(),sort:z.enum(['SAVED_DESC','SAVED_ASC','SALARY_DESC','SALARY_ASC']).default('SAVED_DESC')}).strict().refine(q=>q.salary_min===undefined || q.salary_max===undefined || q.salary_min<=q.salary_max,'薪资下限不能大于上限').refine(q=>!!q.salary_period || (q.salary_min===undefined && q.salary_max===undefined && !q.sort.startsWith('SALARY')),'按薪资筛选或排序需先选择日薪或月薪');
export type SavedJobQuery=z.infer<typeof savedJobQuerySchema>;
/** Explicit units only. Monthly values stay in K/month, daily in yuan/day. */
export function parseSavedSalary(raw:string|null):{period:'MONTH'|'DAY';min:number;max:number}|null {
  const text=(raw??'').normalize('NFKC').replace(/\s+/g,'');
  if(/[\uE000-\uF8FF]/.test(text))return null;
  const month=/^(\d+(?:\.\d+)?)K?[-~～—–至](\d+(?:\.\d+)?)K(?:[·•]\d+薪)?$/i.exec(text);
  const day=/^(?:每日|日薪|日结)?(\d+(?:\.\d+)?)[-~～—–至](\d+(?:\.\d+)?)(?:元\/(?:天|日)|元)?$/.exec(text);
  const match=month??((/元\/(?:天|日)|^(?:每日|日薪|日结)/.test(text))?day:null);
  if(!match)return null;
  const min=Number(match[1]),max=Number(match[2]);
  return min<=max?{period:month?'MONTH':'DAY',min,max}:null;
}
export const browserFilterSchema = z.object({ keyword: z.string().max(200), city: z.string().max(80), education: z.enum(["", "大专", "本科", "硕士", "博士", "学历不限"]), exclude: z.string().max(200) }).strict();
export const emptyBrowserFilter = { keyword: "", city: "", education: "", exclude: "" } as const;
