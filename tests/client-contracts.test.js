const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { allowedRoutes } = require("../src/assistant-knowledge");

test("Assistant exposes group navigation to members and import only to managers", () => {
  const routes = (role) => allowedRoutes({ role }).map((route) => route.href);
  assert.equal(routes("guest").includes("#groups"), false);
  for (const role of ["volunteer", "coordinator", "manager", "admin"])
    assert.equal(routes(role).includes("#groups"), true);
  for (const role of ["guest", "volunteer", "coordinator"])
    assert.equal(routes(role).includes("#questionnaire-import"), false);
  for (const role of ["manager", "admin"])
    assert.equal(routes(role).includes("#questionnaire-import"), true);
});

test("Frontend client keeps import confirmation and message identifiers explicit", async () => {
  const source = await fs.readFile(
    path.join(__dirname, "../integration/api-client.js"),
    "utf8",
  );
  const { createApiClient } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
  const calls = [];
  const client = createApiClient({
    fetchImpl: async (url, options) => {
      if (url === "/api/auth/csrf")
        return Response.json({ csrfToken: "test-csrf" });
      calls.push({
        url,
        options,
        body: options.body && JSON.parse(options.body),
      });
      return Response.json({ ok: true });
    },
  });
  await client.questionnaireImport.preview(
    "full_name,email\nАнна,anna@example.test",
  );
  await client.questionnaireImport.apply("reviewed-token");
  const id = "52757d9c-8781-4f15-9618-0cf849d95115";
  await client.groups.send(7, "Увидимся на встрече", id);
  await client.groups.messages(7, { after_id: 12 });
  await client.groups.direct(7, 2);
  await client.groups.unreadCount();
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "/api/questionnaire-import/preview",
      "/api/questionnaire-import/apply",
      "/api/groups/7/messages",
      "/api/groups/7/messages?after_id=12",
      "/api/groups/7/direct",
      "/api/groups/unread-count",
    ],
  );
  assert.deepEqual(calls[1].body, {
    preview_token: "reviewed-token",
    confirm: true,
  });
  assert.equal(calls[2].body.client_id, id);
  assert.equal(calls[2].body.kind, "message");
  assert.equal(calls[2].options.headers.get("X-CSRF-Token"), "test-csrf");
  assert.throws(() => client.groups.messages("../admin"), TypeError);
});
