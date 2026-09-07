# Spec — UI Design System

Source of truth: `docs/design/judge-design-system.html` (open it in a browser).
This file is the extracted, implementable version. Where the two disagree, the HTML wins.
Reference screenshots that informed it: `docs/design-refs/`.

**Dark only.** No light theme, no theme toggle. This supersedes the earlier "light-mode toggle"
decision in PLAN.md.

---

## 1. Surfaces & ink

| Token | Hex | Used for |
|---|---|---|
| `--bg` | `#0d1015` | app canvas, editor, code panels |
| `--surface` | `#161a20` | nav, toolbars, cards, table head |
| `--surface-2` | `#1d222b` | chips, hover, inline code |
| `--border` | `#2b323c` | pane splits, card edges |
| `--border-soft` | `#21262d` | table row rules |
| `--text` | `#e8edf3` | statement, titles |
| `--text-dim` | `#99a3af` | labels, metadata |
| `--text-faint` | `#6b7480` | table heads, line numbers |

Four elevation steps, no shadows below modal level. Table rows alternate `bg` / `surface`
rather than being separated by borders.

## 2. Semantic color

Verdict and difficulty are the **only** places color carries meaning. Each hue ships as a
full-strength ink plus a 14%-alpha fill for pills and callouts. Never colored text on colored text.

| Token | Hex | Fill | Meaning |
|---|---|---|---|
| `--accent` | `#3b82f6` | `rgba(59,130,246,0.14)` | primary action, active tab rule, focus ring |
| `--ok` | `#3fb950` | `rgba(63,185,80,0.14)` | accepted verdict, solved check, passed case |
| `--bad` | `#f85149` | `rgba(248,81,73,0.14)` | every failing verdict, judge stderr |
| `--warn` | `#d29922` | `rgba(210,153,34,0.14)` | demo mode, partial or skipped runs |
| `--info` | `#58a6ff` | `rgba(88,166,255,0.14)` | in-flight submissions, links |
| `--easy` | `#2cbba2` | `#1d222b` | difficulty ink only |
| `--medium` | `#f0a63c` | `#1d222b` | difficulty ink only |
| `--hard` | `#f2545b` | `#1d222b` | difficulty ink only |

Supporting inks: code green `#7ee2c0`, code blue `#9ecbff`, keyword violet `#c792ea`,
judge-error text `#ffb3ae`, link `#6aa6ff` (hover `#9cc4ff`).

## 3. Typography

System UI sans for chrome and prose; **JetBrains Mono** for code, stdin/stdout, judge messages,
metrics, and identifiers embedded in prose. Statement body never drops below 13.5px.

```
SANS = -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif
MONO = 'JetBrains Mono', ui-monospace, monospace
```

| Role | Spec |
|---|---|
| display | 38px · 700 · -0.025em |
| title | 20px · 650 · -0.015em |
| subtitle | 15px · 600 |
| statement | 13.5px · 400 · line-height 1.65 |
| meta | 12.5px · 400 · `--text-dim` |
| table head | 11px · 600 · +0.04em · uppercase · `--text-faint` |
| code | mono 12.5px · line-height 1.8 |
| judge output | mono 12.5px · `#ffb3ae` on tinted panel |

## 4. Spacing & shape

4px grid. Only three radii exist.

`space-1` 4 (icon gaps, badge inset) · `space-2` 8 (chip rows) · `space-3` 12 (grid gap, cell padding) ·
`space-4` 16 (card/row padding) · `space-5` 24 (pane padding) · `space-6` 32 (page top) ·
`space-8` 64 (between doc sections)

Pane padding 22–24 · card padding 16–22 · table cell 11×12 · control padding 7×14.
Radii: `6px` controls · `8px` cards and panes · `999px` badges.

## 5. Controls

Two button weights only: **solid accent** for Submit, **outlined ghost** for everything else.
Run is ghost — submitting is the committed action. Submitting state shows "Submitting…" and disables.

