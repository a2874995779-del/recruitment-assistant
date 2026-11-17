import { useState } from "react";
import { type MatchingPreferences } from "../../../../packages/contracts/src/boss-matching.js";

export function MatchingPanel({value,onSave}:{value:MatchingPreferences;onSave:(next:MatchingPreferences)=>Promise<void>}) {
  const [draft,setDraft]=useState(value),[busy,setBusy]=useState(false);
  const change=(key:keyof MatchingPreferences,value:string|boolean)=>setDraft(old=>({...old,[key]:value}));
  return <details className="matching-panel"><summary>匹配偏好与排序{value.enabled?" · 已开启":""}</summary>
    <form className="matching-form" onSubmit={event=>{event.preventDefault();setBusy(true);void onSave(draft).finally(()=>setBusy(false));}}><fieldset disabled={busy}>
      <label className="matching-toggle"><input type="checkbox" checked={draft.enabled} onChange={e=>change("enabled",e.target.checked)}/>按匹配分数排序</label>
      <label>目标岗位词（任一命中）<input value={draft.title} maxLength={200} placeholder="如 Java 后端" onChange={e=>change("title",e.target.value)}/></label>
      <label>期望地区<input value={draft.city} maxLength={80} placeholder="如 武汉；北京" onChange={e=>change("city",e.target.value)}/></label>
      <label>我的技能词<input value={draft.skills} maxLength={300} placeholder="如 Java Spring SQL" onChange={e=>change("skills",e.target.value)}/></label>
      <label>不考虑的关键词<input value={draft.exclude} maxLength={200} placeholder="如 销售 外包" onChange={e=>change("exclude",e.target.value)}/></label>
      <small>名称 50、地区 20、技能 30，按已填写项目折算。缺失信息不加分；排除词命中单独标记。分数是关键词匹配程度，不能替代资格核实。薪资不参与评分。</small>
      <button type="submit">{busy?"保存中…":"保存匹配偏好"}</button>
    </fieldset></form>
  </details>;
}
