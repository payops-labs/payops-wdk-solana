export type PayOpsWdkErrorCode =
  | "expired_attempt"
  | "invalid_attempt"
  | "invalid_finalization_options"
  | "invalid_lifetime"
  | "invalid_payer"
  | "invalid_rpc_config"
  | "invalid_rpc_response"
  | "invalid_signature"
  | "tampered_payment_url"
  | "unsupported_asset";

export class PayOpsWdkError extends Error {
  readonly code: PayOpsWdkErrorCode;

  constructor(code: PayOpsWdkErrorCode, message: string) {
    super(message);
    this.name = "PayOpsWdkError";
    this.code = code;
  }
}
