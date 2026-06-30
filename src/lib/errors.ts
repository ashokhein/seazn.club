/** Thrown by auth helpers; maps to HTTP 401. */
export class AuthError extends Error {}

/** Thrown inside handlers to emit a specific HTTP status code. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
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
