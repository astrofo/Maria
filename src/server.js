require("dotenv").config();
const { database } = require("./db");
const { migrate } = require("./migrate");
const { createApp } = require("./app");
const { startAutomation } = require("./automation");
const { startNotificationQueue } = require("./notification-queue");
const { createMailer } = require("./mail");
const { startLoginCodeDelivery } = require("./login-code");
const { startCampaignDelivery } = require("./messaging");
async function start() {
  await database.ready;
  await migrate();
  const mailer = createMailer();
  const app = createApp({ mailer });
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, process.env.HOST || "0.0.0.0");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  console.log(`Volunteer portal listening on port ${port}`);
  const stopAutomation = startAutomation({ db: database });
  const stopNotifications = startNotificationQueue(database);
  const stopLoginCodes = startLoginCodeDelivery({ db: database, mailer });
  const stopCampaigns = startCampaignDelivery({ db: database });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 30000);
    deadline.unref();
    try {
      await Promise.all([
        stopAutomation(),
        stopNotifications(),
        stopLoginCodes(),
        stopCampaigns(),
        new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
      await database.close();
      clearTimeout(deadline);
      process.exit(0);
    } catch {
      console.error("Shutdown failed");
      process.exit(1);
    }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}
if (require.main === module)
  start().catch(async (e) => {
    console.error("Startup failed:", e.message);
    await database.close();
    process.exitCode = 1;
  });
module.exports = { start };
