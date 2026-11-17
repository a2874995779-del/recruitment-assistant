import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z, ZodError } from "zod";
import type { RecruitmentService } from "../../../packages/application/src/service.js";
import type { Scheduler } from "../../../packages/scheduler/src/index.js";
import { AppError } from "../../../packages/domain/src/errors.js";
import type {
  Message,
  Rule,
  Task,
} from "../../../packages/contracts/src/index.js";
import { createBackup } from "../../../packages/persistence/src/backup.js";
import { type NotificationRecord } from "../../../packages/notifications/src/index.js";
import { desktopCommand } from "../../../packages/application/src/desktop-commands.js";

const idParam = z.object({ id: z.string().uuid() });
const paramId = (params: unknown) => idParam.parse(params).id;
const commandSchema = z
  .object({ command: z.enum(["pause", "resume", "cancel"]) })
  .strict();
const pageSchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function createServer(
  service: RecruitmentService,
  scheduler: Scheduler,
  token: string,
  preview?: { origin: string; directory: string },
): FastifyInstance {
  const app = Fastify({
    logger: {
      level: "warn",
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 15 * 1024 * 1024,
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    if (
      request.headers.origin &&
      (!preview || request.headers.origin !== preview.origin)
    )
      throw new AppError("ORIGIN_DENIED", "浏览器跨源访问未启用", 403);
    const host = request.headers.host?.split(":")[0];
    if (host && !["127.0.0.1", "localhost"].includes(host))
      throw new AppError("HOST_DENIED", "只接受本机访问", 403);
    if (
      preview &&
      (request.url === "/" || request.url.startsWith("/preview/"))
    ) {
      if (
        request.method !== "GET" ||
        request.headers["sec-fetch-site"] === "cross-site"
      )
        throw new AppError(
          "PREVIEW_ORIGIN_DENIED",
          "本地预览只接受直接或同源访问",
          403,
        );
      return;
    }
    if (request.url.split("?")[0] === "/health") return;
    const expected = Buffer.from(`Bearer ${token}`);
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new AppError(
        "UNAUTHORIZED",
        "请使用运行目录中的本地 API 令牌",
        401,
      );
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply
        .code(400)
        .send({
          error: {
            code: "VALIDATION_ERROR",
            message: "输入不合法",
            issues: error.issues.map((i) => ({
              path: i.path,
              message: i.message,
            })),
          },
        });
      return;
    }
    if (error instanceof AppError) {
      reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
      return;
    }
    const sqlite = (error as Error).message;
    if (sqlite.includes("UNIQUE constraint failed")) {
      reply
        .code(409)
        .send({
          error: {
            code: "DUPLICATE_RECORD",
            message: "记录已存在，操作已去重",
          },
        });
      return;
    }
    const code = (error as { statusCode?: number }).statusCode;
    if (code && code >= 400 && code < 500) {
      reply
        .code(code)
        .send({
          error: {
            code: "INVALID_REQUEST",
            message: "请求格式不合法或超过大小限制",
          },
        });
      return;
    }
    app.log.error({ code: "INTERNAL_ERROR" }, "请求失败");
    reply
      .code(500)
      .send({
        error: { code: "INTERNAL_ERROR", message: "内部错误，请查看脱敏诊断" },
      });
  });
  app.get("/health", async () => ({
    status: "ok",
    version: "0.2.0",
    schema_version: 2,
    contract_version: 1,
  }));
  app.get("/api/v1", async () => ({
    name: "招聘助手",
    version: "0.2.0",
    scope: "desktop and backend",
    documentation: "docs/api.md",
    real_adapters: "UNVERIFIED",
    hbeu_public_read: "LIMITED",
  }));
  app.get("/api/v1/overview", async () => service.overview());
  app.get("/api/v1/profile", async () => service.getProfile());
  app.put("/api/v1/profile", async (request) =>
    service.saveProfile(request.body),
  );
  app.get("/api/v1/settings", async () => service.getSettings());
  app.put("/api/v1/settings", async (request) =>
    service.saveSettings(request.body),
  );
  app.get("/api/v1/accounts", async () => service.store.all("accounts"));
  app.post("/api/v1/accounts", async (request, reply) =>
    reply.code(201).send(service.createAccount(request.body)),
  );
  app.post("/api/v1/accounts/:id/connect", async (request) =>
    service.connectAccount(paramId(request.params)),
  );
  app.post("/api/v1/accounts/:id/disconnect", async (request) =>
    service.disconnectAccount(paramId(request.params)),
  );
  app.get("/api/v1/accounts/:id/capabilities", async (request) =>
    service.capabilities(paramId(request.params)),
  );
  app.post("/api/v1/accounts/:id/sync", async (request, reply) => {
    const input = z
      .object({
        kind: z.enum(["SYNC_JOBS", "SYNC_MESSAGES"]),
        plan_id: z.string().uuid().optional(),
      })
      .strict()
      .parse(request.body);
    return reply
      .code(202)
      .send(
        service.enqueueSync(paramId(request.params), input.kind, input.plan_id),
      );
  });
  app.get("/api/v1/jobs", async (request) =>
    service.listJobs(
      pageSchema
        .extend({
          platform: z.enum(["boss", "wllm91"]).optional(),
          mode: z.enum(["MOCK", "REAL", "IMPORT"]).optional(),
          status: z
            .enum(["ACTIVE", "CLOSED", "EXPIRED", "UNVERIFIED"])
            .optional(),
          search: z.string().max(200).optional(),
          rule_id: z.string().uuid().optional(),
        })
        .strict()
        .parse(request.query),
    ),
  );
  app.get("/api/v1/jobs/:id", async (request) => ({
    job: service.get("jobs", paramId(request.params)),
    revisions: service.store
      .all<{ job_id: string }>("job_revisions")
      .filter((r) => r.job_id === paramId(request.params)),
    source: service.store.get("job_sources", paramId(request.params)),
  }));
  app.post("/api/v1/jobs/import", async (request, reply) =>
    reply.code(201).send(service.importJobs(request.body)),
  );
  app.post("/api/v1/public/wllm91/read", async (request) =>
    service.readPublicPage(
      z
        .object({ url: z.string().max(2048) })
        .strict()
        .parse(request.body).url,
    ),
  );
  app.get("/api/v1/notices", async () => service.store.all("notices"));
  app.get("/api/v1/rules", async () =>
    service.store.all<Rule>("rules").filter((r) => !r.id.includes("@")),
  );
  app.post("/api/v1/rules", async (request, reply) =>
    reply.code(201).send(service.createRule(request.body)),
  );
  app.put("/api/v1/rules/:id", async (request) =>
    service.updateRule(paramId(request.params), request.body),
  );
  app.get("/api/v1/rules/:id/versions", async (request) => [
    service.latestRule(paramId(request.params)),
    ...service.store
      .all<Rule & { rule_id?: string }>("rules")
      .filter((r) => r.rule_id === paramId(request.params)),
  ]);
  app.post("/api/v1/matches", async (request) => {
    const input = z
      .object({ job_id: z.string().uuid(), rule_id: z.string().uuid() })
      .strict()
      .parse(request.body);
    return service.match(input.job_id, input.rule_id);
  });
  app.get("/api/v1/resumes", async () => service.store.all("resumes"));
  app.post("/api/v1/resumes", async (request, reply) =>
    reply.code(201).send(service.importResume(request.body)),
  );
  app.get("/api/v1/plans", async () => service.store.all("search_plans"));
  app.post("/api/v1/plans", async (request, reply) =>
    reply.code(201).send(service.createPlan(request.body)),
  );
  app.patch("/api/v1/plans/:id", async (request) =>
    service.setPlanEnabled(
      paramId(request.params),
      z.object({ enabled: z.boolean() }).strict().parse(request.body).enabled,
    ),
  );
  app.post("/api/v1/batches/preview", async (request) =>
    service.previewBatch(request.body),
  );
  app.post("/api/v1/batches", async (request, reply) =>
    reply.code(201).send(service.createBatch(request.body)),
  );
  app.get("/api/v1/batches", async () =>
    service.store
      .all<{ id: string }>("batches")
      .map((b) => service.batchDetail(b.id)),
  );
  app.get("/api/v1/batches/:id", async (request) =>
    service.batchDetail(paramId(request.params)),
  );
  app.post("/api/v1/batches/:id/control", async (request) =>
    service.controlBatch(
      paramId(request.params),
      commandSchema.parse(request.body).command,
    ),
  );
  app.get("/api/v1/actions", async (request) => {
    const query = pageSchema
      .extend({
        status: z.string().max(50).optional(),
        batch_id: z.string().uuid().optional(),
        account_id: z.string().uuid().optional(),
        type: z
          .enum(["GREETING", "SEND_RESUME", "APPLY", "EXTERNAL_APPLICATION"])
          .optional(),
      })
      .strict()
      .parse(request.query);
    const all = service.store
      .all<{
        status: string;
        batch_id: string;
        account_id: string;
        type: string;
      }>("actions")
      .filter(
        (a) =>
          (!query.status || a.status === query.status) &&
          (!query.batch_id || a.batch_id === query.batch_id) &&
          (!query.account_id || a.account_id === query.account_id) &&
          (!query.type || a.type === query.type),
      );
    return {
      total: all.length,
      items: all.slice(query.offset, query.offset + query.limit),
    };
  });
  app.post("/api/v1/actions/:id/reconcile", async (request, reply) =>
    reply.code(202).send(service.reconcile(paramId(request.params))),
  );
  app.post("/api/v1/actions/:id/report", async (request) =>
    service.reportAction(paramId(request.params), request.body),
  );
  app.get("/api/v1/actions/:id/attempts", async (request) =>
    service.store
      .all<{ action_id: string }>("attempts")
      .filter((a) => a.action_id === paramId(request.params)),
  );
  app.get("/api/v1/ledger.csv", async (_request, reply) =>
    reply
      .header("Content-Disposition", 'attachment; filename="applications.csv"')
      .type("text/csv; charset=utf-8")
      .send(service.ledgerCsv()),
  );
  app.get("/api/v1/tasks", async (request) => {
    const q = pageSchema
      .extend({ state: z.string().max(50).optional() })
      .strict()
      .parse(request.query);
    const all = service.store
      .all<Task>("tasks")
      .filter((t) => !q.state || t.state === q.state);
    return {
      total: all.length,
      items: all.slice(q.offset, q.offset + q.limit),
    };
  });
  app.post("/api/v1/tasks/:id/control", async (request) =>
    scheduler.controlTask(
      paramId(request.params),
      commandSchema.parse(request.body).command,
    ),
  );
  app.post("/api/v1/queue/control", async (request) =>
    scheduler.pause(
      z.object({ paused: z.boolean() }).strict().parse(request.body).paused,
    ),
  );
  app.get("/api/v1/messages", async (request) => {
    const q = pageSchema
      .extend({
        account_id: z.string().uuid().optional(),
        unread: z.enum(["true", "false"]).optional(),
      })
      .strict()
      .parse(request.query);
    const all = service.store
      .all<Message>("messages")
      .filter(
        (m) =>
          (!q.account_id || m.account_id === q.account_id) &&
          (!q.unread || m.local_read === (q.unread === "false")),
      );
    return {
      total: all.length,
      items: all.slice(q.offset, q.offset + q.limit),
    };
  });
  app.post("/api/v1/messages/:id/read", async (request) => {
    const message = service.get<Message>("messages", paramId(request.params));
    return service.store.put("messages", { ...message, local_read: true });
  });
  app.get("/api/v1/notifications", async () =>
    service.store.all("notifications"),
  );
  app.post("/api/v1/notifications/:id/read", async (request) => {
    const n = service.get<NotificationRecord>(
      "notifications",
      paramId(request.params),
    );
    return service.store.put("notifications", { ...n, read: true });
  });
  app.get("/api/v1/companies", async () => service.store.all("companies"));
  app.post("/api/v1/companies", async (request, reply) =>
    reply.code(201).send(service.sources.createCompany(request.body)),
  );
  app.get("/api/v1/sources", async () => service.store.all("sources"));
  app.post("/api/v1/sources", async (request, reply) =>
    reply.code(201).send(service.sources.createSource(request.body)),
  );
  app.post("/api/v1/backups", async () => createBackup(service));
  app.get("/api/v1/diagnostics", async () => ({
    version: "0.2.0",
    schema_version: 2,
    contract_version: 1,
    generated_at: new Date().toISOString(),
    scheduler_error: scheduler.lastError ? "SCHEDULER_ERROR" : null,
    audit: service.store.all("audit"),
    tasks: service.store
      .all<Task>("tasks")
      .map((t) => ({
        id: t.id,
        kind: t.kind,
        state: t.state,
        attempts: t.attempts,
        error: t.error?.match(/^[A-Z_]+$/) ? t.error : "SEE_LOCAL_STATUS",
      })),
  }));
  if (preview) {
    app.get("/", async (_request, reply) => reply.redirect("/preview/"));
    app.get("/preview/", async (_request, reply) =>
      reply
        .type("text/html; charset=utf-8")
        .send(readFileSync(join(preview.directory, "index.html"))),
    );
    app.get("/preview/bridge.js", async (_request, reply) =>
      reply
        .type("application/javascript")
        .send(
          `if(location.origin===${JSON.stringify(preview.origin)}){window.recruitment=Object.freeze({command:async(operation,payload={})=>{const r=await fetch('/api/v1/desktop-command',{method:'POST',headers:{'Content-Type':'application/json',Authorization:${JSON.stringify("Bearer " + token)}},body:JSON.stringify({operation,payload})});if(!r.ok){const e=await r.json();return {ok:false,error:e.error};}return r.json();},openSource:async(raw)=>{const u=new URL(raw);if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password)window.open(u.href,'_blank','noopener,noreferrer');}});}`,
        ),
    );
    app.get("/preview/assets/:file", async (request, reply) => {
      const { file } = z
        .object({ file: z.string().regex(/^[a-zA-Z0-9_.-]+$/) })
        .parse(request.params);
      const assets = new Set(readdirSync(join(preview.directory, "assets")));
      if (!assets.has(file)) throw new AppError("NOT_FOUND", "资源不存在", 404);
      return reply
        .type(file.endsWith(".css") ? "text/css" : "application/javascript")
        .send(readFileSync(join(preview.directory, "assets", file)));
    });
    app.post("/api/v1/desktop-command", async (request) => {
      const p = z
        .object({ operation: z.string(), payload: z.unknown() })
        .strict()
        .parse(request.body);
      return desktopCommand(service, scheduler, p.operation, p.payload);
    });
  }
  return app;
}
