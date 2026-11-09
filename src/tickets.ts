import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { errorMessage, hasErrorCode, TicketRunnerError } from "./errors.ts";
import { parseTicketStatus } from "./status.ts";

/** `<NN>-<slug>.md`, where `NN` is one or more digits. */
const TICKET_FILENAME_PATTERN = /^(\d+)-(.+)\.md$/;

/** The first level-one heading in the file. */
const LEVEL_ONE_HEADING_PATTERN = /^#\s+(.+?)\s*$/m;

/** A leading ticket number on the heading text, with its separator. */
const LEADING_TICKET_NUMBER_PATTERN = /^\d+\s*(?:[:.)\-–—]|\s)\s*(.*)$/;

/** A ticket discovered in the supplied folder. */
export interface Ticket {
  /** Numeric prefix exactly as written in the filename, for example `03`. */
  readonly id: string;
  /** Numeric prefix as a number, used for ordering. */
  readonly number: number;
  /** Filename without the numeric prefix and extension, for example `repository-layer`. */
  readonly slug: string;
  /** Filename, for example `03-repository-layer.md`. */
  readonly filename: string;
  /** Absolute path of the ticket file. */
  readonly path: string;
  /** Path relative to the project working directory, passed to `/skill:implement`. */
  readonly reference: string;
  /** The single `Status:` value, trimmed and lowercased. */
  readonly status: string;
  /** First level-one heading without its number, falling back to the slug. */
  readonly title: string;
}

/** Every ticket in a folder, in ascending numeric order. */
export interface TicketInventory {
  /** The folder label exactly as supplied by the user. */
  readonly folderLabel: string;
  /** Absolute path of the ticket folder. */
  readonly folderPath: string;
  readonly tickets: readonly Ticket[];
}

/** Options for {@link loadTicketInventory}. */
export interface LoadTicketInventoryOptions {
  /** Project working directory that folder paths resolve against. */
  readonly cwd: string;
  /** Ticket folder as supplied by the user. */
  readonly folder: string;
}

/**
 * Display title for a ticket: the first level-one heading with its ticket
 * number stripped, falling back to the filename slug.
 */
export function parseTicketTitle(content: string, fallbackSlug: string): string {
  const heading = LEVEL_ONE_HEADING_PATTERN.exec(content);
  if (!heading) return fallbackSlug;

  const text = (heading[1] ?? "").replace(/\s+#+\s*$/, "").trim();
  if (text.length === 0) return fallbackSlug;

  const withoutNumber = LEADING_TICKET_NUMBER_PATTERN.exec(text);
  const title = (withoutNumber ? (withoutNumber[1] ?? "") : text).trim();
  return title.length > 0 ? title : fallbackSlug;
}

/**
 * Read the supplied folder and return its tickets in ascending numeric order.
 *
 * Only files directly inside the folder are considered; unrelated files are
 * ignored. Missing, unreadable, and ticket-less folders, duplicate ticket
 * numbers, and malformed status lines all throw a descriptive
 * {@link TicketRunnerError} without creating anything.
 */
export function loadTicketInventory(options: LoadTicketInventoryOptions): TicketInventory {
  const folderPath = resolve(options.cwd, options.folder);
  const candidates = discoverCandidates(folderPath, options.folder);
  rejectDuplicateNumbers(candidates);

  if (candidates.length === 0) {
    throw new TicketRunnerError(`No tickets found in ${options.folder}.`);
  }

  const ordered = [...candidates].sort((a, b) => a.number - b.number);
  const tickets = ordered.map((candidate) => readTicket(candidate, options.cwd));

  return { folderLabel: options.folder, folderPath, tickets };
}

interface TicketCandidate {
  readonly id: string;
  readonly number: number;
  readonly slug: string;
  readonly filename: string;
  readonly path: string;
}

function discoverCandidates(folderPath: string, folderLabel: string): TicketCandidate[] {
  let entries;
  try {
    entries = readdirSync(folderPath, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new TicketRunnerError(`Ticket folder not found: ${folderLabel}`);
    }
    if (hasErrorCode(error, "ENOTDIR")) {
      throw new TicketRunnerError(`Ticket path is not a folder: ${folderLabel}`);
    }
    throw new TicketRunnerError(`Cannot read ticket folder ${folderLabel}: ${errorMessage(error)}`);
  }

  const candidates: TicketCandidate[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;

    const match = TICKET_FILENAME_PATTERN.exec(entry.name);
    if (!match) continue;

    const id = match[1] ?? "";
    const number = Number.parseInt(id, 10);
    // A non-positive or unsafe number is not a ticket identifier, so the file
    // is unrelated and ignored rather than treated as a malformed ticket.
    if (!Number.isSafeInteger(number) || number <= 0) continue;

    candidates.push({
      id,
      number,
      slug: match[2] ?? "",
      filename: entry.name,
      path: join(folderPath, entry.name),
    });
  }
  return candidates;
}

function rejectDuplicateNumbers(candidates: readonly TicketCandidate[]): void {
  const byNumber = new Map<number, TicketCandidate[]>();
  for (const candidate of candidates) {
    const group = byNumber.get(candidate.number);
    if (group) group.push(candidate);
    else byNumber.set(candidate.number, [candidate]);
  }

  for (const [number, group] of byNumber) {
    if (group.length < 2) continue;
    const filenames = group
      .map((candidate) => candidate.filename)
      .sort()
      .join(", ");
    throw new TicketRunnerError(`Duplicate ticket number ${number}: ${filenames}.`);
  }
}

function readTicket(candidate: TicketCandidate, cwd: string): Ticket {
  let content: string;
  try {
    content = readFileSync(candidate.path, "utf8");
  } catch (error) {
    throw new TicketRunnerError(
      `Cannot read ticket file ${candidate.filename}: ${errorMessage(error)}`,
    );
  }

  return {
    id: candidate.id,
    number: candidate.number,
    slug: candidate.slug,
    filename: candidate.filename,
    path: candidate.path,
    reference: relative(cwd, candidate.path).split(sep).join("/"),
    status: parseTicketStatus(content, candidate.filename),
    title: parseTicketTitle(content, candidate.slug),
  };
}
