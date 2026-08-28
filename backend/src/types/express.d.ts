// Augments Express's Request with the raw request body, captured by the
// express.json() verify callback in app.ts so WhatsApp webhook signature
// verification (which must hash the exact bytes Meta sent) has something to
// check against -- the parsed/re-serialized JSON body would not match.
import 'express';

declare module 'express-serve-static-core' {
  interface Request {
    rawBody?: Buffer;
  }
}
