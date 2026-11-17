import {greetingTextSchema} from './greeting.js';
import { z } from "zod";
import { jobMarkSchema, type JobMark } from "./job-management.js";
import { searchConfigSchema } from "./boss-search-config.js";
import type { BossSearchRun } from "./boss-search.js";
import type { SavedRefreshState } from './job-management.js';

export const BOSS_HOME = "https://www.zhipin.com/web/geek/jobs";
export function allowedBossUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && !u.port &&
      (u.hostname === "zhipin.com" || u.hostname.endsWith(".zhipin.com"));
  } catch { return false; }
}
export function canonicalBossJob(raw: string): string | null {
  try {
    const u = new URL(raw, BOSS_HOME);
    if (u.hostname !== "www.zhipin.com" || !allowedBossUrl(u.href) || !/^\/job_detail\/[A-Za-z0-9_-]{8,200}\.html$/.test(u.pathname)) return null;
    return `https://www.zhipin.com${u.pathname}`;
  } catch { return null; }
}
const supportedCityPaths = new Set(["wuhan", "beijing", "shanghai", "shenzhen", "guangzhou", "hangzhou", "suzhou", "chengdu", "chongqing", "tianjin", "nanjing", "xian", "changsha", "zhengzhou", "hefei", "fuzhou", "wuxi", "dongguan", "ningbo", "qingdao", "jinan", "shenyang"]);
export function canReadBossJobs(raw: string): boolean {
  if (!allowedBossUrl(raw)) return false;
  const u = new URL(raw);
  if (u.hostname !== "www.zhipin.com") return false;
  const path = u.pathname.replace(/\/$/, "");
  return ["", "/web/geek/jobs", "/web/geek/job"].includes(path) || supportedCityPaths.has(path.slice(1));
}
export type BossPageKind = "JOBS" | "DETAIL" | "SECURITY" | "LOGIN" | "OTHER";
export function bossPageKind(raw: string): BossPageKind {
  if (!allowedBossUrl(raw)) return "OTHER";
  const u = new URL(raw);
  if (/\/passport\/(?:zp\/)?security(?:\.html)?\/?$/.test(u.pathname) || /\/captcha(?:\/|\.|$)/.test(u.pathname)) return "SECURITY";
  if (/\/passport(?:\/|$)/.test(u.pathname) || /^\/web\/user\/?$/.test(u.pathname) || /^\/login\/?$/.test(u.pathname)) return "LOGIN";
  if (canReadBossJobs(raw)) return "JOBS";
  if (canonicalBossJob(raw)) return "DETAIL";
  return "OTHER";
}
export const browserJobSchema = z.object({
  url: z.string().refine(v => canonicalBossJob(v) === v),
  title: z.string().min(1).max(200), company: z.string().min(1).max(200),
  salary: z.string().max(200), location: z.string().max(100),
  education: z.string().max(40), experience: z.string().max(200),
  tags: z.array(z.string().max(100)).max(20),
  detail_response: z.object({salary:z.string().max(200),location:z.string().max(100),education:z.string().max(40),experience:z.string().max(200),observed_at:z.iso.datetime({offset:true})}).strict().optional(),
  detail: z.object({description:z.string().max(20000),address:z.string().max(100),observed_at:z.iso.datetime({offset:true})}).strict().optional(),
  salary_ocr: z.object({candidate:z.string().min(1).max(200),confidence:z.number().min(0).max(100),preview:z.string().max(300000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/),confirmed:z.boolean()}).strict().optional(),
  salary_detail: z.object({source:z.enum(['DETAIL_RESPONSE','DETAIL_DOM']),original:z.string().max(200),observed_at:z.iso.datetime({offset:true})}).strict().optional(),
}).strict();
export type BrowserJob = z.infer<typeof browserJobSchema>;
export const BROWSER_COLLECTION_LIMIT = 500;
export type BrowserObservation = {page_url: string; observed_at: string};
export type BrowserSnapshot = { id: string; page_url: string; observed_at: string; jobs: BrowserJob[]; observations?: Record<string,BrowserObservation>; current_urls?: string[] };
export type BossBrowserState = {
  opened: boolean; loading: boolean; reading: boolean; crashed: boolean;
  url: string; error: string; can_back: boolean; can_forward: boolean;
  snapshot: BrowserSnapshot | null;
  page_kind: BossPageKind;
  snapshot_current: boolean;
  response_status?: "READY" | "UNAVAILABLE";
  search_running?:boolean;
  saved_refresh?:SavedRefreshState;
  batch?: {running:boolean;rounds:number;added:number;saved:number;reason:string};
};
const empty = z.object({}).strict();
export const bossBrowserRequest = z.discriminatedUnion("operation", [
  z.object({operation:z.enum(["greeting.prepare","communication.open"]),payload:z.object({id:z.string().uuid()}).strict()}).strict(),
  z.object({operation:z.literal("greeting.send"),payload:z.object({id:z.string().uuid(),token:z.string().uuid(),text:greetingTextSchema}).strict()}).strict(),
  z.object({operation:z.literal('saved.refresh'),payload:z.object({ids:z.array(z.string().uuid()).min(1).max(20).refine(ids=>new Set(ids).size===ids.length,'岗位不能重复')}).strict()}).strict(),
  z.object({operation:z.enum(['saved.refresh.get','saved.refresh.stop']),payload:empty.default({})}).strict(),
  z.object({ operation: z.enum(["state", "open", "back", "forward", "reload", "stop", "restart", "read", "read.append", "detail.read", "batch.start", "batch.stop", "response.enable", "response.disable"]), payload: empty.default({}) }).strict(),
  z.object({operation:z.enum(["search.get","search.stop"]),payload:empty.default({})}).strict(),
  z.object({operation:z.literal("search.start"),payload:searchConfigSchema}).strict(),
  z.object({operation:z.literal("search.continue"),payload:z.object({run_id:z.string().uuid()}).strict()}).strict(),
  z.object({operation:z.literal("search.verify"),payload:z.object({run_id:z.string().uuid()}).strict()}).strict(),
  z.object({operation:z.literal("search.save"),payload:z.object({run_id:z.string().uuid(),urls:z.array(z.string()).min(1).max(2000)}).strict()}).strict(),
  z.object({ operation: z.literal("layout"), payload: z.object({ visible: z.boolean(), x: z.number().int().min(0).max(20000), y: z.number().int().min(0).max(20000), width: z.number().int().min(0).max(20000), height: z.number().int().min(0).max(20000) }).strict() }).strict(),
  z.object({ operation: z.literal("job.open"), payload: z.object({ url: z.string().refine(v => canonicalBossJob(v) === v) }).strict() }).strict(),
  z.object({ operation: z.literal("job.locate"), payload: z.object({ snapshot_id: z.string().uuid(), url: z.string().refine(v => canonicalBossJob(v) === v) }).strict() }).strict(),
  z.object({ operation: z.literal("records"), payload: z.object({ snapshot_id: z.string().uuid() }).strict() }).strict(),
  z.object({ operation: z.literal("job.mark"), payload: z.object({ snapshot_id: z.string().uuid(), url: z.string().refine(v => canonicalBossJob(v) === v), mark: jobMarkSchema }).strict() }).strict(),
  z.object({ operation: z.literal("save"), payload: z.object({ snapshot_id: z.string().uuid(), urls: z.array(z.string()).min(1).max(BROWSER_COLLECTION_LIMIT) }).strict() }).strict(),
  z.object({operation:z.enum(["salary.recognize","salary.confirm"]),payload:z.object({snapshot_id:z.string().uuid(),url:z.string().refine(v=>canonicalBossJob(v)===v)}).strict()}).strict(),
]);
export type BossBrowserOperation = "greeting.prepare" | "greeting.send" | "communication.open" | "saved.refresh" | "saved.refresh.get" | "saved.refresh.stop" | "search.verify" | "search.continue" | "search.start" | "search.stop" | "search.get" | "search.save" | "state" | "open" | "back" | "forward" | "reload" | "stop" | "restart" | "read" | "read.append" | "detail.read" | "batch.start" | "batch.stop" | "response.enable" | "response.disable" | "layout" | "job.open" | "job.locate" | "job.mark" | "records" | "save" | "salary.recognize" | "salary.confirm";
export type BrowserRecords = Record<string, {id: string; mark: JobMark}>;
export type BossBrowserResult = { ok: true; state: BossBrowserState; greeting?:{token:string;text:string;expires_at:string}; saved?: number; saved_urls?:string[]; search_run?:BossSearchRun|null; records?: BrowserRecords; save_summary?: {created: number; updated: number}; read_summary?: {read: number; added: number; repeated: number; total: number} } | { ok: false; error: string };
export type BossBrowserBridge = { request: (operation: BossBrowserOperation, payload?: unknown) => Promise<BossBrowserResult> };

