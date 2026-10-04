# Choosing a Tableau Next visualization

How an afd360-authoring agent should pick a `Visualization` layout /
`chartType` from a `SemanticModel`'s metadata, and compose coherent
`Dashboard`s. Two parts: a **coverage matrix** (what afd360 can emit
today vs. what needs the escape hatch) and a **selection rubric**
(metadata → viz). Read this before generating any `Visualization` or
`Dashboard`.

The governing rule: **the construct enforces a valid wire shape; this
doc governs the *choice*.** Never pick a viz afd360 can't faithfully
emit (see the matrix) — the deterministic-IaC contract is that the
manifest says exactly what gets built.

## How the API is actually shaped (so the matrix makes sense)

A visualization's `visualSpecification` has a top-level **`layout`**
discriminator — the SDK (`tableau-next-sdk`) exposes five:
`Vizql`, `Table`, `Radial`, `Map`, `Flow`. afd360's `Visualization`
hardcodes `layout: "Vizql"` and builds a Cartesian (x/y-axis) scaffold.

Within the Vizql layout, `chartType` flows straight into
`marks.panes.type`. The SDK's Vizql **mark types** are:
`Bar`, `Line`, `Area`, `Circle`, `Square`, `Donut`, `Text`, `Map`.
So "pie/donut" and "KPI number" are *Vizql marks*, NOT separate
layouts — they're reachable via `chartType` today, but the auto-built
scaffold assumes x/y axes, so their part-of-whole / single-value /
geo encodings are **unverified**.

That gives three support tiers, not five flat layouts.

## Coverage matrix

| Viz | How afd360 emits it | Needs (metadata) | Support today | Live-validated? |
|---|---|---|---|---|
| **Bar** | Vizql `chartType:"Bar"` | 1 measure × 1 low-card categorical/temporal dim | ✅ supported | ✅ (v67, round-trip-tested) |
| **Line** | Vizql `chartType:"Line"` | 1 measure × 1 temporal dim | ✅ supported | ✅ (same scaffold as Bar) |
| **Area** | Vizql `chartType:"Area"` | 1 measure × 1 temporal dim (cumulative) | ✅ supported | ⚠️ same x/y scaffold; spot-check |
| **Donut / Pie** | Vizql `chartType:"Donut"` | 1 measure × 1 categorical, ≤~6 slices, part-of-whole | ⚙️ shape known | 📐 encoding shape documented (see below); not yet self-POSTed |
| **Scatter** | Vizql `chartType:"Circle"` / `"Square"` | 2 measures (× optional dim on color) | ⚙️ expressible | ❌ x/y scaffold fits; encodings unverified |
| **KPI / BigNumber** | Vizql `chartType:"Text"` | 1 measure, 0 dims | ⚙️ expressible | ❌ needs single-value text encoding, not x/y — **unverified** |
| **Table** | `layout:"Table"` (escape hatch) | row-level detail, many columns | ⛔ not native | 📐 skeleton documented; needs native branch |
| **Radial** | `layout:"Radial"` (escape hatch) | gauge / radial-bar | ⛔ not native | 📐 skeleton documented; **org feature-gated** |
| **Map (geo)** | `layout:"Map"` (escape hatch) | geo-role dim (country/state/lat-long) | ⛔ not native | 📐 skeleton documented |
| **Flow (sankey)** | `layout:"Flow"` (escape hatch) | source→target stages + a measure | ⛔ not native | 📐 skeleton documented |

Legend: **✅ supported** = construct emits it natively, round-trip-tested;
**⚙️** = reachable via `chartType` on the Vizql path but the generated
scaffold is Cartesian; **⛔ not native** = a non-Vizql `layout` the
construct doesn't model — reach it via the `visualSpecification` escape
hatch. **📐** = the wire shape is documented below (from the SDK types +
server validators), so you can hand-build a `visualSpecification` without
live-probing the skeleton; **❌** = no shape on record, live capture needed.

