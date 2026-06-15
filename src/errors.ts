// pi-crew structured error module — taxonomy mapping E001–E006.
/**
 * @fileoverview Error types and structured error handling for pi-crew.
 *
 * This module defines pi-crew's error taxonomy, mapping to semantic categories
 * matching fallow's E001-E004 pattern. It exports three main constructs:
 *
 * - {@link ErrorCode} — a `const` object and string-literal union type alias
 *   enumerating machine-readable error codes (E001–E006). Implemented as a
 *   `const` object rather than a TypeScript `enum` so that Node's
 *   `--experimental-strip-types` can load this module (enum syntax is not
 *   supported in strip-only mode).
 *
 * - {@link CrewError} — a structured `Error` subclass that carries an
 *   {@link ErrorCode}, an optional human-readable `help` hint, and an optional
 *   `context` string. Its `toString()` renders the display format:
 *   `error[E001]: Failed to read manifest.json: not found`.
 *
 * - {@link errors} — a factory object exposing convenience constructors
 *   (e.g. `errors.fileRead`, `errors.taskNotFound`) that build `CrewError`
 *   instances with sensible defaults and pre-attached context.
 */
// Implemented as const object + type alias (not `enum`) so that Node's
// `--experimental-strip-types` can load this module. TypeScript `enum`
// syntax is not supported in strip-only mode.
export const ErrorCode = {
  FileReadError: "E001",            // Cannot read a file
  FileWriteError: "E002",           // Cannot write a file
  TaskNotFound: "E003",             // Referenced task ID does not exist
  InvalidStatusTransition: "E004",  // Run/task status cannot legally transition
  ConfigError: "E005",              // Malformed config or missing required field
  ResourceNotFound: "E006",         // Agent/team/workflow not found in discovery paths
} as const;

export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

const DEFAULT_HELP: Record<ErrorCode, string | undefined> = {
  [ErrorCode.FileReadError]: "Check that the file exists and that the process has read permission.",
  [ErrorCode.FileWriteError]: "Check that the disk is not full and that the process has write permission.",
  [ErrorCode.TaskNotFound]: "The task may have been removed or the run may be in an inconsistent state. Use `team status` to verify.",
  [ErrorCode.InvalidStatusTransition]: "Verify the run status using `team status` before retrying.",
  [ErrorCode.ConfigError]: "Check the configuration file for syntax errors or missing required fields.",
  [ErrorCode.ResourceNotFound]: "Use `team list` to see available agents, teams, and workflows.",
};

/**
 * Structured error type for pi-crew.
 * Display format:
 *   error[E001]: Failed to read manifest.json: not found
 *     context: while loading run state
 *     help: Check that the file exists and that the process has read permission.
 */
export class CrewError extends Error {
  readonly code: ErrorCode;
  help?: string;
  private _context?: string;

  constructor(code: ErrorCode, message: string, help?: string) {
    super(message);
    this.name = "CrewError";
    this.code = code;
    this.help = help ?? DEFAULT_HELP[code];
    Object.defineProperty(this, "message", { enumerable: true });
    Object.defineProperty(this, "code", { enumerable: true });
  }

  withContext(context: string): this {
    this._context = context;
    return this;
  }

  withHelp(help: string): this {
    this.help = help;
    return this;
  }

  toString(): string {
    let out = `error[${this.code}]: ${this.message}`;
    if (this._context) out += `\n  context: ${this._context}`;
    if (this.help) out += `\n  help: ${this.help}`;
    return out;
  }
}

export const errors = {
  fileRead(path: string, source: NodeJS.ErrnoException): CrewError {
    return new CrewError(
      ErrorCode.FileReadError,
      `Failed to read ${path}: ${source.code?.toLowerCase() ?? "unknown"}`,
    ).withContext("file system read operation");
  },

  fileWrite(path: string, source: NodeJS.ErrnoException): CrewError {
    return new CrewError(
      ErrorCode.FileWriteError,
      `Failed to write ${path}: ${source.code?.toLowerCase() ?? "unknown"}`,
    ).withContext("file system write operation");
  },

  taskNotFound(taskId: string, runId?: string): CrewError {
    const msg = runId
      ? `Task '${taskId}' not found in run '${runId}'`
      : `Task '${taskId}' not found`;
    return new CrewError(ErrorCode.TaskNotFound, msg);
  },

  invalidStatusTransition(from: string, to: string): CrewError {
    return new CrewError(
      ErrorCode.InvalidStatusTransition,
      `Invalid run status transition: ${from} -> ${to}`,
    );
  },

  config(message: string): CrewError {
    return new CrewError(ErrorCode.ConfigError, message)
      .withContext("configuration loading");
  },

  resourceNotFound(type: string, name: string): CrewError {
    return new CrewError(
      ErrorCode.ResourceNotFound,
      `${type} '${name}' not found in any discovery path`,
    );
  },
} as const;