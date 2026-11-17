import { useCallback, useState } from "react";
import { SavedJobs } from "./SavedJobs.js";
import type { DesktopBridge } from "../../../../packages/contracts/src/desktop.js";
import { BossWorkspace } from "./BossWorkspace.js";
import { SearchWorkspace } from "./SearchWorkspace.js";

import "./shell.css";

declare global { interface Window { recruitment?: DesktopBridge; } }
export function App() {
  const [page, setPage] = useState<"browser" | "saved" | "search">("search");
  const [revision, setRevision] = useState(0), [error, setError] = useState("");
  const onSaved = useCallback(() => setRevision(n => n+1), []);
  const onOpen = useCallback((url: string) => {
    setPage("browser"); setError("");
    void (async () => {
      try {
        const bridge = window.recruitment?.bossBrowser;
        if (!bridge) { await window.recruitment?.openSource(url); return; }
        const result = await bridge.request("job.open", { url });
        if (!result.ok) throw new Error(result.error);
      } catch(e) { setError(e instanceof Error ? e.message : "打开岗位失败"); }
    })();
  }, []);
  const tabs=[["browser","BOSS 网页"],["saved","已保存岗位"],["search","岗位搜索"]] as const;
  return <div className="plugin-app">
    <header className="app-topbar">
      <strong className="brand"><img className="brand-mark" src="./icon.png" alt=""/>求职助手</strong>
      <nav aria-label="工具页面">{tabs.map(([key,label])=><button key={key} aria-current={page===key?"page":undefined} onClick={()=>setPage(key)}>{label}</button>)}</nav>
      <small className="read-only-label">CyuBack制作，仅个人使用<span className="license-badge" title="本软件为 CyuBack 专属，禁止任何形式的商业使用">CyuBack 专属 · 禁止商用</span></small>
    </header>
    {error && <div role="alert" className="app-error">{error}<button onClick={() => setError("")}>关闭</button></div>}
    <main className="plugin-main"><div hidden={page !== "browser"} className="browser-page"><BossWorkspace active={page === "browser"} onSaved={onSaved} revision={revision} /></div><div hidden={page !== "saved"} className="saved-page"><SavedJobs active={page === "saved"} revision={revision} onOpen={onOpen} onBrowser={()=>setPage("browser")} onSaved={onSaved} /></div><div hidden={page!=="search"} className="search-page"><SearchWorkspace active={page==="search"} onBrowser={()=>setPage("browser")} onOpen={onOpen} onSaved={onSaved}/></div></main>
  </div>;
}
