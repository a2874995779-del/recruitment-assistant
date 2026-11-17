import { z } from 'zod';

export const greetingTextSchema=z.string().trim().min(1,'请先填写招呼语').max(500,'招呼语最多 500 字');
export const greetingConfigSchema=z.object({template:greetingTextSchema}).strict();
export const defaultGreeting={template:'您好，我对贵公司的{岗位}岗位很感兴趣，想进一步了解岗位要求，期待与您沟通。'};
export type GreetingRecord={status:'PENDING'|'SENT'|'UNKNOWN'|'FAILED';text:string;attempted_at:string;reason:string};
export function renderGreeting(template:string,job:{title:string;company_name:string}){
  const text=template.replace(/\{(岗位|公司)\}/g,(_,key:string)=>key==='岗位'?job.title:job.company_name);
  return greetingTextSchema.parse(text);
}
