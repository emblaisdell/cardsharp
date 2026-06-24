# Card# for VSCode

Syntax highlighting + live type-checking for [Card# / CardSharp](../../README.md)
`.card` files.

## Features

- **Syntax highlighting** — keywords, sections (`game`/`zone`/`flow`/…),
  builtins, card constants (`Ace`, `King`, `Hearts`, …) and unicode suit glyphs
  (`♣ ♦ ♥ ♠`), strings, numbers, comments, operators.
- **Live diagnostics** — runs the Card# static type checker on open/save and
  underlines type errors inline (calling a non-function, `current.rank`,
  wrong argument types, etc.). Requires the file to live inside a CardSharp
  checkout (it shells out to `packages/cli/src/main.ts check`). Configure the
  path with `cardsharp.repoPath`, or disable with `cardsharp.typeCheck: false`.

## Install

From the repo root:

```bash
node tools/vscode-cardsharp/install.mjs        # symlink into ~/.vscode/extensions
```

Then reload VSCode (Developer: Reload Window). Open any `.card` file.

To uninstall, remove the symlink it created in `~/.vscode/extensions/`.
