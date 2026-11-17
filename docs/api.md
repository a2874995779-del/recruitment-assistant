# 本机 API · contract_version=1

桌面专用 `recruitment:boss-browser` IPC 不开放 HTTP 端点，不注入远程网页。操作白名单：state/open/layout/back/forward/reload/stop/restart/read/job.open/save/salary.recognize/salary.confirm。layout 仅控制显示区域；job.open 仅接收无查询参数的 BOSS 岗位详情 URL；save 仅接受快照 ID 与该快照内岗位 URL。state 的 `page_kind` 为 JOBS/DETAIL/SECURITY/LOGIN/OTHER，URL 去除查询参数。read 遇到 SECURITY/LOGIN 明确拒绝，要求用户在原站处理。不存在发送、任意脚本执行、Cookies 或任意导航命令。网页预览不提供该桥。

本地岗位管理命令：`job.mark` 接受 `{id, mark}`，mark 为 CONSIDERING/INTERESTED/CONTACTED/REJECTED，仅能修改 BOSS IMPORT 岗位的个人标记，不改变招聘状态或执行任何发送。`job.list` 接受可选 `personal_mark`，在分页前筛选并返回每个岗位的 `personal_mark`（历史记录默认 CONSIDERING）。`browser-filter.get` 接受空对象，返回已应用的关键词、地区、学历、排除条件；`browser-filter.save` 严格校验这四个字段并持久保存。不更新调度器设置。个人标记保存在现有 settings 表的 job-mark:{岗位ID} 记录，筛选保存在 boss-browser-filter；不升级数据库结构。

基址：`http://127.0.0.1:4318/api/v1`。仅本机单用户；不是面向公网的账号认证服务。除 `GET /health` 外，需要 `Authorization: Bearer <运行目录 api-token 内容>`。不开放浏览器 CORS；桌面界面使用命名 IPC。错误响应为 `{ "error": { "code": "...", "message": "..." } }`，输入错误附 issues。

有 JSON 请求体时发送 `Content-Type: application/json`；无请求体的 connect/disconnect/reconcile 请求不要附空 JSON body。所有输入经过严格 Zod 校验，未知字段报错。ID 为 UUID，规则历史 ID 仅内部使用。分页 offset 默认 0，limit 默认 50，最大 200。

## 端点

以下路径省略 `/api/v1`：

0.2 新增 `POST /public/wllm91/read`，输入 `{ "url": "https://hbeu.91wllm.cn/teachin/view/id/252013" }`；返回页面类型、LIMITED 能力状态、公告或岗位、关联链接与覆盖限制。`GET /notices` 返回独立宣讲会记录。仍要求本机令牌；不依赖账号连接，不启用真实提交。

岗位新增 `published_date`（ISO 日期或 null），用于来源只给日期的情况；不会补成精确时间。数据库 schema_version=2，任务 contract_version=1 保持不变。独立预览程序只对自身本机 Origin 开放 `/api/v1/desktop-command` 白名单桥，普通 API 程序不开放浏览器访问。