export type BrowserFilter = { keyword: string; city: string; education: string; exclude: string };
const normalizeFilterText = (s: string) => s.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
const filterWords = (s: string) => normalizeFilterText(s).split(/[\s,，;；、]+/).filter(Boolean);
export function normalizeEducation(value: string): string {
  const text = normalizeFilterText(value).replace(/\s/g, "");
  if (/^(学历不限|不限学历|不限)$/.test(text)) return "学历不限";
  return /^(?:大学)?(初中及以下|中专|中技|高中|大专|本科|硕士|博士)(?:学历|毕业)?(?:及以上|以上)?$/.exec(text)?.[1] ?? text;
}
export function containsKeyword(field: string, word: string): boolean {
  const text = normalizeFilterText(field);
  let position = text.indexOf(word);
  while (position >= 0) {
    const before = text[position - 1] ?? "", after = text[position + word.length] ?? "";
    // Latin keywords must not match inside another word: Java != JavaScript.
    if ((!/^[a-z]/.test(word) || !/[a-z]/.test(before)) && (!/[a-z]$/.test(word) || !/[a-z]/.test(after))) return true;
    position = text.indexOf(word, position + 1);
  }
  return false;
}
const normalizePlace = (s: string) => normalizeFilterText(s).replace(/市(?=[\s·•,，/\\|>\-]|$)/g, "").replace(/[\s·•,，/\\|>\-]+/g, "");
export type BrowserFilterEvaluation = { job: BrowserJob; status: "MATCH" | "EXCLUDED" | "UNKNOWN"; reasons: string[] };
export function evaluateBrowserJob(job: BrowserJob, filter: BrowserFilter): BrowserFilterEvaluation {
  const fields = [job.title, job.company, job.salary, job.location, job.education, job.experience, ...job.tags];
  const reasons: string[] = [], unknown: string[] = [];
  const missingKeywords = filterWords(filter.keyword).filter(word => !fields.some(field => containsKeyword(field, word)));
  if (missingKeywords.length) reasons.push(`缺少关键词：${missingKeywords.join("、")}`);
  const exclusions = filterWords(filter.exclude).filter(word => fields.some(field => containsKeyword(field, word)));
  if (exclusions.length) reasons.push(`命中排除词：${exclusions.join("、")}`);
  const cities = normalizeFilterText(filter.city).split(/[,，;；、]+/).map(normalizePlace).filter(Boolean);
  if (cities.length) {
    if (!normalizePlace(job.location)) unknown.push("地点未读取，请对照原站");
    else if (!cities.some(city => normalizePlace(job.location).includes(city))) {
      if (/^[^·•\s市]{1,10}(?:区|县|镇|街道)$/.test(normalizeFilterText(job.location))) unknown.push(`地点可能只有区县：${job.location}，请对照原站城市`);
      else reasons.push(`地点不符：${job.location}`);
    }
  }
  if (filter.education) {
    const education = normalizeEducation(job.education);
    if (!education) unknown.push("学历未读取，请对照原站");
    else if (!job.education.split(/[/、或]/).some(value=>normalizeEducation(value)===normalizeEducation(filter.education))) reasons.push(`学历不符：${job.education}`);
  }
  return { job, status: reasons.length ? "EXCLUDED" : unknown.length ? "UNKNOWN" : "MATCH", reasons: [...reasons, ...unknown] };
}
export function filterBrowserJobs(jobs: BrowserJob[], filter: BrowserFilter): BrowserJob[] {
  return jobs.filter(job => evaluateBrowserJob(job, filter).status === "MATCH");
}
