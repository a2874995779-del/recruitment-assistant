# 招聘助手

基于 Electron、React、TypeScript 和 SQLite 的本地求职工作台，支持岗位搜索、筛选、保存、对比及手动原帖核实。

## 环境与运行

需要 Node.js 22.16 或更新版本及 npm。

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run build
npm.cmd run desktop
```

也可双击项目中的“启动招聘助手.cmd”。首次桌面启动需要下载 Electron。

## 常用命令

- `npm run dev`：本地 API，默认监听 127.0.0.1:4318。
- `npm run preview`：独立浏览器预览。
- `npm run demo`：使用临时目录运行模拟数据演示。
- `npm run check`：类型检查与自动化测试。
- `npm run package:windows`：构建 Windows 分发包。

## 数据与配置

默认运行数据位于本机 `%LOCALAPPDATA%/RecruitmentAssistant`，不在源码目录内。可参照 `.env.example` 设置端口和独立数据目录；应用从运行环境读取配置。浏览器登录及验证由使用者在原站完成。

此仓库仅包含项目源码、依赖锁文件、通用文档及测试。没有附带数据库、简历、登录会话、Cookie、令牌、个人岗位收藏、沟通记录、运行日志或历史验收截图。BOSS JSON 示例已替换为虚构数据，不能当作真实招聘信息。91wllm 分站仅作为公开适配示例，不代表使用者个人信息。

请勿提交运行目录或真实账号资料；敏感文件和运行数据已列入 `.gitignore`。

## 功能说明

- [本地 API](docs/api.md)
- [已保存岗位](docs/saved-jobs.md)
- [招呼语与沟通模块](docs/saved-greeting.md)

搜索、原帖核实和沟通依赖第三方页面兼容性；真实平台兼容性及消息送达不由离线测试保证。沟通模块需要逐条预览确认，无法确认结果时保留待核实状态。请遵守招聘平台规则。源码保留原有作者标识与使用限制。
