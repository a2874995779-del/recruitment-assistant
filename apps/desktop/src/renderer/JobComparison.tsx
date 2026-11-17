import {useEffect,useRef} from 'react';
import type {BrowserJob} from '../../../../packages/contracts/src/boss-browser.js';

export type ComparisonItem={job:BrowserJob;observed_at:string;note?:string};
const time=(value:string)=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'未读取';
const text=(value:string)=>/[\uE000-\uF8FF]/.test(value)?'薪资未核实':value||'未读取';
export function JobComparison({items,onClose,onOpen}:{items:ComparisonItem[];onClose:()=>void;onOpen:(url:string)=>void}){
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{dialog.current?.showModal();},[]);
  const rows:[string,(item:ComparisonItem)=>string][]=[['企业',i=>i.job.company],['薪资原文',i=>text(i.job.salary)],['地点',i=>i.job.location],['学历',i=>i.job.education],['经验 / 类型',i=>i.job.experience],['标签 / 福利',i=>i.job.tags.join(' · ')],['实际读取时间',i=>time(i.observed_at)],['工作地址',i=>i.job.detail?.address??''],['职位描述',i=>i.job.detail?.description??''],['个人备注',i=>i.note??'']];
  return <dialog ref={dialog} className="job-comparison" aria-labelledby="comparison-title" onCancel={onClose} onClose={onClose}>
    <div className="comparison-heading"><div><h2 id="comparison-title">岗位对比 · {items.length} 个</h2><p className="muted">按已读取的原文比较；日薪与月薪分别保留，未读取信息不推测。</p></div><button onClick={onClose} autoFocus>关闭对比</button></div>
    <div className="comparison-scroll"><table><thead><tr><th>比较项目</th>{items.map(i=><th key={i.job.url}><strong>{i.job.title}</strong><button onClick={()=>{onClose();onOpen(i.job.url);}}>查看原帖</button></th>)}</tr></thead><tbody>{rows.map(([label,value])=><tr key={label}><th scope="row">{label}</th>{items.map(i=><td key={i.job.url}><div className="comparison-value">{value(i)||'未读取'}</div></td>)}</tr>)}</tbody></table></div>
  </dialog>;
}
