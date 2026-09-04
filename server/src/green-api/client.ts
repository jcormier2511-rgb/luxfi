import axios from "axios";
import { config } from "../config.js";

/**
 * Thin wrapper around the Green API (green-api.com) REST endpoints Fi needs:
 * sending a 1:1 DM. Fi never posts back into monitored groups — it only
 * reads them — so no sendMessage-to-group helper is exposed here.
 */

function instanceUrl(method: string): string {
  const { baseUrl, idInstance, apiTokenInstance } = config.greenApi;
  return `${baseUrl}/waInstance${idInstance}/${method}/${apiTokenInstance}`;
}

export interface SendMessageResult {
  idMessage: string;
}

export async function sendDirectMessage(chatId: string, message: string): Promise<SendMessageResult> {
  if (!config.greenApi.idInstance || !config.greenApi.apiTokenInstance) {
    // Local/dev fallback so the rest of the pipeline can be exercised without
    // live WhatsApp credentials configured.
    console.log(`[green-api:dry-run] -> ${chatId}: ${message}`);
    return { idMessage: `dry-run-${Date.now()}` };
  }

  const { data } = await axios.post<SendMessageResult>(instanceUrl("sendMessage"), {
    chatId,
    message,
  });
  return data;
}
