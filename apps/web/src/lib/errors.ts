/** Thrown by auth helpers; maps to HTTP 401. */
export class AuthError extends Error {}

/** Thrown inside handlers to emit a specific HTTP status code. `code`
 *  overrides the generic status→code mapping in the /api/v1 envelope (e.g.
 *  LINK_EXPIRED on a 401 so the device-link pad can render it, doc 13 §7). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

/** Thrown by entitlement gates; maps to HTTP 402. */
export class PaymentRequiredError extends HttpError {
  constructor(public readonly featureKey: string) {
    super(402, `Plan upgrade required: ${featureKey}`);
  }
}