| 方法 | 路径 | 功能/主要输入 |
| --- | --- | --- |
| GET | `/`、`/overview` | 版本、状态和能力概览 |
| GET / PUT | `/profile` | 学历、专业、毕业年份、经验、求职类型、城市 |
| GET / PUT | `/settings` | daily_action_limit、max_batch_size、quiet_hours、desktop_enabled、body_preview、run_hours |
| GET / POST | `/accounts` | platform=boss/wllm91、mode=MOCK/REAL、nickname、station |
| POST | `/accounts/:id/connect` | 模拟身份连接或真实待处理指引；无请求体 |
| POST | `/accounts/:id/disconnect` | 断开并使旧批次身份代次失效；无请求体 |
| GET | `/accounts/:id/capabilities` | 按动作查询能力、模式及限制 |
| POST | `/accounts/:id/sync` | kind=SYNC_JOBS/SYNC_MESSAGES，可选 plan_id，返回持久化任务，HTTP 202 |
| GET | `/jobs` | offset/limit/platform/mode/status/search/rule_id；search 检索岗位名称，rule_id 附匹配原因 |
| GET | `/jobs/:id` | 岗位、来源与修订 |
| POST | `/jobs/import` | 最多 500 个规范岗位；mode 必须 IMPORT；不访问 URL |
| GET / POST | `/rules` | name、root，创建 version=1 |
| PUT | `/rules/:id` | 同 ID 新版本，旧版本留档 |
| GET | `/rules/:id/versions` | 当前与历史版本 |
| POST | `/matches` | job_id、rule_id，返回 PASS/EXCLUDED/PENDING、分数及依据 |
| GET / POST | `/resumes` | name、filename、content_base64、note；PDF 最大 10 MB，新记录不可覆写 |
| GET / POST | `/plans` | account_id、keywords、cities、interval_seconds=300–3600、budget=1–100 |
| PATCH | `/plans/:id` | enabled=true/false，分页检查点保留 |
| POST | `/batches/preview` | job_ids、account_id、resume_id、rule_id、actions、greeting；返回 preview_hash |
| POST | `/batches` | 预览输入 + approved=true、preview_hash、idempotency_key |
| GET | `/batches`、`/batches/:id` | 批次冻结信息、动作及逐状态数量 |
| POST | `/batches/:id/control` | command=pause/resume/cancel，已发出动作仍需核实 |
| GET | `/actions` | offset/limit/status/batch_id/account_id/type |
| GET | `/actions/:id/attempts` | 动作尝试、版本和边界状态 |
| POST | `/actions/:id/reconcile` | 仅 UNKNOWN，创建核实任务，绝不重新提交；无请求体 |
| POST | `/actions/:id/report` | status=SUCCEEDED/FAILED_CONFIRMED、evidence；仅未知/待处理，标 USER_REPORTED |
| GET | `/ledger.csv` | 脱敏基础台账，UTF-8 BOM，CSV 公式前缀防护 |
| GET | `/tasks` | offset/limit/state |
| POST | `/tasks/:id/control` | command=pause/resume/cancel，运行中的任务不可取消已发出操作 |
| POST | `/queue/control` | paused=true/false，持久化全局停止新任务 |
| GET | `/messages` | offset/limit/account_id/unread=true/false |
| POST | `/messages/:id/read` | 仅本地已读，不修改平台状态；无请求体 |
| GET | `/notifications` | 站内及桌面渠道发送状态 |
| POST | `/notifications/:id/read` | 本地已读；无请求体 |
| GET / POST | `/companies` | name、nature_tags、evidence_url、verified、parent_id |
| GET / POST | `/sources` | company_id、url、type=OFFICIAL/ATS/DISCOVERY、application_url、verified；不启用采集 |
| POST | `/backups` | 数据库和简历快照；无请求体；离线恢复用 CLI |
| GET | `/diagnostics` | 不包含简历正文、消息、Cookie、令牌或请求 body 的诊断数据 |

PUT profile/settings 是完整替换语义；未提供的可选字段恢复默认值。时间记录使用 UTC，通知和运行时段按 Asia/Shanghai；start=end 表示整天。默认 desktop_enabled=false；仅启动 HTTP 时没有桌面通知 provider，开启后失败会保留站内通知和独立重试记录。

## 模拟闭环示例

启动后端后在第二个 PowerShell 终端执行。示例不使用真实个人账号或真实简历。

```powershell
$raBase = 'http://127.0.0.1:4318/api/v1'
$raDir = Join-Path $env:LOCALAPPDATA 'RecruitmentAssistant'
$raHeaders = @{ Authorization = 'Bearer ' + (Get-Content -LiteralPath (Join-Path $raDir 'api-token') -Raw).Trim() }
function Invoke-RaJson($path, $data, $method = 'Post') {
  $raBody = ConvertTo-Json -InputObject $data -Depth 15 -Compress
  Invoke-RestMethod "$raBase$path" -Method $method -Headers $raHeaders -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($raBody))
}

Invoke-RaJson '/profile' @{education='本科'; major='计算机科学与技术'; graduation_year=2027; experience_years=1} 'Put'
$raAccount = Invoke-RaJson '/accounts' @{platform='boss'; mode='MOCK'; nickname='[模拟] 我的账号'}
Invoke-RestMethod "$raBase/accounts/$($raAccount.id)/connect" -Method Post -Headers $raHeaders
Invoke-RaJson "/accounts/$($raAccount.id)/sync" @{kind='SYNC_JOBS'}
# 等待任务中心显示同步 DONE，然后查询
$raJobs = Invoke-RestMethod "$raBase/jobs?mode=MOCK" -Headers $raHeaders
$raJob = $raJobs.items | Where-Object external_job_id -eq 'sample-1' | Select-Object -First 1
$raRule = Invoke-RaJson '/rules' @{name='武汉岗位'; root=@{kind='condition'; field='locations'; op='IN'; value=@('武汉'); unknown='CONFIRM'}}
$raPdf = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("%PDF-1.4`n% MOCK ONLY`n%%EOF"))
$raResume = Invoke-RaJson '/resumes' @{name='[模拟] 简历'; filename='demo.pdf'; content_base64=$raPdf}
$raInput = @{job_ids=@($raJob.id); account_id=$raAccount.id; resume_id=$raResume.id; rule_id=$raRule.id; actions=@('GREETING','SEND_RESUME')}
$raPreview = Invoke-RaJson '/batches/preview' $raInput
$raPreview | ConvertTo-Json -Depth 15
# 查阅摘要后再确认，规则/岗位/账号/额度变化会使哈希失效
$raInput.approved = $true
$raInput.preview_hash = $raPreview.preview_hash
$raInput.idempotency_key = [Guid]::NewGuid().ToString()
$raBatch = Invoke-RaJson '/batches' $raInput
Invoke-RestMethod "$raBase/batches/$($raBatch.id)" -Headers $raHeaders
```

