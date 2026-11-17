import { z, ZodError } from "zod";
import { HBEU_TEMPLATE } from "../../adapters/wllm91/src/public-reader.js";
import {
  desktopOperations,
  type CommandResult,
} from "../../contracts/src/desktop.js";
import type { Account, Message, Rule } from "../../contracts/src/index.js";
import { AppError } from "../../domain/src/errors.js";
import type { RecruitmentService } from "./service.js";
import type { Scheduler } from "../../scheduler/src/index.js";
import { createBackup } from "../../persistence/src/backup.js";
import { jobMarkSchema, jobNoteSchema, savedJobQuerySchema } from "../../contracts/src/job-management.js";

const id = z.object({ id: z.string().uuid() });
const control = id
  .extend({ command: z.enum(["pause", "resume", "cancel"]) })
  .strict();
export async function desktopCommand(
  service: RecruitmentService,
  scheduler: Scheduler,
  rawOperation: unknown,
  payload: unknown = {},
): Promise<CommandResult> {
  try {
    const op = z.enum(desktopOperations).parse(rawOperation);
    let data: unknown;
    switch (op) {
      case 'greeting-config.get': z.object({}).strict().parse(payload);data=service.getGreetingConfig();break;
      case 'greeting-config.save': data=service.saveGreetingConfig(payload);break;
      case 'saved.list': data=service.listSavedJobs(savedJobQuerySchema.parse(payload));break;
      case 'job.note': {const p=id.extend({note:jobNoteSchema}).strict().parse(payload);data=service.noteJob(p.id,p.note);break;}
      case "search-config.get": z.object({}).strict().parse(payload);data=service.getBossSearchConfig();break;
      case "search-config.save": data=service.saveBossSearchConfig(payload);break;
      case "search-run.get": z.object({}).strict().parse(payload);data=service.getBossSearchRun();break;
      case "search-saved.get": z.object({}).strict().parse(payload);data=service.savedBossUrls();break;
      case "search-presets.list": z.object({}).strict().parse(payload);data=service.listSearchPresets();break;
      case "search-presets.save": data=service.saveSearchPreset(payload);break;
      case "search-presets.delete": data=service.deleteSearchPreset(id.strict().parse(payload).id);break;
      case "snapshot":
        data = {
          overview: service.overview(),
          profile: service.getProfile(),
          settings: service.getSettings(),
          accounts: service.store
            .all<Account>("accounts")
            .map((a) => ({ ...a, capabilities: service.capabilities(a.id) })),
          rules: service.store
            .all<Rule>("rules")
            .filter((r) => !r.id.includes("@")),
          resumes: service.store.all("resumes"),
          batches: service.store
            .all<{ id: string }>("batches")
            .map((b) => service.batchDetail(b.id)),
          tasks: service.store.all("tasks"),
          messages: service.store.all("messages"),
          companies: service.store.all("companies"),
          sources: service.store.all("sources"),
          notices: service.store.all("notices"),
          plans: service.store.all("search_plans"),
          template: HBEU_TEMPLATE,
        };
        break;
      case "profile.save":
        data = service.saveProfile(payload);
        break;
      case "settings.save":
        data = service.saveSettings(payload);
        break;
      case "browser-filter.get":
        z.object({}).strict().parse(payload);
        data = service.getBrowserFilter();
        break;
      case "browser-filter.save":
        data = service.saveBrowserFilter(payload);
        break;
      case "matching.get":
        z.object({}).strict().parse(payload);
        data=service.getMatchingPreferences();
        break;
      case "matching.save":
        data=service.saveMatchingPreferences(payload);
        break;
      case "job.mark": {
        const p = id.extend({ mark: jobMarkSchema }).strict().parse(payload);
        data = service.markJob(p.id, p.mark);
        break;
      }
      case "account.create":
        data = service.createAccount(payload);
        break;
      case "account.connect":
        data = await service.connectAccount(id.strict().parse(payload).id);
        break;
      case "account.disconnect":
        data = await service.disconnectAccount(id.strict().parse(payload).id);
        break;
      case "account.sync": {
        const p = id
          .extend({ kind: z.enum(["SYNC_JOBS", "SYNC_MESSAGES"]) })
          .strict()
          .parse(payload);
        data = service.enqueueSync(p.id, p.kind);
        break;
      }
      case "public.read":
        data = await service.readPublicPage(
          z
            .object({ url: z.string().max(2048) })
            .strict()
            .parse(payload).url,
        );
        break;
      case "job.list":
        data = service.listJobs(
          z
            .object({
              offset: z.number().int().min(0).default(0),
              limit: z.number().int().min(1).max(200).default(50),
              search: z.string().max(200).optional(),
              platform: z.enum(["boss", "wllm91"]).optional(),
              mode: z.enum(["MOCK", "REAL", "IMPORT"]).optional(),
              rule_id: z.string().uuid().optional(),
              personal_mark: jobMarkSchema.optional(),
            })
            .strict()
            .parse(payload),
        );
        break;
      case "job.detail": {
        const p = id.strict().parse(payload);
        data = {
          job: service.get("jobs", p.id),
          revisions: service.store
            .all<{ job_id: string }>("job_revisions")
            .filter((r) => r.job_id === p.id),
        };
        break;
      }
      case "jobs.import":
        data = service.importJobs(payload);
        break;
      case "rule.save": {
        const p = z
          .object({ id: z.string().uuid().optional(), input: z.unknown() })
          .strict()
          .parse(payload);
        data = p.id
          ? service.updateRule(p.id, p.input)
          : service.createRule(p.input);
        break;
      }
      case "resume.import":
        data = service.importResume(payload);
        break;
      case "batch.preview":
        data = service.previewBatch(payload);
        break;
      case "batch.create":
        data = service.createBatch(payload);
        break;
      case "batch.control": {
        const p = control.parse(payload);
        data = service.controlBatch(p.id, p.command);
        break;
      }
      case "action.reconcile":
        data = service.reconcile(id.strict().parse(payload).id);
        break;
      case "action.report": {
        const p = id
          .extend({
            status: z.enum(["SUCCEEDED", "FAILED_CONFIRMED"]),
            evidence: z.string().min(1).max(2000),
          })
          .strict()
          .parse(payload);
        data = service.reportAction(p.id, {
          status: p.status,
          evidence: p.evidence,
        });
        break;
      }
      case "task.control": {
        const p = control.parse(payload);
        data = scheduler.controlTask(p.id, p.command);
        break;
      }
      case "queue.control":
        data = scheduler.pause(
          z.object({ paused: z.boolean() }).strict().parse(payload).paused,
        );
        break;
      case "message.read": {
        const m = service.get<Message>(
          "messages",
          id.strict().parse(payload).id,
        );
        data = service.store.put("messages", { ...m, local_read: true });
        break;
      }
      case "company.create":
        data = service.sources.createCompany(payload);
        break;
      case "source.create":
        data = service.sources.createSource(payload);
        break;
      case "ledger.csv":
        data = service.ledgerCsv();
        break;
      case "backup.create":
        data = await createBackup(service);
        break;
      case "demo.load": {
        let account = service.store.find<Account>(
          "accounts",
          (a) => a.platform === "boss" && a.mode === "MOCK",
        );
        account ??= service.createAccount({
          platform: "boss",
          mode: "MOCK",
          nickname: "BOSS 流程演示",
        });
        if (account.status !== "CONNECTED")
          await service.connectAccount(account.id);
        service.enqueueSync(account.id, "SYNC_JOBS");
        service.enqueueSync(account.id, "SYNC_MESSAGES");
        data = {
          account_id: account.id,
          note: "已加入模拟同步队列，档案及简历需自行填写。",
        };
        break;
      }
    }
    return { ok: true, data };
  } catch (error) {
    if (error instanceof ZodError)
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("；"),
        },
      };
    if (error instanceof AppError)
      return { ok: false, error: { code: error.code, message: error.message } };
    return {
      ok: false,
      error: {
        code: "COMMAND_FAILED",
        message: "操作失败，请检查输入或查看本地诊断。",
      },
    };
  }
}
