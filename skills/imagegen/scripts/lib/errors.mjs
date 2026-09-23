export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 1;
  }
}

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

export class GuardError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

export class ApiError extends Error {
  constructor(message, status = 0, code = null) {
    super(message);
    this.exitCode = 5;
    this.status = status;
    this.code = code;
  }
}
