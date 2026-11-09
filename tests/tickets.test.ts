import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadTicketInventory, parseTicketTitle, readTicketStatus } from "../src/tickets.ts";
import { TicketRunnerError } from "../src/errors.ts";
import {
  createTempTree,
  makeUnreadable,
  permissionsAreEnforced,
  ticketMarkdown,
} from "./helpers.ts";

describe("loadTicketInventory: discovery", () => {
  it("discovers numbered markdown tickets and ignores unrelated files", () => {
    const tree = createTempTree();
    tree.write("issues/01-database-schema.md", ticketMarkdown({ title: "# 01: Database Schema" }));
    tree.write("issues/02-api-endpoints.md", ticketMarkdown({ title: "# 02: API Endpoints" }));
    tree.write("issues/notes.md", "# Notes");
    tree.write("issues/README", "no status");
    tree.write("issues/03-ticket.txt", "Status: ready-for-agent");
    tree.write("issues/ticket-04.md", "Status: ready-for-agent");
    tree.write("issues/.hidden.md", "Status: ready-for-agent");

    const inventory = loadTicketInventory({ cwd: tree.root, folder: "issues" });

    assert.deepEqual(
      inventory.tickets.map((ticket) => ticket.filename),
      ["01-database-schema.md", "02-api-endpoints.md"],
    );
  });

  it("does not scan nested folders", () => {
    const tree = createTempTree();
    tree.write("issues/01-outer.md", ticketMarkdown());
    tree.write("issues/nested/02-inner.md", ticketMarkdown());

    const inventory = loadTicketInventory({ cwd: tree.root, folder: "issues" });

    assert.deepEqual(
      inventory.tickets.map((ticket) => ticket.filename),
      ["01-outer.md"],
    );
  });

  it("describes the numeric prefix, slug, and reference of each ticket", () => {
    const tree = createTempTree();
    tree.write("issues/03-repository-layer.md", ticketMarkdown({ title: "# 03: Repository Layer" }));

    const inventory = loadTicketInventory({ cwd: tree.root, folder: "issues" });
    const ticket = inventory.tickets[0];

    assert.ok(ticket);
    assert.equal(ticket.id, "03");
    assert.equal(ticket.number, 3);
    assert.equal(ticket.slug, "repository-layer");
    assert.equal(ticket.filename, "03-repository-layer.md");
    assert.equal(ticket.path, tree.path("issues/03-repository-layer.md"));
    assert.equal(ticket.reference, "issues/03-repository-layer.md");
    assert.equal(inventory.folderLabel, "issues");
    assert.equal(inventory.folderPath, tree.path("issues"));
  });

  it("resolves the folder relative to the project working directory", () => {
    const tree = createTempTree();
    tree.write("issues/01-one.md", ticketMarkdown());

    const inventory = loadTicketInventory({ cwd: tree.root, folder: "issues" });

    assert.equal(inventory.tickets.length, 1);
    assert.equal(inventory.tickets[0]?.reference, "issues/01-one.md");
  });

  it("reports a missing folder", () => {
    const tree = createTempTree();

    assert.throws(
      () => loadTicketInventory({ cwd: tree.root, folder: "missing" }),
      (error: unknown) =>
        error instanceof TicketRunnerError && /Ticket folder not found: missing/.test(error.message),
    );
  });

  it("reports a folder path that is a file", () => {
    const tree = createTempTree();
    tree.write("issues", "not a folder");

    assert.throws(
      () => loadTicketInventory({ cwd: tree.root, folder: "issues" }),
      (error: unknown) =>
        error instanceof TicketRunnerError && /not a folder/.test(error.message),
    );
  });

  it("reports a folder with no ticket files", () => {
    const tree = createTempTree();
    tree.mkdir("issues");
    tree.write("issues/notes.md", "# Notes");

    assert.throws(
      () => loadTicketInventory({ cwd: tree.root, folder: "issues" }),
      (error: unknown) => error instanceof TicketRunnerError && /No tickets found in issues/.test(error.message),
    );
  });

  it("reports an unreadable folder", (t) => {
    if (!permissionsAreEnforced()) {
      t.skip("permissions are not enforced for this user");
      return;
    }
    const tree = createTempTree();
    tree.write("issues/01-one.md", ticketMarkdown());
    makeUnreadable(tree.path("issues"));

    assert.throws(
      () => loadTicketInventory({ cwd: tree.root, folder: "issues" }),
      (error: unknown) =>
        error instanceof TicketRunnerError && /Cannot read ticket folder issues/.test(error.message),
    );
  });

  it("reports an unreadable ticket file", (t) => {
    if (!permissionsAreEnforced()) {
      t.skip("permissions are not enforced for this user");
      return;
    }
    const tree = createTempTree();
    tree.write("issues/01-one.md", ticketMarkdown());
    makeUnreadable(tree.path("issues/01-one.md"));

    assert.throws(
      () => loadTicketInventory({ cwd: tree.root, folder: "issues" }),
      (error: unknown) =>
        error instanceof TicketRunnerError && /Cannot read ticket file 01-one\.md/.test(error.message),
    );
  });
});

