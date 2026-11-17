import { z } from 'zod';

export const CONTRACT_VERSION = 1;
export const USER_ID = 'local-user';
export const platformSchema = z.enum(['boss', 'wllm91']);
export const modeSchema = z.enum(['MOCK', 'REAL', 'IMPORT']);
export type Platform = z.infer<typeof platformSchema>;
export type Mode = z.infer<typeof modeSchema>;
export const actionTypeSchema = z.enum(['GREETING', 'SEND_RESUME', 'APPLY', 'EXTERNAL_APPLICATION']);
export type ActionType = z.infer<typeof actionTypeSchema>;
export type CapabilityStatus = 'UNVERIFIED' | 'VERIFIED' | 'LIMITED' | 'UNSUPPORTED' | 'TEMPORARILY_DISABLED';
export type AccountStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'EXPIRED' | 'ACTION_REQUIRED' | 'ERROR';
export type ActionStatus = 'QUEUED' | 'PRECHECKING' | 'READY' | 'EXECUTING' | 'VERIFYING' | 'SUCCEEDED' | 'FAILED_CONFIRMED' | 'UNKNOWN' | 'RECONCILING' | 'BLOCKED' | 'SKIPPED' | 'PAUSED' | 'CANCELLED';

export const httpUrl = z.string().url().max(2048).refine(v => ['http:', 'https:'].includes(new URL(v).protocol), '只允许 HTTP/HTTPS 链接');
export const stationSchema = z.object({
  school_id: z.string().max(100).nullable().default(null), tenant_id: z.string().max(100).nullable().default(null),
  base_url: httpUrl, auth_strategy: z.enum(['manual', 'sso']).default('manual'),
  route_overrides: z.record(z.string(), z.string().max(500)).default({})
}).strict();
export type Station = z.infer<typeof stationSchema>;
export const accountInput = z.object({
  platform: platformSchema, mode: z.enum(['MOCK', 'REAL']).default('MOCK'),
  nickname: z.string().min(1).max(80), station: stationSchema.optional()
}).strict();
export type Account = z.infer<typeof accountInput> & { id: string; user_id: string; identity: string | null; generation: number; status: AccountStatus; created_at: string; last_sync_at: string | null };

export const profileInput = z.object({
  education: z.string().max(40).nullable().default(null), major: z.string().max(100).nullable().default(null),
  graduation_year: z.number().int().min(1950).max(2100).nullable().default(null),
  experience_years: z.number().min(0).max(80).nullable().default(null),
  job_seeker_type: z.enum(['GRADUATE', 'EXPERIENCED', 'UNKNOWN']).default('UNKNOWN'),
  preferred_cities: z.array(z.string().max(80)).max(50).default([])
}).strict();
export type Profile = z.infer<typeof profileInput>;

export const jobInput = z.object({
  external_job_id: z.string().min(1).max(200), source_instance_id: z.string().min(1).max(200),
  source_url: httpUrl, platform: platformSchema, mode: modeSchema,
  title: z.string().min(1).max(200), company_name: z.string().min(1).max(200),
  locations: z.array(z.string().max(100)).max(50).nullable().default(null),
  salary_raw: z.string().max(200).nullable().default(null), salary_min: z.number().nonnegative().nullable().default(null),
  salary_max: z.number().nonnegative().nullable().default(null), currency: z.string().max(10).nullable().default(null),
  salary_period: z.enum(['MONTH', 'YEAR', 'DAY', 'HOUR']).nullable().default(null), salary_months: z.number().min(1).max(24).nullable().default(null),
  education: z.string().max(40).nullable().default(null), experience_raw: z.string().max(200).nullable().default(null),
  experience_range: z.tuple([z.number().nonnegative(), z.number().nonnegative()]).nullable().default(null),
  majors: z.array(z.string().max(100)).max(100).nullable().default(null), graduation_years: z.array(z.number().int()).max(30).nullable().default(null),
  recruitment_type: z.enum(['CAMPUS', 'SOCIAL', 'INTERNSHIP']).nullable().default(null),
  employment_type: z.string().max(80).nullable().default(null), description: z.string().max(50000).nullable().default(null),
  tags: z.array(z.string().max(100)).max(100).nullable().default(null),
  company_nature: z.array(z.string().max(100)).max(20).nullable().default(null),
  nature_evidence_url: httpUrl.nullable().default(null), nature_verified: z.boolean().default(false),
  published_date: z.iso.date().nullable().default(null),
  published_at: z.iso.datetime({ offset: true }).nullable().default(null).transform(v => v === null ? null : new Date(v).toISOString()), deadline_at: z.string().max(80).nullable().default(null),
  deadline_timezone: z.string().max(80).nullable().default(null), deadline_precision: z.enum(['DATE', 'INSTANT']).nullable().default(null),
  status: z.enum(['ACTIVE', 'CLOSED', 'EXPIRED', 'UNVERIFIED']).default('UNVERIFIED'),
  apply_target: z.object({ kind: z.enum(['IN_PLATFORM', 'EXTERNAL', 'UNKNOWN']), url: httpUrl.nullable().default(null) }).strict(),
  extra: z.record(z.string(), z.unknown()).default({})
}).strict().refine(j => j.salary_min === null || j.salary_max === null || j.salary_min <= j.salary_max, '薪资上下限不合法')
  .refine(j => j.experience_range === null || j.experience_range[0] <= j.experience_range[1], '经验范围不合法')
  .refine(j => !j.nature_verified || j.nature_evidence_url !== null, '已核实企业性质必须附来源证据')
  .refine(j => j.deadline_at === null || (j.deadline_timezone !== null && j.deadline_precision !== null && (j.deadline_precision === 'DATE' ? z.iso.date().safeParse(j.deadline_at).success : z.iso.datetime({ offset: true }).safeParse(j.deadline_at).success)), '截止时间需包含精度、时区和合法值')
  .refine(j => { if (j.deadline_timezone === null) return true; try { new Intl.DateTimeFormat('en-US',{timeZone:j.deadline_timezone}).format(); return true; } catch { return false; } }, '截止时区必须是有效 IANA 时区');
