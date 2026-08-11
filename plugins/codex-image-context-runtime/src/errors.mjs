export class RuntimeError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.definitive = options.definitive === true;
    this.dispatchStarted = options.dispatchStarted === true;
  }
}

export function fail(code, message, options) {
  throw new RuntimeError(code, message, options);
}

export function closedErrorCode(error, fallback = "RUNTIME_FAILURE") {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code
    : fallback;
}
