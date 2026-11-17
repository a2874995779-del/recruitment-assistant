import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { setup } from "../helpers.js";
import { desktopCommand } from "../../packages/application/src/desktop-commands.js";
import type { Job } from "../../packages/contracts/src/index.js";

test("greeting without a PDF survives the worker flow, records no attachment and stays deduplicated", async () => {
  const h = await setup();
  try {
    unlinkSync(join(h.directory, "resumes", h.resume.file_ref));
    const { resume_id: _resume, ...request } = {
      ...h.input,
      actions: ["GREETING"],
      greeting: "测试招呼",
    } as Record<string, unknown>;
    const approved = h.approve(request);
    const response = await h.app.inject({
      method: "POST",
      url: "/api/v1/batches",
      headers: h.headers,
      payload: approved,
    });
    assert.equal(response.statusCode, 201, response.body);
    const batch = response.json();
    assert.equal(batch.resume_id, null);
    assert.equal(batch.resume_hash, null);
    await h.scheduler.tick({ schedule: false });
    const action = h.service.batchDetail(batch.id).actions[0]!;
    assert.equal(action.status, "SUCCEEDED");
    assert.equal(action.type, "GREETING");
    assert.equal(action.evidence_kind, "MOCK_VERIFIED");
    assert.equal(h.store.all("attempts").length, 1);
    const retry = await h.app.inject({
      method: "POST",
      url: "/api/v1/batches",
      headers: h.headers,
      payload: { ...approved, resume_id: null },
    });
    assert.equal(retry.json().id, batch.id);
    assert.throws(
      () =>
        h.service.createBatch({
          ...approved,
          idempotency_key: "dup-greet-2",
        }),
      /已存在/,
    );
    assert.match(h.service.ledgerCsv(), /GREETING/);
  } finally {
    await h.cleanup();
  }
});

test("attachment actions and mixed batches cannot bypass PDF validation by omitting resume", async () => {
  const h = await setup();
  try {
    for (const actions of [
      ["SEND_RESUME"],
      ["GREETING", "SEND_RESUME"],
      ["APPLY"],
    ]) {
      const response = await h.app.inject({
        method: "POST",
        url: "/api/v1/batches",
        headers: h.headers,
        payload: { ...h.input, resume_id: null, actions },
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.throws(
        () =>
          h.service.previewBatch({
            job_ids: [h.job.id],
            account_id: h.account.id,
            rule_id: h.rule.id,
            actions,
          }),
        /PDF/,
      );
    }
    assert.equal(h.store.all("batches").length, 0);
    assert.equal(h.store.all("attempts").length, 0);
  } finally {
    await h.cleanup();
  }
});

test("BOSS job filter excludes campus jobs through the desktop command boundary", async () => {
  const h = await setup();
  try {
    const campus = h.service.createAccount({
      platform: "wllm91",
      mode: "MOCK",
      nickname: "校园测试账号",
    });
    await h.service.connectAccount(campus.id);
    h.service.enqueueSync(campus.id, "SYNC_JOBS");
    await h.scheduler.tick({ schedule: false });
    for (const platform of ["boss", "wllm91"]) {
      const result = await desktopCommand(h.service, h.scheduler, "job.list", {
        platform,
      });
      if (!result.ok) throw new Error(result.error.message);
      const data = result.data as { items: Job[]; total: number };
      assert.equal(data.total, 4);
      assert.ok(data.items.every((job) => job.platform === platform));
    }
    assert.equal(
      (
        await desktopCommand(h.service, h.scheduler, "job.list", {
          platform: "other",
        })
      ).ok,
      false,
    );
  } finally {
    await h.cleanup();
  }
});
