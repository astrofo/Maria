const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

process.env.NODE_ENV = "test";
process.env.DATABASE_MODE = process.env.TEST_DATABASE_URL
  ? "postgres"
  : "pglite";
process.env.DATABASE_PATH = "memory://";
if (process.env.TEST_DATABASE_URL)
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { database } = require("../src/db");
const { migrate } = require("../src/migrate");
const { runAutomation } = require("../src/automation");

test("Event reminders appear once per group and date, including late participants", async (t) => {
  await migrate(database);
  t.after(() => database.close());
  const people = [];
  for (let index = 0; index < 3; index++) {
    people.push(
      (
        await database.query(
          "INSERT INTO users(full_name,email,password_hash,status) VALUES('Reminder fixture',$1,'unusable','active') RETURNING id",
          [`reminder-${randomUUID()}@example.test`],
        )
      ).rows[0].id,
    );
  }
  const event = (
    await database.query(
      "INSERT INTO opportunities(title,description,starts_at) VALUES('Group reminder fixture','Local test',NOW()+INTERVAL '10 hours') RETURNING id",
    )
  ).rows[0].id;
  for (const user of people.slice(0, 2)) {
    await database.query(
      "INSERT INTO applications(opportunity_id,user_id,status) VALUES($1,$2,'accepted')",
      [event, user],
    );
  }
  const reminders = async () =>
    (
      await database.query(
        `SELECT m.* FROM group_messages m JOIN group_threads g ON g.id=m.group_id
     WHERE g.opportunity_id=$1 AND m.source_key LIKE 'reminder:%' ORDER BY m.id`,
        [event],
      )
    ).rows;
  let result = await runAutomation(database);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.counts.event_reminders, 2);
  assert.equal((await reminders()).length, 1);
  assert.equal((await reminders())[0].kind, "system");
  result = await runAutomation(database);
  assert.equal(result.counts.event_reminders, 0);
  assert.equal((await reminders()).length, 1);

  // A new recipient must receive a personal reminder without repeating the
  // announcement already visible to everyone in the event's group.
  await database.query(
    "INSERT INTO applications(opportunity_id,user_id,status) VALUES($1,$2,'accepted')",
    [event, people[2]],
  );
  result = await runAutomation(database);
  assert.equal(result.counts.event_reminders, 1);
  assert.equal((await reminders()).length, 1);
  await database.query(
    "UPDATE opportunities SET starts_at=NOW()+INTERVAL '1 hour' WHERE id=$1",
    [event],
  );
  result = await runAutomation(database);
  assert.equal(result.counts.event_reminders, 3);
  const messages = await reminders();
  assert.equal(messages.length, 2);
  assert.match(messages[1].body, /2 часов/);
  await database.query("UPDATE opportunities SET status='closed' WHERE id=$1", [
    event,
  ]);
  result = await runAutomation(database);
  assert.equal(result.counts.event_reminders, 0);
  assert.equal((await reminders()).length, 2);
});
