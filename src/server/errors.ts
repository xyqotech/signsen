/** Stable error codes; the UI translates them, logs keep the code. */
export type ErrorCode =
  | "validation"
  | "not_found"
  | "forbidden"
  | "invalid_state"
  | "email_taken"
  | "invalid_credentials"
  | "signup_disabled"
  | "rate_limited"
  | "reset_link_invalid"
  | "invalid_pdf"
  | "pdf_encrypted"
  | "pdf_too_large"
  | "consent_required"
  | "signature_required"
  | "otp_missing"
  | "otp_invalid"
  | "otp_expired"
  | "otp_locked";

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "DomainError";
  }
}

export function isDomainError(e: unknown, code?: ErrorCode): e is DomainError {
  return e instanceof DomainError && (code === undefined || e.code === code);
}