Tab bar: active tab is `--text` with a `--accent` bottom rule; inactive is `--text-dim` with a
transparent rule.

## 6. Verdict badges

Pill, 999px radius, 11.5px / 650 weight, tinted fill at 14%. Long verdicts truncate, never wrap.

| Badge | Ink | Note |
|---|---|---|
| Accepted | `--ok` | all tests passed |
| Wrong Answer / Time Limit Exceeded / Runtime Error / Compile Error | `--bad` | all failures carry equal weight |
| Not Run (demo) | `--warn` | judge unavailable |
| Running | `--info` | in flight — animate nothing |
| Queued | `--text-dim` on `#1d222b` | neutral until judged |
| — | `--text-dim` on `#1d222b` | no verdict yet |

Difficulty is a **property, not a status**: colored ink on a neutral `#1d222b` fill.

## 7. Split-pane anatomy

- Sticky nav, height **56px**, on `--surface`. Nav items: Judge (brand) · Problems · Profile.
- Grid: `grid-template-columns: minmax(0,42fr) minmax(0,58fr)` — statement left with a
  `minmax(340px, 42%)` floor, workspace right.
- Each pane scrolls independently. **The shell never scrolls.**
- Left pane tabs: Description · Submissions · (Editorial).
- Right pane: language selector, Run (ghost), Submit (solid), then the code editor with line
  numbers, then a Stdin box.
- Below **900px** the grid collapses to stacked blocks: statement first, then a **fixed 360px**
  editor, then the results panel.

## 8. Results view

Verdict headline in semantic ink at 20px, metrics in mono beside it, per-test table below.
A step strip runs Queued → Compiling → Running → Judged.

Judge output (compiler errors, runtime stderr) is quoted **verbatim** in mono on a tinted panel —
`rgba(248,81,73,0.10)` background, `rgba(248,81,73,0.38)` border, `#ffb3ae` ink. Never restyled,
never truncated, never re-worded.

Per-test table columns: `#` · input · expected · got · verdict. Skipped cases render as `—` in
`--text-faint`.

## 9. Submission table

Uppercase 11px headers. Zebra on hover only. IDs and timestamps dimmed to `--text-dim` so the
verdict column reads first. Numeric columns are mono and right-aligned.
Columns: id · when · language · verdict · tests · time.

## 10. Problem list row

Grid: `28px minmax(0,1fr) 76px 68px` — solved marker, title, acceptance rate, difficulty.
Solved state is a **checkmark in `--ok`**, not a badge. Acceptance rate is mono and dimmed.
Stat card grids use `repeat(auto-fit, minmax(150px, 1fr))`.

## 11. Rules (non-negotiable)

1. **One status marker per row.** A row shows either a solved check or a verdict pill — never both.
2. **Color is reserved.** Accent means action; ok/bad/warn mean judged outcome; difficulty ink is
   neutral-filled. Nothing else is colored.
3. **Judge output is verbatim.** Compiler and runtime text is mono, pre-wrapped, full-strength ink
   on a tinted panel. Never truncate, never re-word.
4. **The shell never scrolls.** Nav sticky at 56px; each pane owns its own overflow so the editor
   stays put while the statement scrolls.
5. **Metrics are monospace.** Runtime, memory, test counts, acceptance rate and IDs all use mono so
   digits align in columns.
6. **Collapse, don't shrink.** Under 900px the split-pane stacks; it never squeezes.

## 12. Implementation notes

- Define every token as a CSS custom property on `:root` once; components reference variables only,
  never raw hex.
- Load JetBrains Mono from Google Fonts with a real fallback stack.
- Monaco's theme must match `--bg` (`#0d1015`) so the editor doesn't sit on a different ground than
  its own pane.
- Screens still to be designed against these tokens (extend the same system, don't invent a second
  one): auth, profile/dashboard, admin dashboard, API keys page, complexity-analysis chart.
