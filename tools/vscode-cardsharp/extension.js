// ♠# VSCode extension.
//
// Syntax highlighting is fully declarative (see syntaxes/ + the grammar).
// This script adds *live diagnostics*: it runs the ♠# static type checker
// (via the repo's CLI `check` command) on open/save and surfaces type errors
// inline — the same errors that would otherwise only appear at runtime.

const vscode = require("vscode");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

let diagnostics;

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection("cardsharp");
  context.subscriptions.push(diagnostics);

  const run = (doc) => {
    if (doc && doc.languageId === "cardsharp") checkDocument(doc);
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(run),
    vscode.workspace.onDidSaveTextDocument(run),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri)),
  );

  // check everything already open
  vscode.workspace.textDocuments.forEach(run);
}

function deactivate() {
  if (diagnostics) diagnostics.dispose();
}

// Locate packages/cli/src/main.ts, either from config or by walking up from the
// file / workspace folders.
function findCli(docPath) {
  const cfg = vscode.workspace.getConfiguration("cardsharp").get("repoPath");
  const candidates = [];
  if (cfg) candidates.push(path.join(cfg, "packages/cli/src/main.ts"));
  (vscode.workspace.workspaceFolders || []).forEach((f) =>
    candidates.push(path.join(f.uri.fsPath, "packages/cli/src/main.ts")),
  );
  // walk up from the document
  let dir = path.dirname(docPath);
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, "packages/cli/src/main.ts"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function checkDocument(doc) {
  if (!vscode.workspace.getConfiguration("cardsharp").get("typeCheck")) {
    diagnostics.delete(doc.uri);
    return;
  }
  const file = doc.uri.fsPath;
  const cli = findCli(file);
  if (!cli) return; // not inside a CardSharp checkout; highlighting still works

  cp.execFile("node", [cli, "check", file], { timeout: 15000 }, (err, stdout) => {
    const items = [];
    const re = /:(\d+)\s{2}(.+)\s*$/;
    for (const line of String(stdout).split("\n")) {
      const m = line.match(re);
      if (!m) continue;
      const ln = Math.max(0, parseInt(m[1], 10) - 1);
      const range = doc.lineAt(Math.min(ln, doc.lineCount - 1)).range;
      items.push(new vscode.Diagnostic(range, m[2].trim(), vscode.DiagnosticSeverity.Error));
    }
    diagnostics.set(doc.uri, items);
    void err; // a non-zero exit just means "had errors", already parsed
  });
}

module.exports = { activate, deactivate };