Only **Text (KPI)** and **scatter (Circle/Square)** encodings have no shape
on record anywhere — those are the sole cases that still need a live capture.
Everything else is template-able from the shapes below.

### The escape hatch (tiers ⚙️ and ⛔)

`Visualization` accepts a `visualSpecification: { ... }` prop that is
emitted **verbatim** instead of the generated Vizql scaffold. For a
layout afd360 can't yet model (Table/Radial/Map/Flow) or a Vizql mark
whose encodings differ from x/y (Donut/Text/Map-mark), the faithful
path today is: capture a known-good body from a viz built in the TN UI
(`GET /tableau/visualizations/{id}`, v67), strip read-only fields
(`id`, `createdBy`/`*Date`, `permissions`, `sourceVersion`, `url`,
`dataSource.url`, `workspace.{label,url}`, `fields.*.id`,
`view.{id,name,isOriginal}`), and pass it as `visualSpecification`.
Flag to the user that it's a captured body, not a native construct
shape — so it won't track field renames in the model.

**Table is the top construct gap** (a native `layout:"Table"` branch
with a `columns` binding) — flagged for the backlog, not yet built.
Until then, detail tables go through the escape hatch.

## Documented wire shapes (for hand-building a `visualSpecification`)

These skeletons let you author a 📐 body without live-probing it first.
Common to every layout: it extends a base layout rep, carries a top-level
`fields` map keyed by slot (`F1`, `F2`, …) where each slot is
`{ type, role, objectName, fieldName, function? }` (`role` = `Dimension` |
`Measure`; `function` on measures, e.g. `Sum`/`UserAgg`), and a `marks`
object. Mark `type` is one of `Area|Bar|Circle|Donut|Line|Spatial|Square|Text`;
a mark **encoding** `type` is one of `Angle|Color|Detail|Label|Range|Size|Tooltip`.
What differs per layout is the field-slot container and which `marks` sub-keys
are populated.

| `layout` | Field-slot container | `marks` sub-keys | Notes |
|---|---|---|---|
| `Vizql` (shipped) | `columns[]` (measures) + `rows[]` (dims) | `fields` / `headers` / `panes` | What the construct emits; x/y axes. |
| `Table` | `rows[]` (+ `columns[]`) | `fields` / `headers` / `panes` | **SDK-vs-server skew**: the generated SDK type shows `groups[]`+`rows[]`; the server input-rep uses `rows[]`(+`columns[]`). Reconcile against the org's version when hand-building. |
| `Radial` | `slices[]` | `panes` only | **Org feature-gated** — may be OFF; if a Radial body 400s/renders empty, the gate is likely disabled. Treat as a prerequisite, not an afd360 bug. |
| `Map` | `locations[]` | `fields` / `panes` | Location slot `type: "MapPosition"`; positional enum `Geocoded` \| `Xy`; a map-background-style enum sets the basemap. |
| `Flow` (sankey) | `levels[]` + `link` | `fields` / `links` / `nodes` | `link` is the width measure; marks use `links`/`nodes`, **not** `panes`/`headers`. |

### Donut encoding (Vizql `chartType:"Donut"`)

Part-of-whole uses an **`Angle`** encoding in place of x/y axes. The known-good
4-slot shape:

- `F1 → Label` (dimension — the slice category)
- `F2 → Color` (dimension — slice color; usually the same category)
- `F3 → Angle` (measure — the slice *size*, the part-of-whole value)
- `F4 → Label` (measure — the value shown on each slice)
- `legends: { F2: { isVisible: true } }`

