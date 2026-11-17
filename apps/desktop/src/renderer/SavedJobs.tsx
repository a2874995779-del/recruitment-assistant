import {GreetingSettings,SavedGreeting} from './SavedGreeting.js';
import {useEffect,useRef,useState} from 'react';
import {jobMarkLabels,savedJobQuerySchema,type JobMark,type ManagedJob,type SavedJobQuery,type SavedRefreshState} from '../../../../packages/contracts/src/job-management.js';
import {browserJobSchema} from '../../../../packages/contracts/src/boss-browser.js';
import {JobComparison} from './JobComparison.js';

const emptyQuery:SavedJobQuery={offset:0,limit:50,search:'',company:'',city:'',sort:'SAVED_DESC'};
const dateText=(value:unknown)=>typeof value==='string' && Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'尚未核实';
const salaryText=(value:string|null)=>value && /[\uE000-\uF8FF]/.test(value)?'薪资字体受限，请查看原帖':value||'未读取';

function NoteEditor({job,onSaved}:{job:ManagedJob;onSaved:()=>void}){
  const [note,setNote]=useState(job.personal_note??''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const lock=useRef(false);
  useEffect(()=>{setNote(job.personal_note??'');},[job.personal_note]);
  async function save(){if(lock.current || !window.recruitment)return;lock.current=true;setBusy(true);setError('');try{const result=await window.recruitment.command('job.note',{id:job.id,note});if(!result.ok)throw new Error(result.error.message);onSaved();}catch(e){setError(e instanceof Error?e.message:'备注保存失败');}finally{lock.current=false;setBusy(false);}}
  return <details className="saved-note"><summary>{job.personal_note?'备注 ✓':'添加备注'}</summary><textarea aria-label={`${job.title}的备注`} value={note} onChange={e=>setNote(e.target.value)} maxLength={2000} rows={3}/><button disabled={busy || note===(job.personal_note??'')} onClick={()=>void save()}>{busy?'保存中…':'保存备注'}</button>{error && <small role="alert">{error}</small>}</details>;
}
function Description({job}:{job:ManagedJob}){const detail=browserJobSchema.shape.detail.safeParse(job.extra.boss_detail);if(!detail.success || !detail.data)return null;return <details className="job-description"><summary>职位描述</summary><p>{detail.data.address}</p><p>{detail.data.description}</p></details>;}
function Changes({job}:{job:ManagedJob}){
  const failed=job.refresh?.status==='FAILED' || job.refresh?.status==='STOPPED',changed=job.change_check?.status==='CHANGED';
  if(!failed && !changed)return null;
  return <div className="job-changes"><span className={`search-badge ${failed?'unknown':'changed'}`} title={job.change_check?`最近成功检查：${dateText(job.change_check.checked_at)}`:undefined}>{failed?'本次未核实':'岗位有变化'}</span>
    {!!job.change_history?.length && <details><summary>变化记录（{job.change_history.length}）</summary>{job.change_history.map(check=><div className="change-entry" key={check.checked_at}><small>{dateText(check.checked_at)}</small>{check.changes.map(change=><div key={change.field}><strong>{change.field}</strong><p className="change-before">之前：{change.before||'未读取'}</p><p>现在：{change.after||'未读取'}</p></div>)}</div>)}</details>}
  </div>;
}

export function SavedJobs({active,revision,onOpen,onBrowser,onSaved}:{active:boolean;revision:number;onOpen:(url:string)=>void;onBrowser:()=>void;onSaved:()=>void}){
  const [items,setItems]=useState<ManagedJob[]>([]),[total,setTotal]=useState(0),[query,setQuery]=useState(emptyQuery),[draft,setDraft]=useState(emptyQuery);
  const [min,setMin]=useState(''),[max,setMax]=useState(''),[reload,setReload]=useState(0),[selected,setSelected]=useState<string[]>([]);
  const [comparing,setComparing]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[marking,setMarking]=useState(false),[starting,setStarting]=useState(false),[progress,setProgress]=useState<SavedRefreshState>();
  const generation=useRef(0),markLock=useRef(false),refreshLock=useRef(false),wasRunning=useRef(false);
  const running=progress?.running??false;
  useEffect(()=>{if(!active)return;let cancelled=false;const request=++generation.current;setBusy(true);setError('');void(async()=>{try{if(!window.recruitment)throw new Error('本地服务未连接');const result=await window.recruitment.command('saved.list',query);if(!result.ok)throw new Error(result.error.message);const data=result.data as {items:ManagedJob[];total:number};if(!cancelled && generation.current===request){if(query.offset>0 && query.offset>=data.total){setQuery(old=>({...old,offset:Math.max(0,Math.ceil(data.total/50)-1)*50}));return;}setItems(data.items);setTotal(data.total);}}catch(e){if(!cancelled)setError(e instanceof Error?e.message:'读取本地记录失败');}finally{if(!cancelled)setBusy(false);}})();return()=>{cancelled=true;};},[active,revision,query,reload]);
  // Poll the bounded native operation, including when the user switches tabs.
  useEffect(()=>{if(!active && !running)return;let cancelled=false,inflight=false;async function poll(){if(inflight)return;inflight=true;try{const result=await window.recruitment?.bossBrowser?.request('saved.refresh.get');if(result?.ok && !cancelled){const next=result.state.saved_refresh;setProgress(next);if(wasRunning.current && !next?.running){setReload(n=>n+1);setSelected([]);onSaved();setNotice(next?.reason??'更新已结束');}wasRunning.current=!!next?.running;}}catch(e){if(!cancelled)setError(e instanceof Error?e.message:"读取更新进度失败");}finally{inflight=false;}}void poll();const timer=setInterval(()=>void poll(),800);return()=>{cancelled=true;clearInterval(timer);};},[active,running,onSaved]);
  const reloadLocal=()=>setReload(n=>n+1);
  async function mark(id:string,personalMark:JobMark){if(markLock.current || !window.recruitment)return;markLock.current=true;setMarking(true);setError('');try{const result=await window.recruitment.command('job.mark',{id,mark:personalMark});if(!result.ok)throw new Error(result.error.message);reloadLocal();onSaved();}catch(e){setError(e instanceof Error?e.message:'标记保存失败');}finally{markLock.current=false;setMarking(false);}}
  function apply(){const parsed=savedJobQuerySchema.safeParse({...draft,offset:0,salary_min:min===''?undefined:Number(min),salary_max:max===''?undefined:Number(max)});if(!parsed.success){setError(parsed.error.issues.map(x=>x.message).join('；'));return;}setError('');setSelected([]);setQuery(parsed.data);}
  async function refresh(){if(refreshLock.current)return;refreshLock.current=true;setStarting(true);setError('');setNotice('');try{const bridge=window.recruitment?.bossBrowser;if(!bridge)throw new Error('当前环境不支持原帖更新，请使用桌面软件');const result=await bridge.request('saved.refresh',{ids:selected});if(!result.ok)throw new Error(result.error);setProgress(result.state.saved_refresh);wasRunning.current=!!result.state.saved_refresh?.running;}catch(e){setError(e instanceof Error?e.message:'更新启动失败');}finally{refreshLock.current=false;setStarting(false);}}
  async function stop(){try{const result=await window.recruitment?.bossBrowser?.request('saved.refresh.stop');if(result && !result.ok)setError(result.error);}catch(e){setError(e instanceof Error?e.message:"停止更新失败");}}
  const clear=()=>{setDraft(emptyQuery);setQuery(emptyQuery);setMin('');setMax('');setSelected([]);setError('');};
  return <section className="saved-jobs" aria-label="已保存岗位">
    <div className="page-head"><div><h1>已保存岗位 <span className="count">{total}</span></h1><p className="muted">本地记录，可筛选、标记、对比和更新原帖。</p></div><button onClick={onBrowser}>登录 / 查看 BOSS</button></div>
    <form className="card saved-filter" onSubmit={e=>{e.preventDefault();apply();}}><fieldset disabled={running || starting}>
      <label className="span2">关键词<input aria-label="搜索已保存岗位" placeholder="岗位、公司或备注" value={draft.search} onChange={e=>setDraft(old=>({...old,search:e.target.value}))} maxLength={200}/></label>
      <label>地点<input aria-label="筛选地点" placeholder="如：武汉" value={draft.city} onChange={e=>setDraft(old=>({...old,city:e.target.value}))} maxLength={100}/></label>
      <label>分类<select aria-label="按个人标记筛选" value={draft.personal_mark??''} onChange={e=>setDraft(old=>({...old,personal_mark:(e.target.value||undefined) as JobMark|undefined}))}><option value="">全部分类</option>{Object.entries(jobMarkLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label>薪资周期<select aria-label="保存岗位薪资周期" value={draft.salary_period??''} onChange={e=>{setMin('');setMax('');setDraft(old=>({...old,salary_period:(e.target.value||undefined) as 'MONTH'|'DAY'|undefined,sort:'SAVED_DESC'}));}}><option value="">全部周期</option><option value="MONTH">月薪 · K/月</option><option value="DAY">日薪 · 元/天</option></select></label>
      <label>薪资范围（{draft.salary_period==='DAY'?'元/天':'K/月'}）<span className="range"><input aria-label="保存岗位最低薪资" placeholder="最低" type="number" min="0" max="100000" step="any" value={min} disabled={!draft.salary_period} onChange={e=>setMin(e.target.value)}/><i>–</i><input aria-label="保存岗位最高薪资" placeholder="最高" type="number" min="0" max="100000" step="any" value={max} disabled={!draft.salary_period} onChange={e=>setMax(e.target.value)}/></span></label>
      <label>公司<input aria-label="筛选公司" value={draft.company} onChange={e=>setDraft(old=>({...old,company:e.target.value}))} maxLength={200}/></label>
      <label>排序<select aria-label="保存岗位排序" value={draft.sort} onChange={e=>setDraft(old=>({...old,sort:e.target.value as SavedJobQuery['sort']}))}><option value="SAVED_DESC">最近保存优先</option><option value="SAVED_ASC">最早保存优先</option><option disabled={!draft.salary_period} value="SALARY_DESC">薪资从高到低</option><option disabled={!draft.salary_period} value="SALARY_ASC">薪资从低到高</option></select></label>
      <div className="wrap filter-actions"><button className="primary" type="submit">筛选</button><button type="button" onClick={clear}>重置</button><button type="button" disabled={busy} onClick={reloadLocal}>刷新本地记录</button></div>
    </fieldset></form>
    <div className="search-results-toolbar saved-actions">
      <span className="muted">已选 {selected.length} 个</span>
      <div className="wrap push-right">
        <button disabled={running || starting || selected.length<2 || selected.length>4} onClick={()=>setComparing(true)} title="可选 2–4 个">对比所选（{selected.length}）</button>
        <button disabled={running || starting || !selected.length} onClick={()=>void refresh()} title="重新读取原帖并记录变化，每次最多 20 条">{starting?'正在启动…':`更新选中原帖（${selected.length}）`}</button>
        {running && <button className="danger" onClick={()=>void stop()}>停止更新</button>}
      </div>
    </div>
    {progress && <p className="saved-refresh-status" role="status">{running && <i className="spinner"/>}{running?'正在更新':'更新结果'}：{progress.checked}/{progress.total}，成功 {progress.updated}，失败 {progress.failed}。{progress.reason}</p>}
    {notice && <p role="status" className="boss-plugin-notice">{notice}</p>}{error && <p role="alert" className="app-error">{error}</p>}
    {busy && <p role="status" className="muted">正在读取本地记录…</p>}
    {!busy && !items.length?<p className="empty">{total?'当前页暂无岗位':'没有匹配的岗位，可调整筛选条件。'}</p>:<div className="search-table saved-table"><table><thead><tr><th></th><th>岗位 / 企业</th><th>薪资</th><th>地点 / 要求</th><th>分类 / 备注</th><th>操作</th></tr></thead><tbody>{items.map(job=><tr key={job.id}>
      <td><input type="checkbox" aria-label={`选择${job.title}`} disabled={running || starting || (!selected.includes(job.id) && selected.length>=20)} checked={selected.includes(job.id)} onChange={e=>setSelected(old=>e.target.checked?[...old,job.id]:old.filter(id=>id!==job.id))}/></td>
      <td><strong>{job.title}</strong><small>{job.company_name}</small><small title={`读取：${dateText(job.extra.observed_at)}\n最近成功更新：${dateText(job.refresh?.last_success_at)}${job.refresh?`\n最近尝试：${dateText(job.refresh.last_attempt_at)} · ${job.refresh.reason}`:''}`}>保存于 {dateText(job.first_seen_at)}</small><Changes job={job}/><Description job={job}/></td>
      <td className="salary">{salaryText(job.salary_raw)}</td>
      <td>{job.locations?.join(' / ')||'地点未读取'}<small>{[job.education,job.experience_raw].filter(Boolean).join(' · ')}</small></td>
      <td><select className="compact" aria-label={`${job.title}的个人标记`} disabled={marking || running} value={job.personal_mark} onChange={e=>void mark(job.id,e.target.value as JobMark)}>{Object.entries(jobMarkLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><NoteEditor job={job} onSaved={()=>{reloadLocal();onSaved();}}/></td>
      <td><button className="link" disabled={running} onClick={()=>onOpen(job.source_url)}>原帖</button><SavedGreeting job={job} blocked={running||starting} onBrowser={onBrowser} onSaved={()=>{reloadLocal();onSaved();}}/></td>
    </tr>)}</tbody></table></div>}
    {total>50 && <div className="saved-pagination"><button disabled={!query.offset || busy || running} onClick={()=>{setSelected([]);setQuery(old=>({...old,offset:Math.max(0,old.offset-50)}));}}>上一页</button><span>{`${query.offset+1}–${Math.min(query.offset+50,total)} / ${total}`}</span><button disabled={query.offset+50>=total || busy || running} onClick={()=>{setSelected([]);setQuery(old=>({...old,offset:old.offset+50}));}}>下一页</button></div>}
    <GreetingSettings/>
    {comparing && <JobComparison items={items.filter(job=>selected.includes(job.id)).map(job=>({job:{url:job.source_url,title:job.title,company:job.company_name,salary:job.salary_raw??'',location:(job.locations??[]).join(' / '),education:job.education??'',experience:job.experience_raw??'',tags:job.tags??[],detail:browserJobSchema.shape.detail.safeParse(job.extra.boss_detail).data},observed_at:typeof job.extra.observed_at==='string'?job.extra.observed_at:job.first_seen_at,note:job.personal_note}))} onClose={()=>setComparing(false)} onOpen={onOpen}/>}
  </section>;
}
