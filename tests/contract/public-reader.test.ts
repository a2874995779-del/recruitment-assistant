import test from "node:test";
import assert from "node:assert/strict";
import {
  publicUrl,
  parsePublicPage,
  PublicWllmReader,
} from "../../packages/adapters/wllm91/src/public-reader.js";
const base = "https://hbeu.91wllm.cn";
// Minimal, synthetic HTML uses the publicly observed layout, with no private fields.
const company = `<body><div class="title-message"><h5>测试企业</h5></div><table><tr><td><div class="info-text"><a href="/job/view/id/100">测试岗位</a><ul><li>3500-4499</li><li>湖北省武汉市</li><li>实习</li><li>本科</li></ul></div></td><td><div class="middle-container"><div title="计算机类、教育学类"></div></div></td></tr></table>单位性质：其他企业 单位行业：教育</body>`;
const detail = `<body><div class="title-message"><h5>测试岗位</h5><div class="message-info"><span class="salary">3500-4499</span><span class="education">| 湖北省武汉市 | 实习 | 本科</span></div></div><p>2026-09-02发布</p><p>需求专业：计算机类、教育学类 职位详情</p><a href="/company/view/id/200">测试企业</a></body>`;
test("public reader canonicalizes only verified school page routes", () => {
  assert.equal(
    publicUrl(base + "/company/view/id/200?target=_blank").href,
    base + "/company/view/id/200/tab/1",
  );
  for (const url of [
    "http://hbeu.91wllm.cn/job/view/id/1",
    "https://evil.91wllm.cn/job/view/id/1",
    base + ":444/job/view/id/1",
    base + "/login",
    "https://user:secret@hbeu.91wllm.cn/job/view/id/1",
    "https://127.0.0.1/job/view/id/1",
  ])
    assert.throws(() => publicUrl(url));
});
test("teach-in is saved as notice rather than a job; no hidden content executes", () => {
  const page = parsePublicPage(
    '<body><h5>测试宣讲</h5>宣讲日期：2026-10-09 宣讲时间：14:30-17:00 <a href="/company/view/id/200">测试企业</a><script>throw new Error("never execute")</script></body>',
    base + "/teachin/view/id/1",
  );
  assert.equal(page.jobs.length, 0);
  assert.equal(page.notice?.event_date, "2026-10-09");
  assert.equal(page.notice?.venue, null);
  assert.equal(page.links[0]?.url, base + "/company/view/id/200/tab/1");
});
test("company rows preserve unknown units and detail dates retain date precision", () => {
  const list = parsePublicPage(company, base + "/company/view/id/200/tab/1");
  const j = list.jobs[0]!;
  assert.equal(j.salary_min, 3500);
  assert.equal(j.currency, null);
  assert.equal(j.salary_period, null);
  assert.equal(j.graduation_years, null);
  assert.equal(j.status, "UNVERIFIED");
  assert.equal(j.apply_target.kind, "UNKNOWN");
  assert.equal(j.nature_verified, false);
  const page = parsePublicPage(detail, base + "/job/view/id/100");
  assert.equal(page.jobs[0]?.published_date, "2026-09-02");
  assert.equal(page.jobs[0]?.published_at, null);
  assert.deepEqual(page.jobs[0]?.majors, ["计算机类", "教育学类"]);
  assert.equal(page.jobs[0]?.description, null);
  assert.throws(() =>
    parsePublicPage("<h5>请先登录</h5>", base + "/job/view/id/100"),
  );
  assert.throws(() =>
    parsePublicPage(
      "<h5>企业</h5><table></table>",
      base + "/company/view/id/200/tab/1",
    ),
  );
});
test("fetch is cookie-free, bounded, does not follow redirects, and observes cooldown", async () => {
  let calls = 0;
  const reader = new PublicWllmReader((async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.credentials, "omit");
    assert.equal((init?.headers as Record<string, string>).Cookie, undefined);
    return new Response(company, { headers: { "content-type": "text/html" } });
  }) as typeof fetch);
  await reader.read(base + "/company/view/id/200");
  await assert.rejects(reader.read(base + "/company/view/id/200"), /5 秒/);
  assert.equal(calls, 1);
  const redirects = new PublicWllmReader(
    (async () =>
      new Response("", {
        status: 302,
        headers: { location: "https://evil.example/" },
      })) as typeof fetch,
    0,
  );
  await assert.rejects(redirects.read(base + "/job/view/id/100"), /302/);
  const oversized = new PublicWllmReader(
    (async () =>
      new Response("x", {
        headers: { "content-type": "text/html", "content-length": "9999999" },
      })) as typeof fetch,
    0,
  );
  await assert.rejects(oversized.read(base + "/job/view/id/100"), /上限/);
});
