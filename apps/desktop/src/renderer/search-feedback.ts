import { type BossSearchConfig, type BossSearchRun } from '../../../../packages/contracts/src/boss-search.js';
export type SearchResultView='ALL'|'CANDIDATES'|'MATCH'|'UNKNOWN'|'EXCLUDED';
export function searchConditions(config:BossSearchConfig){
  return [config.cities.join('、'),config.keywords.join('、'),config.education || '学历不限',config.experience==='ALL'?'不限制经验':config.experience==='GRADUATE'?'应届 / 经验不限':'实习',
    config.salary_min===null && config.salary_max===null?'不限制薪资':`${config.salary_min ?? '不限'}—${config.salary_max ?? '不限'}${config.salary_period==='DAY'?'元/天':'K/月'}`,config.exclude?`排除：${config.exclude}`:'不排除关键词'].join(' · ');
}
export function searchEmptyFeedback(run:BossSearchRun|null,view:SearchResultView){
  if(!run)return {message:'填写条件后重新获取岗位。先通过“登录 / 查看 BOSS”完成登录。',showAll:false,showBrowser:true};
  if(!run.results.length && run.skipped_processed)return {message:`本次尚未读取到新岗位，已跳过 ${run.skipped_saved ?? 0} 个已保存、${run.skipped_processed} 个相同条件下已完成筛选的岗位。可“重新检查旧岗位”；这不代表平台没有其他岗位。`,showAll:false,showBrowser:true};
  if(!run.results.length && run.skipped_saved)return {message:`尚未读取新的未保存岗位，已跳过 ${run.skipped_saved} 个本地已保存岗位。可在“已保存岗位”查看，或关闭跳过后重新获取。`,showAll:false,showBrowser:true};
  if(!run.results.length){
    if(run.status==='RUNNING')return {message:'正在加载并读取原站岗位，尚未获得第一批数据，请稍候。',showAll:false,showBrowser:false};
    const reasons=[...new Set(run.pairs.filter(pair=>['BLOCKED','FAILED','STOPPED'].includes(pair.status)).map(pair=>pair.reason).filter(Boolean))];
    return {message:`本次实际读取 0 个岗位，尚未进入筛选。${reasons.join('；') || run.reason || '任务未完成'}。请查看 BOSS 原网页；这不代表该关键词没有职位。`,showAll:false,showBrowser:true};
  }
  const labels={ALL:'全部已读',CANDIDATES:'候选岗位',MATCH:'符合条件',UNKNOWN:'待核实',EXCLUDED:'已排除'};
  return {message:`本次已读取 ${run.results.length} 个岗位，“${labels[view]}”分类为 0 个。点击“查看全部已读岗位”核对结果与每条筛选理由。`,showAll:view!=='ALL',showBrowser:false};
}
