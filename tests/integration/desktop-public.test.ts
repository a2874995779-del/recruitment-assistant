import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "../helpers.js";
import { desktopCommand } from "../../packages/application/src/desktop-commands.js";
import { parsePublicPage } from "../../packages/adapters/wllm91/src/public-reader.js";
import type { Job } from "../../packages/contracts/src/index.js";
test("desktop commands preserve strict whitelist and profile/settings can roundtrip after reload", async () => {
  const h = await setup();
  try {
    assert.equal(
      (await desktopCommand(h.service, h.scheduler, "db.raw")).ok,
      false,
    );
    assert.equal(
      (
        await desktopCommand(h.service, h.scheduler, "queue.control", {
          paused: "yes",
        })
      ).ok,
      false,
    );
    const profile = h.service.getProfile();
    assert.equal("id" in profile, false);
    h.service.saveProfile(profile);
    h.service.saveSettings(h.service.getSettings());
    assert.equal(
      (await desktopCommand(h.service, h.scheduler, "snapshot")).ok,
      true,
    );
  } finally {
    await h.cleanup();
  }
});
test("public notices dedupe independently and read failure preserves committed records", async () => {
  const h = await setup();
  try {
    const url = "https://hbeu.91wllm.cn/teachin/view/id/1";
    const page = parsePublicPage(
      "<body><h5>测试宣讲</h5>宣讲日期：2026-10-09</body>",
      url,
    );
    h.service.publicReader.read = async () => page;
    const before = h.store.all<Job>("jobs").length;
    await h.service.readPublicPage(url);
    await h.service.readPublicPage(url);
    assert.equal(h.store.all("notices").length, 1);
    assert.equal(h.store.all<Job>("jobs").length, before);
    h.service.publicReader.read = async () => {
      throw new Error("temporary failure");
    };
    await assert.rejects(h.service.readPublicPage(url));
    assert.equal(h.store.all("notices").length, 1);
  } finally {
    await h.cleanup();
  }
});
test("re-reading a public listing keeps detail publication dates and never verifies application status", async () => {
  const h = await setup();
  try {
    const input = { ...h.job, id: undefined };
    const {
      id: _id,
      user_id: _user,
      schema_version: _schema,
      content_hash: _hash,
      first_seen_at: _first,
      last_seen_at: _last,
      last_verified_at: _verified,
      ...raw
    } = input;
    const publicJob = {
      ...raw,
      mode: "REAL" as const,
      platform: "wllm91" as const,
      source_instance_id: "public:wllm91:hbeu",
      external_job_id: "1",
      published_at: null,
      published_date: "2026-09-02",
      status: "UNVERIFIED" as const,
      apply_target: {
        kind: "UNKNOWN" as const,
        url: "https://hbeu.91wllm.cn/job/view/id/1",
      },
    };
    const base = {
      source_url: "https://hbeu.91wllm.cn/job/view/id/1",
      observed_at: new Date().toISOString(),
      notice: null,
      links: [],
      warnings: [],
      capability: "LIMITED" as const,
    };
    h.service.publicReader.read = async () => ({
      ...base,
      kind: "JOB",
      jobs: [publicJob],
    });
    await h.service.readPublicPage(base.source_url);
    h.service.publicReader.read = async () => ({
      ...base,
      kind: "COMPANY_JOBS",
      jobs: [{ ...publicJob, published_date: null }],
    });
    await h.service.readPublicPage(base.source_url);
    const record = h.store.findSourceJob("REAL", "public:wllm91:hbeu:1")!;
    assert.equal(record.published_date, "2026-09-02");
    assert.equal(record.last_verified_at, null);
    assert.equal(record.status, "UNVERIFIED");
    assert.throws(() =>
      h.service.createBatch({ ...h.input, job_ids: [record.id] }),
    );
  } finally {
    await h.cleanup();
  }
});
