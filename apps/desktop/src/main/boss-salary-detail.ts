import { browserJobSchema, type BrowserJob } from '../../../../packages/contracts/src/boss-browser.js';
import { enrichBrowserJob } from './boss-response.js';

export const needsSalary = (job: BrowserJob) => !job.salary.trim() || /[\uE000-\uF8FF]/.test(job.salary);
const sameText = (a: string, b: string) => a.normalize('NFKC').replace(/\s+/g, '').toLowerCase() === b.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
/** A user-requested refresh must observe salary and city anew, even when unchanged. */
export function mergeFreshDetail(job:BrowserJob,detail:BrowserJob|null,source:'DETAIL_DOM'|'DETAIL_RESPONSE',observed_at:string):BrowserJob|null {
  if(!detail || job.url!==detail.url || !sameText(job.title,detail.title) || !sameText(job.company,detail.company) || needsSalary(detail) || !detail.location.trim())return null;
  return browserJobSchema.parse({...job,salary:detail.salary,location:detail.location,education:detail.education||job.education,experience:detail.experience||job.experience,tags:detail.tags.length?detail.tags:job.tags,detail:detail.detail,salary_ocr:undefined,detail_response:undefined,salary_detail:{source,original:job.salary,observed_at}});
}
/** Fill only missing fields; keep each original list observation date. */
export function mergeVerifiedDetail(job:BrowserJob,detail:BrowserJob|null,source:'DETAIL_DOM'|'DETAIL_RESPONSE',observed_at:string):BrowserJob|null {
  if(!detail || job.url!==detail.url || !sameText(job.title,detail.title) || !sameText(job.company,detail.company))return null;
  const salaryChanged=needsSalary(job) && !needsSalary(detail);
  const merged:BrowserJob={...job,location:job.location || detail.location,education:job.education || detail.education,experience:job.experience || detail.experience,
    ...(salaryChanged?{salary:detail.salary,salary_ocr:undefined,salary_detail:{source,original:job.salary,observed_at}}:{}),
    ...(!job.detail?.description && detail.detail?{detail:detail.detail}:{})};
  if(merged.salary===job.salary && merged.location===job.location && merged.education===job.education && merged.experience===job.experience && merged.detail===job.detail)return null;
  return browserJobSchema.parse(merged);
}
export function mergeSalaryDetail(job: BrowserJob, detail: BrowserJob | null, source: 'DETAIL_DOM' | 'DETAIL_RESPONSE', observed_at: string): BrowserJob | null {
  if (!detail || job.url !== detail.url || !sameText(job.title, detail.title) || !sameText(job.company, detail.company)) return null;
  if (needsSalary(detail) || !/\d/.test(detail.salary)) return null;
  const { salary_ocr, ...original } = job;
  const merged = source === 'DETAIL_RESPONSE' ? enrichBrowserJob(original, detail) : {
    ...original, salary: detail.salary, location: detail.location || job.location, education: detail.education || job.education,
    experience: detail.experience || job.experience, ...(detail.detail ? { detail: detail.detail } : {}),
  };
  // Never claim a source whose salary was not actually adopted.
  if (merged.salary !== detail.salary) return null;
  return browserJobSchema.parse({ ...merged, salary_detail: { source, original: job.salary, observed_at } });
}

export function parseDetailDom(raw: unknown, observed_at: string): BrowserJob | null {
  const schema = browserJobSchema.omit({ detail: true, salary_ocr: true }).extend({ description: browserJobSchema.shape.detail.unwrap().shape.description, address: browserJobSchema.shape.detail.unwrap().shape.address }).strict();
  const result = schema.safeParse(raw);
  if (!result.success) return null;
  const { description, address, ...fields } = result.data;
  return { ...fields, detail: { description, address, observed_at } };
}