若同平台 MOCK 账号已存在，先从 GET accounts 选择既有账号，或使用独立运行目录。不要把 UNKNOWN 动作改成 QUEUED；通过 reconcile 或 report 处理。

## 规则结构

```json
{
  "name": "武汉，月薪下限 10K",
  "root": {
    "kind": "group", "op": "AND",
    "children": [
      {"kind":"condition","field":"locations","op":"IN","value":["武汉"],"effect":"MUST","unknown":"CONFIRM"},
      {"kind":"condition","field":"salary","op":"LOWER_BOUND","value":10000,"currency":"CNY","salary_period":"MONTH","unknown":"CONFIRM"}
    ]
  }
}
```

字段：title、company_name、locations、education、majors、graduation_years、recruitment_type、employment_type、tags、company_nature、platform、salary、experience_range。

effect=MUST/EXCLUDE/PREFER；unknown=ALLOW/EXCLUDE/CONFIRM。分组 AND/OR，最多 10 层、200 节点。偏好仅评分，不使硬规则通过。未经证据核实的企业性质视为未知。salary 必须带币种与周期，LOWER_BOUND/GTE/LTE 使用数值，INTERSECTS 使用 [最小,最大]；不同单位不自动换算。文字条件用 EQ/IN/CONTAINS。

## 岗位导入

```json
[
  {
    "external_job_id": "manual-job-001",
    "source_instance_id": "manual:company-001",
    "source_url": "https://example.com/careers/job-001",
    "platform": "wllm91",
    "mode": "IMPORT",
    "title": "人工导入岗位",
    "company_name": "人工核实企业",
    "locations": ["武汉"],
    "status": "UNVERIFIED",
    "apply_target": {"kind":"EXTERNAL","url":"https://example.com/apply/job-001"}
  }
]
```

其他字段默认 null/未知，不推断发布时间、专业、毕业年份和企业性质。导入不抓取 URL，也不等于申请成功。若提供 deadline_at，必须同时提供 deadline_precision=DATE/INSTANT 和合法 deadline_timezone；日期精度保留整日语义。

## 常见状态与恢复

- PREVIEW_CHANGED：重新读取预览再确认，禁止复用旧哈希。
- DUPLICATE_ACTION：用户、账号、来源岗位、动作已入台账；更换简历不会解除唯一约束。
- BLOCKED：资料、资格、能力或外链需要用户处理。纠正资料/规则后可对未曾提交的任务显式 resume，执行时重新检查。
- UNKNOWN：已跨提交边界但无可靠结果；系统仅核实。若仍未知，等待用户人工记录，不能自动重投。
- ACCOUNT_CHANGED：旧批次身份代次失效。本版不支持自动重新授权旧批次；可人工记结果，新批次仍受动作去重约束。
- 每日额度与运行时段采用批准快照和当前配置中更严格的限制；队列等待，不强行执行。消息默认 120 秒，岗位计划默认 900 秒；这些是模拟配置，不表示平台许可频率。

模型与校验的完整定义见 `packages/contracts/src/index.ts`。

薪资操作 salary.recognize / salary.confirm 均仅接受 {snapshot_id, url}，不能传脚本、图片、字体地址或自定义数字。识别在当前已加载岗位列表中按需执行，结果为待核对候选与绘制图；确认只修改本地快照，保存岗位时才采用候选，并保留薪资来源及原始字符。新快照不复用旧数字映射。
