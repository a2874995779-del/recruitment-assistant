import type { Condition, Job, MatchResult, Rule, RuleNode } from '../../contracts/src/index.js';

type Evaluation = Omit<MatchResult, 'rule_id' | 'rule_version'>;
function evaluateCondition(job: Job, c: Condition): Evaluation {
  let value: unknown = c.field === 'salary' ? [job.salary_min, job.salary_max] : job[c.field];
  if (c.field === 'company_nature' && !job.nature_verified) value = null;
  const required = c.field === 'salary' && Array.isArray(value)
    ? ['LOWER_BOUND','GTE'].includes(c.op) ? [value[0]] : c.op === 'LTE' ? [value[1]] : value : value;
  const unknown = required === null || required === undefined || (Array.isArray(required) && (required.length === 0 || required.some(v => v === null || v === undefined)))
    || (c.field === 'salary' && (job.currency !== c.currency || job.salary_period !== c.salary_period));
  if (unknown) {
    const status = c.effect === 'PREFER' ? 'PASS' : c.unknown === 'ALLOW' ? 'PASS' : c.unknown === 'EXCLUDE' ? 'EXCLUDED' : 'PENDING';
    return { status, score: 0, reasons: [{field: c.field, status, reason: '字段未知、未经核实或薪资单位不可比较；按未知值策略处理'}] };
  }
  const values = Array.isArray(value) ? value : [value];
  const targets = Array.isArray(c.value) ? c.value : [c.value];
  let hit = false;
  switch (c.op) {
    case 'EQ': case 'IN': hit = values.some(v => targets.includes(v as never)); break;
    case 'CONTAINS': hit = values.some(v => targets.some(t => String(v).toLocaleLowerCase().includes(String(t).toLocaleLowerCase()))); break;
    case 'GTE': case 'LOWER_BOUND': hit = Number(values[0]) >= Number(c.value); break;
    case 'LTE': hit = Number(values[values.length - 1]) <= Number(c.value); break;
    case 'INTERSECTS': hit = Number(values[0]) <= Number(targets[1]) && Number(values[1]) >= Number(targets[0]); break;
  }
  const status = c.effect === 'PREFER' ? 'PASS' : (c.effect === 'EXCLUDE' ? !hit : hit) ? 'PASS' : 'EXCLUDED';
  return { status, score: c.effect === 'PREFER' && hit ? c.weight : 0, reasons: [{field: c.field, status, reason: `${c.effect}/${c.op}：${hit ? '命中' : '未命中'}`} ] };
}

function evaluate(job: Job, node: RuleNode): Evaluation {
  if (node.kind === 'condition') return evaluateCondition(job, node);
  const results = node.children.map(child => evaluate(job, child));
  // Preferences affect only ordering; an OR preference cannot bypass a hard requirement.
  const hasHard = (n: RuleNode): boolean => n.kind === 'condition' ? n.effect !== 'PREFER' : n.children.some(hasHard);
  const hard = results.filter((_, i) => hasHard(node.children[i]!));
  const status = hard.length === 0 ? 'PASS' : node.op === 'AND'
    ? hard.some(r => r.status === 'EXCLUDED') ? 'EXCLUDED' : hard.some(r => r.status === 'PENDING') ? 'PENDING' : 'PASS'
    : hard.some(r => r.status === 'PASS') ? 'PASS' : hard.some(r => r.status === 'PENDING') ? 'PENDING' : 'EXCLUDED';
  return { status, score: results.reduce((n, r) => n + r.score, 0), reasons: results.flatMap(r => r.reasons) };
}

export function matchJob(job: Job, rule: Rule): MatchResult {
  return { ...evaluate(job, rule.root), rule_id: rule.id, rule_version: rule.version };
}

export function qualificationIssues(job: Job, profile: { major: string | null; graduation_year: number | null; education: string | null; experience_years: number | null }): string[] {
  const issues: string[] = [];
  if (job.majors && job.majors.length > 0 && (!profile.major || !job.majors.includes(profile.major))) issues.push('专业缺失或不符合岗位明确要求');
  if (job.recruitment_type === 'CAMPUS' && (!job.graduation_years || !profile.graduation_year)) issues.push('校招届别资格未知');
  if (job.graduation_years && (!profile.graduation_year || !job.graduation_years.includes(profile.graduation_year))) issues.push('毕业年份缺失或不符合');
  const ranks: Record<string, number> = { '不限': 0, '高中': 1, '中专': 1, '大专': 2, '本科': 3, '硕士': 4, '博士': 5 };
  if (job.education && job.education !== '不限' && (!profile.education || ranks[job.education] === undefined || ranks[profile.education] === undefined || ranks[profile.education]! < ranks[job.education]!)) issues.push('学历缺失、不符合或需要人工核实');
  if (job.experience_range && (profile.experience_years === null || profile.experience_years < job.experience_range[0])) issues.push('工作经验缺失或不足');
  return [...new Set(issues)];
}

export function deadlinePassed(job: Job, time = new Date()): boolean {
  if (!job.deadline_at) return false;
  if (job.deadline_precision === 'INSTANT') return new Date(job.deadline_at).getTime() < time.getTime();
  if (job.deadline_precision === 'DATE' && job.deadline_timezone) {
    const parts = new Intl.DateTimeFormat('en-US',{timeZone:job.deadline_timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(time);
    const today = ['year','month','day'].map(key=>parts.find(p=>p.type===key)?.value).join('-');
    return job.deadline_at < today;
  }
  return false;
}