export type JobInput = z.infer<typeof jobInput>;
export type Job = JobInput & { id: string; user_id: string; schema_version: number; content_hash: string; first_seen_at: string; last_seen_at: string; last_verified_at: string | null };

export const conditionSchema = z.object({
  kind: z.literal('condition'),
  field: z.enum(['title', 'company_name', 'locations', 'education', 'majors', 'graduation_years', 'recruitment_type', 'employment_type', 'tags', 'company_nature', 'platform', 'salary', 'experience_range']),
  op: z.enum(['EQ', 'IN', 'CONTAINS', 'GTE', 'LTE', 'INTERSECTS', 'LOWER_BOUND']),
  value: z.union([z.string().min(1).max(200), z.number(), z.array(z.string().min(1).max(200)).min(1).max(100), z.array(z.number()).min(1).max(100)]),
  effect: z.enum(['MUST', 'EXCLUDE', 'PREFER']).default('MUST'),
  unknown: z.enum(['ALLOW', 'EXCLUDE', 'CONFIRM']).default('CONFIRM'), weight: z.number().min(0).max(100).default(1),
  currency: z.string().max(10).optional(), salary_period: z.enum(['MONTH', 'YEAR', 'DAY', 'HOUR']).optional()
}).strict().superRefine((c, ctx) => {
  const error = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (c.field === 'salary') {
    if (!c.currency || !c.salary_period) error('薪资条件必须指定币种和周期');
    if (!['LOWER_BOUND', 'INTERSECTS', 'GTE', 'LTE'].includes(c.op)) error('薪资操作不支持');
  } else if (c.field === 'experience_range') {
    if (!['GTE', 'LTE', 'INTERSECTS'].includes(c.op)) error('经验范围操作不支持');
  } else if (!['EQ', 'IN', 'CONTAINS'].includes(c.op)) error('该字段仅支持 EQ/IN/CONTAINS');
  if (['GTE', 'LTE', 'LOWER_BOUND'].includes(c.op) && typeof c.value !== 'number') error('比较值必须为数字');
  if (c.op === 'INTERSECTS' && (!Array.isArray(c.value) || c.value.length !== 2 || !c.value.every(v => typeof v === 'number') || Number(c.value[0]) > Number(c.value[1]))) error('相交范围必须为有序的两个数字');
});
export type Condition = z.infer<typeof conditionSchema>;
export type RuleNode = Condition | { kind: 'group'; op: 'AND' | 'OR'; children: RuleNode[] };
export const ruleNodeSchema: z.ZodType<RuleNode> = z.lazy(() => z.union([conditionSchema, z.object({
  kind: z.literal('group'), op: z.enum(['AND', 'OR']), children: z.array(ruleNodeSchema).min(1).max(50)
}).strict()]));
export const ruleInput = z.object({ name: z.string().min(1).max(100), root: ruleNodeSchema }).strict().superRefine((rule, ctx) => {
  let count = 0; const visit = (n: RuleNode, depth: number) => { count++; if (depth > 10 || count > 200) throw new Error(); if (n.kind === 'group') n.children.forEach(c => visit(c, depth + 1)); };
  try { visit(rule.root, 0); } catch { ctx.addIssue({code: 'custom', message: '规则最多 10 层、200 个节点'}); }
});
export type Rule = z.infer<typeof ruleInput> & { id: string; version: number; user_id: string; created_at: string };
export type MatchResult = { status: 'PASS' | 'EXCLUDED' | 'PENDING'; score: number; reasons: { field: string; status: 'PASS' | 'EXCLUDED' | 'PENDING'; reason: string }[]; rule_id: string; rule_version: number };
export const resumeInput = z.object({ name: z.string().min(1).max(100), filename: z.string().min(1).max(200), content_base64: z.string().min(1).max(14000000), note: z.string().max(1000).default('') }).strict();
export type Resume = { id: string; user_id: string; name: string; version: number; file_ref: string; file_hash: string; size: number; format: 'PDF'; note: string; created_at: string };
const batchFields = z.object({
  job_ids: z.array(z.string().uuid()).min(1).max(50), account_id: z.string().uuid(), resume_id: z.string().uuid().nullable().default(null),
  rule_id: z.string().uuid(), actions: z.array(actionTypeSchema).min(1).max(4), greeting: z.string().max(1000).default(''),
  approved: z.literal(true), idempotency_key: z.string().min(8).max(100), preview_hash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const resumeRequired = (input: {actions: string[]; resume_id: string | null}) => input.actions.every(action => action === 'GREETING') || input.resume_id !== null;
const resumeRequirement = {message:'发送附件简历或申请时必须选择 PDF 简历；仅打招呼可以不选',path:['resume_id']};
export const batchPreviewInput = batchFields.omit({approved:true,idempotency_key:true,preview_hash:true}).refine(resumeRequired,resumeRequirement);
export const batchInput = batchFields.refine(resumeRequired,resumeRequirement);
export type BatchInput = z.infer<typeof batchInput>;
export type Batch = { id: string; user_id: string; account_id: string; account_generation: number; mode: Mode; resume_id: string | null; resume_hash: string | null; rule_id: string; rule_version: number; greeting: string; limits: Settings; state: 'RUNNING' | 'PAUSED' | 'CANCELLED'; approved_at: string; idempotency_key: string; request_hash: string };
export type Action = { id: string; user_id: string; batch_id: string; account_id: string; job_id: string; source_key: string; type: ActionType; status: ActionStatus; reason: string | null; evidence: string | null; evidence_kind: 'MOCK_VERIFIED' | 'PLATFORM_VERIFIED' | 'USER_REPORTED' | null; execution_ref: string | null; updated_at: string };
export type Task = { id: string; user_id: string; account_id: string; kind: 'SYNC_JOBS' | 'SYNC_MESSAGES' | 'ACTION' | 'RECONCILE'; payload: Record<string, unknown>; contract_version: number; state: 'QUEUED' | 'RUNNING' | 'DONE' | 'BLOCKED' | 'FAILED' | 'PAUSED' | 'CANCELLED'; priority: number; attempts: number; max_attempts: number; run_after: string; lease_until: string | null; owner: string | null; error: string | null; created_at: string };
export const planInput = z.object({ account_id: z.string().uuid(), keywords: z.string().max(200).default(''), cities: z.array(z.string().max(80)).max(30).default([]), interval_seconds: z.number().int().min(300).max(3600).default(900), budget: z.number().int().min(1).max(100).default(20) }).strict();
export type SearchPlan = z.infer<typeof planInput> & { id: string; user_id: string; enabled: boolean; cursor: string | null; last_sync_at: string | null; next_run_at: string };
export type Message = { id: string; user_id: string; account_id: string; dedupe_key: string; source_message_id: string | null; conversation_id: string; sender: string; body: string | null; coverage: 'FULL_TEXT' | 'UNREAD_COUNT'; unread_count: number | null; source_sent_at: string | null; observed_at: string; source_url: string; uncertain: boolean; mode: Mode; local_read: boolean };
export const companyInput = z.object({ name: z.string().min(1).max(200), nature_tags: z.array(z.string().max(80)).max(20).default([]), evidence_url: httpUrl.nullable().default(null), verified: z.boolean().default(false), parent_id: z.string().uuid().nullable().default(null) }).strict().refine(c => !c.verified || c.evidence_url !== null, '核实分类需要证据');
export const sourceInput = z.object({ company_id: z.string().uuid(), url: httpUrl, type: z.enum(['OFFICIAL', 'ATS', 'DISCOVERY']), application_url: httpUrl.nullable().default(null), verified: z.boolean().default(false) }).strict();
export const settingsInput = z.object({ daily_action_limit: z.number().int().min(1).max(200).default(30), max_batch_size: z.number().int().min(1).max(50).default(50), quiet_hours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }).nullable().default(null), desktop_enabled: z.boolean().default(false), body_preview: z.boolean().default(false), run_hours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }).nullable().default(null) }).strict();
export type Settings = z.infer<typeof settingsInput>;
