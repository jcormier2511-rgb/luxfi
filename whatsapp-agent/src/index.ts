import { config } from "./config";
import { createServer } from "./server";

const app = createServer();

app.listen(config.server.port, () => {
  console.log(`LuxFi WhatsApp agent listening on port ${config.server.port}`);
  console.log(`Webhook URL to configure in GreenAPI: https://<your-host>/webhook?token=${config.server.webhookToken}`);
});
