import { readFileSync } from "node:fs";
import { join } from "node:path";

import { errorMessage, hasErrorCode, TicketRunnerError } from "./errors.ts";

/** Effective validated configuration. */
export interface TicketRunnerConfig {
  /** Status values eligible for execution; every other value is skipped. */
  readonly runnableStatuses: readonly string[];
  /** Maximum child `turn_end` events during a ticket's implementation prompt. */
  readonly maxTurnsPerTicket: number;
  /** Minimum interval between live widget renders. */
  readonly liveWidgetUpdateIntervalMs: number;
  /** Age after which an unreadable-PID lock is reported as stale. */
  readonly staleLockHours: number;
}

export const DEFAULT_CONFIG: TicketRunnerConfig = {
  runnableStatuses: ["ready-for-agent"],
  maxTurnsPerTicket: 50,
  liveWidgetUpdateIntervalMs: 150,
  staleLockHours: 12,
};

const CONFIG_KEYS = [
  "runnableStatuses",
  "maxTurnsPerTicket",
  "liveWidgetUpdateIntervalMs",
  "staleLockHours",
] as const;

type ConfigKey = (typeof CONFIG_KEYS)[number];

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

  const paths = [
    join(options.agentDir, "ticket-runner.json"),
    join(options.cwd, ".pi", "ticket-runner.json"),
  ];

  for (const path of paths) {
    const raw = readConfigFile(path);
    if (!raw) continue;

    for (const [key, value] of Object.entries(raw)) {
      if (!isConfigKey(key)) {
        warnings.push(`Unknown configuration key "${key}" in ${path}.`);
        continue;
      }
      Object.assign(config, validateValue(key, value, path));
    }
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
    case "liveWidgetUpdateIntervalMs":
      return {
        liveWidgetUpdateIntervalMs: validateNonNegativeInteger(
          value,
          key,
          path,
          "a non-negative integer number of milliseconds",
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
  key: ConfigKey,
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
  key: ConfigKey,
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
  key: ConfigKey,
  path: string,
  expectation: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalid(path, key, expectation);
  }
  return value;
}

function invalid(path: string, key: ConfigKey, expectation: string): TicketRunnerError {
  return new TicketRunnerError(`Invalid configuration in ${path}: "${key}" must be ${expectation}.`);
}
