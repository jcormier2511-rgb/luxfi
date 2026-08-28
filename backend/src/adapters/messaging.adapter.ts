export interface OutboundButton {
  label: string;
  action: string;
}

export interface OutboundMessage {
  recipientCanonicalUserId: string;
  text: string;
  imageUrl?: string | null;
  buttons?: OutboundButton[];
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

export interface MessagingAdapter {
  send(message: OutboundMessage): Promise<SendResult>;
}

/**
 * MVP transport: no live WhatsApp/Telegram send credentials or webhook are wired
 * up in this session's repo (there was nothing to inspect/continue -- see the
 * implementer summary). This adapter exists so notification persistence,
 * idempotency, and the Approve/Pass message shape can be built and tested
 * against a stable interface; a real WhatsApp/Telegram adapter can be dropped
 * in later by implementing MessagingAdapter and swapping getMessagingAdapter().
 */
export class StubMessagingAdapter implements MessagingAdapter {
  public sent: OutboundMessage[] = [];

  async send(message: OutboundMessage): Promise<SendResult> {
    this.sent.push(message);
    // eslint-disable-next-line no-console
    console.log(`[stub-messaging] -> ${message.recipientCanonicalUserId}: ${message.text}`);
    return { ok: true };
  }
}

let adapter: MessagingAdapter | undefined;

export function getMessagingAdapter(): MessagingAdapter {
  if (!adapter) {
    adapter = new StubMessagingAdapter();
  }
  return adapter;
}

export function setMessagingAdapter(custom: MessagingAdapter): void {
  adapter = custom;
}
