import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setup } from "../helpers.js";
import { createServer } from "../../apps/api/src/server.js";
test("optional local preview permits its own origin and keeps commands authenticated", async () => {
  const h = await setup(),
    assets = mkdtempSync(join(tmpdir(), "recruitment-preview-test-"));
  mkdirSync(join(assets, "assets"));
  writeFileSync(join(assets, "index.html"), "<h1>test</h1>");
  writeFileSync(join(assets, "assets", "app.js"), "// test");
  const token = "preview-private-token-abcdefghijklmnopqrstuvwxyz",
    origin = "http://127.0.0.1:4319",
    app = createServer(h.service, h.scheduler, token, {
      origin,
      directory: assets,
    });
  try {
    assert.equal(
      (await app.inject({ method: "GET", url: "/preview/" })).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/preview/bridge.js",
          headers: { "sec-fetch-site": "cross-site" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: "GET", url: "/preview/assets/missing.js" }))
        .statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/desktop-command",
          payload: { operation: "snapshot", payload: {} },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/desktop-command",
          headers: {
            authorization: `Bearer ${token}`,
            origin: "https://evil.example",
          },
          payload: { operation: "snapshot", payload: {} },
        })
      ).statusCode,
      403,
    );
    const allowed = await app.inject({
      method: "POST",
      url: "/api/v1/desktop-command",
      headers: { authorization: `Bearer ${token}`, origin },
      payload: { operation: "snapshot", payload: {} },
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.json().ok, true);
    assert.equal(
      (await h.app.inject({ method: "GET", url: "/preview/" })).statusCode,
      401,
    );
  } finally {
    await app.close();
    rmSync(assets, { recursive: true, force: true });
    await h.cleanup();
  }
});
