# Atril themes

A theme is one JSON file. Atril's own live here (`oscuro`, `claro`, `papel`, `contraste`); **yours go in
`~/.atril/themes/`** (`%USERPROFILE%\.atril\themes\` on Windows): no rebuild, reload the window and pick
it in **◐ tema**, at the bottom of the sidebar. To ship one with Atril, add it here and to `BUILTIN` in
`../theme.js` and to `SOURCES` in `../../atrild.syn`.

A theme only needs what it changes. The rest comes from Atril's theme of the same `kind`
(`oscuro` for `dark`, `claro` for `light`), so this is a whole theme:

```json
{ "name": "Verde", "kind": "dark", "ui": { "accent": "#7ee2a8", "selection": "#1f5a3a" } }
```

## Fields

| field | what it is |
|---|---|
| `name` | what the menu shows |
| `kind` | `dark` or `light`: which half it is when Atril switches by itself (system or hour) |
| `ui` | the window's colors (below); any CSS color |
| `terminal` | the terminals' colors, as [xterm.js `ITheme`](https://xtermjs.org/docs/api/terminal/interfaces/itheme/) |
| `contrast` | 1 to 21: xterm raises a text color until it has at least this contrast with its background. `4.5` keeps programs that paint their own colors (OpenCode, Claude Code…) readable on a light background; `1` leaves every color as the program sent it |

### `ui`

| key | used for |
|---|---|
| `bg`, `panel` | the main background; the sidebar, menus and dialogs |
| `line`, `hover`, `sel` | borders; a row under the mouse; the row that is chosen |
| `text`, `soft`, `muted`, `dim` | text, from the most to the least important |
| `accent`, `on-accent` | links, the tab on screen, buttons; the text on top of them |
| `branch` | git branches |
| `ok`, `busy`, `warn`, `off` | done/new, working/modified, needs you/deleted, ended |
| `selection`, `selection-text` | what you select with the mouse in the window |
| `plus-bg`, `plus-text`, `minus-bg`, `minus-text`, `hunk-bg` | a diff: added lines, removed lines, the `@@` lines |
| `shade` | behind a dialog and under floating panels |

### `terminal`

`background`, `foreground`, `cursor`, `cursorAccent`, the 16 colors (`black` … `white`,
`brightBlack` … `brightWhite`) and, above all, **the selection**:

- `selectionBackground` and `selectionForeground`: give both, opaque. With only a background, xterm
  keeps each letter's own color, and on a light theme pale text over a pale selection disappears.
- `selectionInactiveBackground`: the selection while the terminal does not have the focus.

On a light theme, give the 16 colors too: the defaults are made for black (a yellow you cannot read
on white). `claro.json` is a good start.
