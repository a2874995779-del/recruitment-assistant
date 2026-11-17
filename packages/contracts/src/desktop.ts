export const desktopOperations = [
  "snapshot",
  "profile.save",
  "settings.save",
  "account.create",
  "account.connect",
  "account.disconnect",
  "account.sync",
  "public.read",
  "job.list",
  "job.detail",
  "job.mark",
  "job.note",
  "saved.list",
  "greeting-config.get",
  "greeting-config.save",
  "browser-filter.get",
  "browser-filter.save",
  "matching.get",
  "matching.save",
  "search-config.get",
  "search-config.save",
  "search-run.get",
  "search-saved.get",
  "search-presets.list",
  "search-presets.save",
  "search-presets.delete",
  "jobs.import",
  "rule.save",
  "resume.import",
  "batch.preview",
  "batch.create",
  "batch.control",
  "action.reconcile",
  "action.report",
  "task.control",
  "queue.control",
  "message.read",
  "company.create",
  "source.create",
  "ledger.csv",
  "backup.create",
  "demo.load",
] as const;
export type DesktopOperation = (typeof desktopOperations)[number];
export type CommandResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };
export type DesktopBridge = {
  bossBrowser?: import("./boss-browser.js").BossBrowserBridge;
  command: (
    operation: DesktopOperation,
    payload?: unknown,
  ) => Promise<CommandResult>;
  openSource: (url: string) => Promise<void>;
};
