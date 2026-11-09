import { readFileSync } from "node:fs";
import { join } from "node:path";

import { errorMessage, hasErrorCode, TicketRunnerError } from "./errors.ts";

/** Effective validated configuration. */
export interface TicketRunnerConfig {
  /** Status values eligible for execution; every other value is skipped. */
  readonly runnableStatuses: readonly string[];
  /** Maximum child `turn_end` events during a ticket's implementation prompt. */
  readonly maxTurnsPerTicket: number;
  /** Minimum interval between live session-frame renders. */
  readonly liveFrameUpdateIntervalMs: number;
  /** Maximum lines rendered in one expanded child transcript. */
  readonly expandedTranscriptMaxLines: number;
  /** Maximum UTF-8 bytes rendered in one expanded child transcript. */
  readonly expandedTranscriptMaxBytes: number;
  /** Age after which an unreadable-PID lock is reported as stale. */
  readonly staleLockHours: number;
}

export const DEFAULT_CONFIG: TicketRunnerConfig = {
  runnableStatuses: ["ready-for-agent"],
  maxTurnsPerTicket: 50,
  liveFrameUpdateIntervalMs: 150,
  expandedTranscriptMaxLines: 1000,
  expandedTranscriptMaxBytes: 131072,
  staleLockHours: 12,
};

const CONFIG_KEYS = [
  "runnableStatuses",
  "maxTurnsPerTicket",
  "liveFrameUpdateIntervalMs",
  "expandedTranscriptMaxLines",
  "expandedTranscriptMaxBytes",
  "staleLockHours",
] as const;

type ConfigKey = (typeof CONFIG_KEYS)[number];

/**
 * Deprecated keys accepted as aliases for canonical settings.
 *
 * An alias is only applied when no file supplies its canonical key, so the
 * frame setting always wins over the widget name regardless of file order.
 */
const DEPRECATED_ALIASES = {
  liveWidgetUpdateIntervalMs: "liveFrameUpdateIntervalMs",
} as const;

type DeprecatedAlias = keyof typeof DEPRECATED_ALIASES;

/** Result of loading configuration. Warnings are non-fatal. */
export interface ConfigLoadResult {
  readonly config: TicketRunnerConfig;
  readonly warnings: readonly string[];
}

/** Options for {@link loadConfig}. */
export interface LoadConfigOptions {
  /** Project working directory; the project configuration lives under `.pi/`. */
  readonly cwd: string;
  /** Pi agent directory, normally `~/.pi/agent`, holding the global configuration. */
  readonly agentDir: string;
}

/**
 * Load configuration from the global and project locations.
 *
 * Project values override global values per key. Missing files are not an
 * error. Unknown keys are reported as warnings; invalid values throw a
 * descriptive {@link TicketRunnerError}.
 */
export function loadConfig(options: LoadConfigOptions): ConfigLoadResult {
  const warnings: string[] = [];
  const config: {
    -readonly [K in keyof TicketRunnerConfig]: TicketRunnerConfig[K];
  } = {
    ...DEFAULT_CONFIG,
    runnableStatuses: [...DEFAULT_CONFIG.runnableStatuses],
  };

  let aliasIntervalMs: number | undefined;
  let frameIntervalProvided = false;

  const paths = [
    join(options.agentDir, "ticket-runner.json"),
    join(options.cwd, ".pi", "ticket-runner.json"),
  ];

  for (const path of paths) {
    const raw = readConfigFile(path);
    if (!raw) continue;

    for (const [key, value] of Object.entries(raw)) {
      if (isDeprecatedAlias(key)) {
        aliasIntervalMs = validateNonNegativeInteger(
          value,
          key,
          path,
          "a non-negative integer number of milliseconds",
        );
        continue;
      }
      if (!isConfigKey(key)) {
        warnings.push(`Unknown configuration key "${key}" in ${path}.`);
        continue;
      }
      if (key === "liveFrameUpdateIntervalMs") {
        frameIntervalProvided = true;
      }
      Object.assign(config, validateValue(key, value, path));
    }
  }

  if (!frameIntervalProvided && aliasIntervalMs !== undefined) {
    config.liveFrameUpdateIntervalMs = aliasIntervalMs;
  }

  return { config, warnings };
}

function readConfigFile(path: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw new TicketRunnerError(`Cannot read configuration file ${path}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TicketRunnerError(
      `Invalid JSON in configuration file ${path}: ${errorMessage(error)}`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TicketRunnerError(`Invalid configuration in ${path}: expected a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

function isDeprecatedAlias(key: string): key is DeprecatedAlias {
  return Object.hasOwn(DEPRECATED_ALIASES, key);
}

function validateValue(
  key: ConfigKey,
  value: unknown,
  path: string,
): Partial<Pick<TicketRunnerConfig, ConfigKey>> {
  switch (key) {
    case "runnableStatuses":
      return { runnableStatuses: validateRunnableStatuses(value, path) };
    case "maxTurnsPerTicket":
      return {
        maxTurnsPerTicket: validatePositiveInteger(
          value,
          key,
          path,
          "a positive integer number of turns",
        ),
      };
    case "liveFrameUpdateIntervalMs":
      return {
        liveFrameUpdateIntervalMs: validateNonNegativeInteger(
          value,
          key,
          path,
          "a non-negative integer number of milliseconds",
        ),
      };
    case "expandedTranscriptMaxLines":
      return {
        expandedTranscriptMaxLines: validatePositiveInteger(
          value,
          key,
          path,
          "a positive integer number of lines",
        ),
      };
    case "expandedTranscriptMaxBytes":
      return {
        expandedTranscriptMaxBytes: validatePositiveInteger(
          value,
          key,
          path,
          "a positive integer number of bytes",
        ),
      };
    case "staleLockHours":
      return {
        staleLockHours: validatePositiveNumber(value, key, path, "a positive number of hours"),
      };
  }
}

function validateRunnableStatuses(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw invalid(path, "runnableStatuses", "an array of status strings");
  }

  const statuses: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw invalid(path, "runnableStatuses", "an array of status strings");
    }
    const status = entry.trim().toLowerCase();
    if (status.length === 0) {
      throw invalid(path, "runnableStatuses", "an array of non-empty status strings");
    }
    statuses.push(status);
  }
  return statuses;
}

function validatePositiveInteger(
  value: unknown,
  key: string,
  path: string,
  expectation: string,
): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw invalid(path, key, expectation);
  }
  return value as number;
}

function validateNonNegativeInteger(
  value: unknown,
  key: string,
  path: string,
  expectation: string,
): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw invalid(path, key, expectation);
  }
  return value as number;
}

function validatePositiveNumber(
  value: unknown,
  key: string,
  path: string,
  expectation: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalid(path, key, expectation);
  }
  return value;
}

function invalid(path: string, key: string, expectation: string): TicketRunnerError {
  return new TicketRunnerError(`Invalid configuration in ${path}: "${key}" must be ${expectation}.`);
}
