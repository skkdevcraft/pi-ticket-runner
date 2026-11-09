import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type Extension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

/** An event emitted by a child ticket session. */
export type ChildEvent = AgentSessionEvent;

/**
 * The seam between the runner and a child Pi session.
 *
 * Everything the runner needs from a session is expressed here, so the loop and
 * its failure paths can be tested against a fake without an LLM or a real SDK
 * session.
 */
export interface TicketSession {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: ChildEvent) => void): () => void;
  getLastAssistantText(): string | undefined;
  dispose(): void;
}

/** Options for creating a fresh child session. */
export interface CreateTicketSessionOptions {
  /** Main project working directory, shared with the child. */
  readonly cwd: string;
  /** Pi agent directory, source of global resources. */
  readonly agentDir: string;
  /** Path of this extension's entry file, filtered out of child resource loading. */
  readonly extensionPath: string;
  /** Main session's model, inherited by the child. */
  readonly model?: CreateAgentSessionOptions["model"] | undefined;
  /** Main session's thinking level, inherited by the child. */
  readonly thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"] | undefined;
}

export type TicketSessionFactory = (
  options: CreateTicketSessionOptions,
) => Promise<TicketSession>;

/**
 * Remove this extension from a child's resources, preserving every other
 * extension, diagnostic, and the shared extension runtime.
 *
 * The pinned SDK identifies a loaded extension by path and registered
 * commands rather than by a display name. Matching the path handles ordinary
 * installs; the command fallback keeps the filter effective when an install is
 * linked or relocated.
 */
export function filterTicketRunnerExtension(
  base: LoadExtensionsResult,
  extensionPath: string,
): LoadExtensionsResult {
  const target = canonicalPath(extensionPath);
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !isTicketRunnerExtension(extension, target)),
  };
}

/**
 * Create a fresh, persistent child session.
 *
 * The child inherits the project directory, model, and thinking level, keeps
 * the default coding tools, and discovers the normal project resources. Only
 * this extension is filtered out, so the implement skill and other extensions
 * remain available. Omitting `sessionManager` keeps Pi's default persistent
 * manager; `dispose()` never deletes the session file.
 */
export async function createTicketSession(
  options: CreateTicketSessionOptions,
): Promise<TicketSession> {
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    extensionsOverride: (base) => filterTicketRunnerExtension(base, options.extensionPath),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    resourceLoader,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
  });

  return new SdkTicketSession(session);
}

/** Adapter from Pi's `AgentSession` to the {@link TicketSession} port. */
class SdkTicketSession implements TicketSession {
  private readonly session: AgentSession;

  constructor(session: AgentSession) {
    this.session = session;
  }

  prompt(text: string): Promise<void> {
    return this.session.prompt(text);
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  subscribe(listener: (event: ChildEvent) => void): () => void {
    return this.session.subscribe(listener);
  }

  getLastAssistantText(): string | undefined {
    return this.session.getLastAssistantText();
  }

  dispose(): void {
    this.session.dispose();
  }
}

function isTicketRunnerExtension(extension: Extension, target: string): boolean {
  if (extension.commands.has("ticket-runner")) return true;

  const paths = [extension.path, extension.resolvedPath, extension.sourceInfo.path];
  return paths.some((path) => canonicalPath(path) === target);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