describe("loadTicketInventory: ordering", () => {
  it("sorts by ascending numeric prefix, not lexicographically", () => {
    const tree = createTempTree();
    tree.write("issues/10-ten.md", ticketMarkdown());
    tree.write("issues/2-two.md", ticketMarkdown());
    tree.write("issues/01-one.md", ticketMarkdown());

    const inventory = loadTicketInventory({ cwd: tree.root, folder: "issues" });

    assert.deepEqual(
      inventory.tickets.map((ticket) => ticket.number),
      [1, 2, 10],
    );
  });

  it("rejects duplicate numeric identifiers", () => {
    const tree = createTempTree();
    tree.write("issues/01-a.md", ticketMarkdown());
    tree.write("issues/1-b.md", ticketMarkdown());

    assert.throws(
      () => loadTicketInventory({ cwd: tree.root, folder: "issues" }),
      (error: unknown) =>
        error instanceof TicketRunnerError &&
        /Duplicate ticket number 1: 01-a\.md, 1-b\.md/.test(error.message),
    );
  });

  it("ignores filenames without a positive ticket number", () => {
    const tree = createTempTree();
    tree.write("issues/00-a.md", ticketMarkdown());
    tree.write("issues/01-b.md", ticketMarkdown());

    const inventory = loadTicketInventory({ cwd: tree.root, folder: "issues" });

    assert.deepEqual(
      inventory.tickets.map((ticket) => ticket.filename),
      ["01-b.md"],
    );
  });
});

describe("loadTicketInventory: status", () => {
  it("reads a status line from each ticket", () => {
    const tree = createTempTree();
    tree.write("issues/01-one.md", ticketMarkdown({ status: "**Status:** Ready-For-Agent" }));

    const inventory = loadTicketInventory({ cwd: tree.root, folder: "issues" });

    assert.equal(inventory.tickets[0]?.status, "ready-for-agent");
  });

  it("stops on a ticket without a status line", () => {
    const tree = createTempTree();
    tree.write("issues/01-one.md", "# 01: One\n\nNo status here.\n");

    assert.throws(
      () => loadTicketInventory({ cwd: tree.root, folder: "issues" }),
      (error: unknown) =>
        error instanceof TicketRunnerError && /Ticket 01-one\.md has no Status: line/.test(error.message),
    );
  });
});

describe("readTicketStatus", () => {
  it("re-reads the current status from disk", () => {
    const tree = createTempTree();
    const path = tree.write("issues/01-one.md", ticketMarkdown({ status: "Status: ready-for-agent" }));
    const ticket = { path, filename: "01-one.md" };

    assert.equal(readTicketStatus(ticket), "ready-for-agent");

    tree.write("issues/01-one.md", ticketMarkdown({ status: "**Status:** Resolved" }));

    assert.equal(readTicketStatus(ticket), "resolved");
  });

  it("reports a malformed status after re-reading", () => {
    const tree = createTempTree();
    const path = tree.write("issues/01-one.md", "# 01: One\n\nNo status.\n");

    assert.throws(
      () => readTicketStatus({ path, filename: "01-one.md" }),
      (error: unknown) =>
        error instanceof TicketRunnerError && /Ticket 01-one\.md has no Status: line/.test(error.message),
    );
  });
});

describe("parseTicketTitle", () => {
  it("strips a numeric prefix from the first level-one heading", () => {
    assert.equal(parseTicketTitle("# 03: Repository Layer\n", "repository-layer"), "Repository Layer");
    assert.equal(parseTicketTitle("# 03. Repository Layer\n", "repository-layer"), "Repository Layer");
    assert.equal(parseTicketTitle("# 03 Repository Layer\n", "repository-layer"), "Repository Layer");
  });

  it("falls back to the filename slug without a level-one heading", () => {
    assert.equal(parseTicketTitle("Status: ready-for-agent\n", "repository-layer"), "repository-layer");
    assert.equal(parseTicketTitle("## 03: Not level one\n", "repository-layer"), "repository-layer");
  });

  it("keeps a heading that does not start with a ticket number", () => {
    assert.equal(parseTicketTitle("# Repository Layer\n", "repository-layer"), "Repository Layer");
    assert.equal(parseTicketTitle("# 3D renderer\n", "renderer"), "3D renderer");
  });

  it("uses the first level-one heading only", () => {
    assert.equal(
      parseTicketTitle("# 01: First\n\n# 02: Second\n", "fallback"),
      "First",
    );
  });

  it("falls back when the heading is only a number", () => {
    assert.equal(parseTicketTitle("# 01:\n", "fallback"), "fallback");
  });
});