with `marks.panes.type: "Donut"`. Build this on the Vizql `layout`
(it's a mark, not a separate layout) — but because the construct's auto-scaffold
places measures on x/y rather than `Angle`, supply it via `visualSpecification`
until the construct learns the Angle encoding.

### Still unknown — needs live capture

**Text (KPI/BigNumber)** and **scatter (Circle/Square)** have no shape on
record in any source. For these two, there is no shortcut: build one in the TN
UI, `GET` it (v67), strip the read-only fields listed above, and pass the body
as `visualSpecification`. Everything else above is template-able from the
documented slots.

## Selection rubric (metadata → viz)

Walk top to bottom; stop at the first match. "card" = cardinality
(distinct values of a dimension).

| Metadata signal | Pick | `chartType` |
|---|---|---|
| 1 measure, 0 dims | KPI / BigNumber | `Text` ⚙️ |
| 1 measure × 1 **temporal** dim | time series | `Line` ✅ |
| 1 measure × 1 categorical, **part-of-whole**, card ≤ ~6 | donut | `Donut` ⚙️ |
| 1 measure × 1 categorical, card ≤ ~25 | bar | `Bar` ✅ |
| 2 measures (optional dim → color) | scatter | `Circle` ⚙️ |
| 1 measure × 1 **geo-role** dim | map | `layout:"Map"` ⛔ |
| row-level detail / "list the records" / many fields | table | `layout:"Table"` ⛔ |
| measure across source→target **stages** | sankey | `layout:"Flow"` ⛔ |
| 1 measure × 2 categorical dims (one → color) | stacked/grouped bar | `Bar` ✅ |

Guards:

- **Cardinality.** Never bar-chart a dimension with card > ~25 (ids,
  names, timestamps-as-text) — it's unreadable and slow. If the only
  dim is high-card, the user wants a **table**, not a bar.
- **Temporal beats categorical.** A date/datetime dim → line/area even
  if a categorical dim is also present (put the categorical on color).
- **Part-of-whole needs a whole.** Only pick donut when the measure is
  a decomposable total (revenue by region) and slices ≤ ~6; otherwise
  a bar reads better.
- **Measure must aggregate.** A viz measure maps to a model measure
  (`function: "UserAgg"` by default). If the "measure" the user named
  is really a raw numeric column with no aggregation, it belongs on a
  table or as a scatter axis, not a bar height.
- **Prefer a supported tier.** When two viz fit, pick the ✅ one over a
  ⚙️/⛔ one — fewer live-validation unknowns. If only a ⛔ fits, tell
  the user it needs the escape hatch (or is a pending construct gap)
  rather than silently emitting a Cartesian Vizql scaffold that won't
  render as intended.

## Dashboard composition

A `Dashboard` is a laid-out page of `Visualization` tiles over **one**
`SemanticModel`. Patterns that read well:

- **Overview page (most common).** KPI row across the top (2–4 `Text`
  tiles: totals/rates) → one trend `Line` → one breakdown `Bar` →
  optional detail `Table` at the bottom. Scan path is top-left → down.
- **One model per dashboard.** All tiles bind the same model's semantic
  apiNames. Mixing models on one page means the agent is really
  building two dashboards.
- **3–6 tiles.** Fewer than 3 is a single viz; more than ~6 is two
  pages. Don't pad with redundant cuts of the same measure.
- **Don't repeat the measure unframed.** A KPI total + a bar of the
  same measure by one dimension is good (summary + breakdown); the same
  bar twice with cosmetic differences is noise.
- **Lead with the answer.** If the user asked "how are we doing on X,"
  the X KPI is the top-left tile; supporting cuts follow.

Bind each tile to its `Visualization` construct (wires `dependsOn`), not
a name string, so deploy order is correct. The `workspace` is a
pre-existing container referenced by `{ id?, name }` — afd360 never
creates or deletes it; ask the user for it (see
[the main reference](../../../docs/resources.md#dashboard)).

## When to ask the user

- **Which measure is the headline** when several exist — drives the KPI
  tile and the dashboard's lead.
- **Part-of-whole intent** before picking donut over bar — the agent
  can't tell from types alone whether slices sum to a meaningful total.
- **Geo** — confirm a dim is a real geographic role, not just a text
  field named "Region," before reaching for a map.
- **The `workspace`** id/name — it's pre-existing and user-specific;
  never invent it.
