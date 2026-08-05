"""Schema-drift-tolerant ingestion.

The workbooks are exported as concatenated markdown tables — one block per
tab, blank-line separated, each with its own header row. Header spellings
differ between tabs and sometimes a header cell has been overwritten with
data (``Urban Stroll`` and ``Headstrong Software`` both appear where ``Date``
should be).

The ingester therefore:

1. splits the export into blocks,
2. classifies each block by *header fingerprint*, not by position,
3. maps columns through an alias table with a normalised-token fallback,
4. records every column it could not map, so unmapped-column rate becomes a
   monitored metric rather than silent data loss.

Adding a new tab to a source sheet should require no code change. If it does,
``UNMAPPED_COLUMN`` fires in the daily self-check and says so.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

from . import contracts as C
from .contracts import Provenance

# --------------------------------------------------------------------------
# Block splitting
# --------------------------------------------------------------------------

_ESCAPES = {r"\_": "_", r"\[": "[", r"\]": "]", r"\-": "-", r"\*": "*", r"\|": "|"}


def _unescape(cell: str) -> str:
    for a, b in _ESCAPES.items():
        cell = cell.replace(a, b)
    return cell.strip()


def split_blocks(text: str) -> list[list[list[str]]]:
    """Split a markdown-table export into per-tab blocks of rows."""
    blocks: list[list[list[str]]] = []
    current: list[list[str]] = []
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("|"):
            cells = [_unescape(c) for c in stripped.strip("|").split("|")]
            # Drop markdown alignment separator rows (":-:", "---").
            if all(set(c) <= set(": -") for c in cells if c):
                continue
            current.append(cells)
        elif current:
            blocks.append(current)
            current = []
    if current:
        blocks.append(current)
    return blocks


# --------------------------------------------------------------------------
# Column mapping
# --------------------------------------------------------------------------

def _tok(header: str) -> str:
    """Normalise a header cell to a comparison token."""
    h = re.sub(r"\(.*?\)", " ", str(header).lower())
    h = re.sub(r"[^a-z0-9]+", " ", h).strip()
    h = re.sub(r"\s+", " ", h)
    return h


#: Canonical field <- accepted header tokens. Order matters only for reporting.
ORDER_ALIASES: dict[str, tuple[str, ...]] = {
    "order_date": ("date", "date of order", "order date"),
    "client": ("client name", "client", "buyer", "buyer name"),
    "project": ("project name", "project", "brand name"),
    "industry": ("industry", "niche", "category"),
    "country": ("country",),
    "order_type": ("order type", "type", "gig type"),
    "status": ("status", "order status"),
    "logo_designer": ("logo designer", "logo", "designer"),
    "branding_designer": ("branding designer", "branding", "brandings"),
    "csr": ("csr", "csr project", "agent"),
    "amount": ("order amount", "amount", "price", "order price"),
    "tip": ("tip", "tips"),
    "delivered_date": ("doc", "due date", "delivery date", "date of completion"),
    "rating": ("review", "public review", "rating"),
    "earnings": ("earnings", "net"),
    "upsell": ("upsell", "up sell", "follow up order placed", "cross sale"),
    "upsell_detail": ("what did you upsell and how much you upsell",),
    "notes": ("notes", "note", "remarks"),
}

LEAD_ALIASES: dict[str, tuple[str, ...]] = {
    "date": ("date", "date of inquiry", "inquiry date"),
    "client": ("client name", "client", "buyer"),
    "country": ("country",),
    "member_since": ("on fiverr since", "member since"),
    "completed_orders": ("completed order", "co", "completed orders"),
    "status": ("order status", "status"),
    "quoted": ("order price", "quoted", "price", "quote"),
    "upsell_attempted": ("upsell", "up sell", "cross sale", "cross sell"),
    "followup_1": ("followup", "followup 1", "follow up", "follow up 1", "f 1"),
    "followup_2": ("followup 2", "follow up 2", "f 2"),
    "followup_3": ("followup 3", "follow up 3", "f 3"),
    "shift": ("shift",),
    "csr": ("csr", "agent"),
    "last_contact": ("last contact date", "last contact"),
    "service": ("service demand", "service", "gig"),
    "note": ("note", "notes", "remarks"),
    "meeting": ("meeting",),
}

FLOW_ALIASES: dict[str, tuple[str, ...]] = {
    "date": ("date",),
    "profile": ("profile", "seller", "account"),
    "organic_orders": ("organic orders",),
    "vvro_orders": ("vvro orders", "vro orders", "inorganic orders"),
    "organic_revenue": ("organic revenue",),
    "vvro_revenue": ("vvro revenue", "vro revenue"),
    "total_orders": ("total orders",),
    "total_revenue": ("total revenue",),
}

IMPRESSION_ALIASES: dict[str, tuple[str, ...]] = {
    "date": ("date", "day"),
    "profile": ("profile", "seller", "account", "account name", "profiles"),
    "gig": ("gig", "gig name", "gig title"),
    "impressions": ("impressions", "impression"),
    "clicks": ("clicks", "click"),
    # ORGANIC orders, deliberately. VVRO orders are self-placed and never came
    # from an impression, so counting them would inflate the close rate and
    # make a reach problem look like a conversion win.
    "orders": ("organic orders", "orders", "orders placed"),
    "notes": ("notes", "note"),
}

DISPUTE_ALIASES: dict[str, tuple[str, ...]] = {
    "date": ("date", "date of order", "order date"),
    "client": ("client name", "client", "buyer"),
    "amount": ("order amount", "amount", "order price"),
    "dispute_type": ("dispute type", "type", "issue type"),
    "status": ("status",),
    "opened_on": ("opened on", "opened", "raised on"),
    "resolved_on": ("resolved on", "resolved", "closed on"),
    "refunded": ("amount refunded", "refunded", "refund amount"),
    "root_cause": ("root cause", "cause", "reason"),
    "notes": ("notes", "note", "remarks"),
}

#: Columns that exist in the sheets but carry no signal for the engine.
#: Listing them explicitly keeps ``unmapped_rate`` meaningful — it should
#: measure *unrecognised* columns, not *deliberately ignored* ones.
IGNORED_HEADERS: frozenset[str] = frozenset({
    "add to clickup", "clickup task", "clickup status", "clickup",
    "column 16", "column 21", "column 20",
    "merged add client website link", "add client website link",
    "done", "follow up date", "last follow up date",
    "follow up", "follow up 1", "follow up 2", "follow up 3",
    "follow up order placed", "follow up order placed 2",
    "follow up with clients", "followup", "followup 2", "followup 3",
    "private review", "gig", "meeting", "shift",
    "urban stroll", "headstrong software",   # data leaked into a header cell
    # Impressions-sheet columns the decomposition does not consume.
    "totol order", "total order", "vvro orders", "vvro", "organic price",
    "vvro price", "order completed", "completed price", "order queue",
    "click ratio", "conversion rate", "total reviews", "msg ratio",
    "cancellation", "cancel price", "profile rating", "update", "success score",
})

#: A profile name matching this is a spreadsheet aggregate row, not a seller.
_AGGREGATE_PROFILE = re.compile(r"^[\s\-—–─_=*]*(total|sum|grand total)[\s\-—–─_=*]*$", re.I)


#: Tabs named after a seller profile. Anything else is not a profile tab.
KNOWN_PROFILES = frozenset({
    "X Studioz", "Carpicon", "Grid Designs", "Eikon Designs", "Alee Studioz",
    "Abdul Haseeb", "Tariq Mahmood", "BIC", "Dygram", "Storm", "Skyblew",
    "WeDesignz", "Dygram Designs", "Storm Design", "Abdul Haseeb Upwork",
})


def is_aggregate_profile(name: str) -> bool:
    return bool(_AGGREGATE_PROFILE.match(str(name or "").strip()))

TRACKER_ALIASES: dict[str, tuple[str, ...]] = {
    "order_no": ("order", "order no", "order number", "order #"),
    "client": ("client name", "client"),
    "order_type": ("order type", "type"),
    "source": ("source",),
    "order_date": ("date of order", "order date", "date"),
    "first_draft_date": ("initial draft date", "first draft date"),
    "status": ("current status", "status"),
    "latest_sent": ("latest rev what was sent", "latest rev", "what was sent"),
    "summary": ("order summary", "summary"),
    "buyer_mood": ("buyer mood behavior", "buyer mood", "buyer behaviour"),
    "last_updated": ("last updated",),
    "handoff_notes": ("csr handoff notes", "handoff notes"),
}


@dataclass
class MappedBlock:
    """A block whose columns have been resolved to canonical field names."""
    index: int
    field_to_col: dict[str, int]
    unmapped: list[str]
    header: list[str]
    rows: list[list[str]]

    def get(self, row: list[str], field_name: str) -> str | None:
        i = self.field_to_col.get(field_name)
        if i is None or i >= len(row):
            return None
        v = row[i].strip()
        return v or None


def map_columns(header: list[str], aliases: dict[str, tuple[str, ...]]) -> tuple[dict[str, int], list[str]]:
    """Resolve header cells to canonical fields.

    Duplicate headers are common (``Order Type`` twice in one tab, where the
    second is really the status). The first occurrence wins for the canonical
    field; later duplicates fall through to the next unclaimed alias, which is
    how ``Order Type | Order Type`` correctly becomes ``order_type | status``.
    """
    lookup: dict[str, list[str]] = {}
    for fieldname, toks in aliases.items():
        for t in toks:
            lookup.setdefault(t, []).append(fieldname)

    field_to_col: dict[str, int] = {}
    unmapped: list[str] = []
    for i, raw in enumerate(header):
        tok = _tok(raw)
        if not tok:
            continue
        candidates = lookup.get(tok)
        if not candidates:
            # Fallback: prefix match only, longest alias first, so
            # "order amount usd" resolves to amount but "quantum flux rating"
            # does not resolve to rating. Plain substring containment is too
            # eager here — it silently absorbs unrelated columns, which is the
            # opposite of what schema-drift detection is for.
            best: tuple[int, str] | None = None
            for t, fields in lookup.items():
                if len(t) >= 4 and (tok.startswith(t) or t.startswith(tok)):
                    if best is None or len(t) > best[0]:
                        best = (len(t), fields[0])
            candidates = [best[1]] if best else None
        if not candidates:
            if tok not in IGNORED_HEADERS:
                unmapped.append(raw)
            continue
        placed = False
        for f in candidates:
            if f not in field_to_col:
                field_to_col[f] = i
                placed = True
                break
        if not placed:
            # Header already claimed. In the observed sheets a repeated
            # "Order Type" means the second column is really the status.
            if "order_type" in candidates and "status" not in field_to_col:
                field_to_col["status"] = i
            elif tok not in IGNORED_HEADERS:
                unmapped.append(raw)
    return field_to_col, unmapped


def classify_and_map(
    blocks: list[list[list[str]]],
    aliases: dict[str, tuple[str, ...]],
    required: Iterable[str],
    min_rows: int = 1,
) -> list[MappedBlock]:
    """Keep only blocks whose header resolves all ``required`` fields."""
    required = set(required)
    out: list[MappedBlock] = []
    for i, block in enumerate(blocks):
        if len(block) <= min_rows:
            continue
        header, rows = block[0], block[1:]
        f2c, unmapped = map_columns(header, aliases)
        if required <= set(f2c):
            out.append(MappedBlock(i, f2c, unmapped, header, rows))
    return out


# --------------------------------------------------------------------------
# Ingest result
# --------------------------------------------------------------------------

@dataclass
class IngestResult:
    orders: list[C.Order] = field(default_factory=list)
    leads: list[C.Lead] = field(default_factory=list)
    flow: list[C.DailyFlow] = field(default_factory=list)
    active: list[C.ActiveOrder] = field(default_factory=list)
    impressions: list[C.Impression] = field(default_factory=list)
    disputes: list[C.Dispute] = field(default_factory=list)
    automation_errors: list[dict[str, str]] = field(default_factory=list)
    #: Spreadsheet aggregate rows, kept aside so they can cross-check the
    #: per-profile sums instead of polluting them.
    flow_aggregates: list[C.DailyFlow] = field(default_factory=list)
    unmapped_columns: Counter = field(default_factory=Counter)
    blocks_seen: int = 0
    blocks_used: int = 0
    header_cells_seen: int = 0
    coercion_misses: Counter = field(default_factory=Counter)

    @property
    def unmapped_rate(self) -> float:
        """Share of header cells the ingester did not recognise.

        Ignored-but-known headers do not count against this; only genuinely
        unrecognised ones do. A rising rate means a sheet changed shape and
        the engine is silently losing a column.
        """
        return sum(self.unmapped_columns.values()) / max(self.header_cells_seen, 1)

    def stats(self) -> dict[str, Any]:
        return {
            "orders": len(self.orders),
            "leads": len(self.leads),
            "flow_rows": len(self.flow),
            "flow_aggregate_rows": len(self.flow_aggregates),
            "active_orders": len(self.active),
            "impressions": len(self.impressions),
            "disputes": len(self.disputes),
            "automation_errors": len(self.automation_errors),
            "blocks_seen": self.blocks_seen,
            "blocks_used": self.blocks_used,
            "header_cells_seen": self.header_cells_seen,
            "unmapped_columns": dict(self.unmapped_columns.most_common(20)),
            "unmapped_rate": round(self.unmapped_rate, 4),
            "coercion_misses": dict(self.coercion_misses),
        }


# --------------------------------------------------------------------------
# Per-source ingesters
# --------------------------------------------------------------------------

def ingest_orders_workbook(text: str, source_id: str = "orders") -> IngestResult:
    """Parse the order/CRM workbook: order history + daily ledger + error log."""
    res = IngestResult()
    blocks = split_blocks(text)
    res.blocks_seen = len(blocks)

    # --- daily Organic/VVRO ledger ------------------------------------------
    for mb in classify_and_map(blocks, FLOW_ALIASES,
                               required=("date", "profile", "organic_orders", "vvro_orders")):
        res.blocks_used += 1
        res.header_cells_seen += len([h for h in mb.header if h.strip()])
        res.unmapped_columns.update(mb.unmapped)
        for r_i, row in enumerate(mb.rows):
            d = C.to_date(mb.get(row, "date"))
            profile = mb.get(row, "profile")
            if not d or not profile:
                continue
            prov = Provenance(source_id, "daily_ledger", mb.index, r_i)
            bucket = res.flow_aggregates if is_aggregate_profile(profile) else res.flow
            bucket.append(C.DailyFlow(
                date=d, profile=C.normalise_profile(profile), provenance=prov,
                organic_orders=C.to_money(mb.get(row, "organic_orders")) or 0.0,
                vvro_orders=C.to_money(mb.get(row, "vvro_orders")) or 0.0,
                organic_revenue=C.to_money(mb.get(row, "organic_revenue")) or 0.0,
                vvro_revenue=C.to_money(mb.get(row, "vvro_revenue")) or 0.0,
                total_orders=C.to_money(mb.get(row, "total_orders")) or 0.0,
                total_revenue=C.to_money(mb.get(row, "total_revenue")) or 0.0,
            ))

    flow_blocks = {mb.index for mb in classify_and_map(
        blocks, FLOW_ALIASES, required=("date", "profile", "organic_orders", "vvro_orders"))}

    # --- order history -------------------------------------------------------
    for mb in classify_and_map(blocks, ORDER_ALIASES, required=("client",)):
        if mb.index in flow_blocks:
            continue
        # The Apps Script error log also has a "Client" column; skip it.
        if {_tok(h) for h in mb.header} >= {"timestamp", "tab", "row", "message"}:
            continue
        res.blocks_used += 1
        res.header_cells_seen += len([h for h in mb.header if h.strip()])
        res.unmapped_columns.update(mb.unmapped)
        for r_i, row in enumerate(mb.rows):
            client = mb.get(row, "client")
            if not client:
                continue
            prov = Provenance(source_id, "order_history", mb.index, r_i)
            raw_date = mb.get(row, "order_date")
            od = C.to_date(raw_date)
            if raw_date and od is None:
                res.coercion_misses["order_date"] += 1
            res.orders.append(C.Order(
                client=client.strip(),
                provenance=prov,
                order_date=od,
                delivered_date=C.to_date(mb.get(row, "delivered_date")),
                project=mb.get(row, "project"),
                industry=(mb.get(row, "industry") or "").strip().title() or None,
                country=C.normalise_country(mb.get(row, "country")),
                order_type=C.to_order_type(mb.get(row, "order_type")),
                status=C.to_order_status(mb.get(row, "status")),
                amount=C.to_money(mb.get(row, "amount")),
                tip=C.to_money(mb.get(row, "tip")),
                rating=C.to_rating(mb.get(row, "rating")),
                logo_designer=C.normalise_person(mb.get(row, "logo_designer")),
                branding_designer=C.normalise_person(mb.get(row, "branding_designer")),
                csr=C.normalise_person(mb.get(row, "csr")),
                upsell=C.to_bool(mb.get(row, "upsell")),
                upsell_detail=mb.get(row, "upsell_detail"),
                notes=mb.get(row, "notes"),
                rating_tracked="rating" in mb.field_to_col,
                upsell_tracked="upsell" in mb.field_to_col,
                status_tracked="status" in mb.field_to_col,
            ))

    # --- Apps Script error log ----------------------------------------------
    for i, block in enumerate(blocks):
        toks = {_tok(h) for h in block[0]}
        if {"timestamp", "message"} <= toks:
            hdr = [_tok(h) for h in block[0]]
            for row in block[1:]:
                d = dict(zip(hdr, row))
                if d.get("message"):
                    res.automation_errors.append(
                        {"timestamp": d.get("timestamp", ""), "message": d["message"]})
    return res


def ingest_inquiries_workbook(text: str, source_id: str = "inquiries") -> IngestResult:
    res = IngestResult()
    blocks = split_blocks(text)
    res.blocks_seen = len(blocks)
    for mb in classify_and_map(blocks, LEAD_ALIASES, required=("client", "status")):
        res.blocks_used += 1
        res.header_cells_seen += len([h for h in mb.header if h.strip()])
        res.unmapped_columns.update(mb.unmapped)
        for r_i, row in enumerate(mb.rows):
            client = mb.get(row, "client")
            if not client:
                continue
            prov = Provenance(source_id, "inquiry_log", mb.index, r_i)
            res.leads.append(C.Lead(
                client=client.strip(),
                provenance=prov,
                date=C.to_date(mb.get(row, "date")),
                country=C.normalise_country(mb.get(row, "country")),
                member_since=mb.get(row, "member_since"),
                completed_orders=C.to_money(mb.get(row, "completed_orders")),
                status=C.to_lead_status(mb.get(row, "status")),
                quoted=C.to_money(mb.get(row, "quoted")),
                upsell_attempted=C.to_bool(mb.get(row, "upsell_attempted")),
                followup_1=C.to_bool(mb.get(row, "followup_1")),
                followup_2=C.to_bool(mb.get(row, "followup_2")),
                followup_3=C.to_bool(mb.get(row, "followup_3")),
                shift=(mb.get(row, "shift") or "").strip().title() or None,
                csr=C.normalise_person(mb.get(row, "csr")),
                last_contact=C.to_date(mb.get(row, "last_contact")),
                service=mb.get(row, "service"),
                note=mb.get(row, "note"),
            ))
    return res


def ingest_tracker_rows(rows: list[dict[str, Any]], source_id: str = "order_tracker") -> IngestResult:
    """Ingest the CSR handoff tracker from already-extracted dict rows.

    Kept separate from the markdown path because this source arrives as an
    .xlsx upload rather than a Drive text export.
    """
    res = IngestResult()
    res.blocks_seen = 1
    res.blocks_used = 1
    if not rows:
        return res
    header = list(rows[0].keys())
    f2c_names, unmapped = map_columns(header, TRACKER_ALIASES)
    res.unmapped_columns.update(unmapped)
    idx_to_field = {i: f for f, i in f2c_names.items()}
    for r_i, raw in enumerate(rows):
        vals = list(raw.values())
        rec: dict[str, Any] = {}
        for i, v in enumerate(vals):
            f = idx_to_field.get(i)
            if f and v not in (None, ""):
                rec[f] = v
        if not rec.get("client"):
            continue
        prov = Provenance(source_id, "tracker", 0, r_i)
        res.active.append(C.ActiveOrder(
            order_no=str(rec.get("order_no", r_i + 1)),
            client=str(rec["client"]).strip(),
            provenance=prov,
            order_type=C.to_order_type(rec.get("order_type")),
            source=rec.get("source"),
            order_date=C.to_date(rec.get("order_date")),
            first_draft_date=C.to_date(rec.get("first_draft_date")),
            status=(str(rec.get("status")).strip() if rec.get("status") else None),
            latest_sent=rec.get("latest_sent"),
            summary=rec.get("summary"),
            buyer_mood=rec.get("buyer_mood"),
            last_updated=C.to_date(rec.get("last_updated")),
            handoff_notes=rec.get("handoff_notes"),
        ))
    return res


# --------------------------------------------------------------------------
# Snapshot ingestion — the clean path
# --------------------------------------------------------------------------

def _rows_as(mb: MappedBlock, build) -> list:
    out = []
    for r_i, row in enumerate(mb.rows):
        rec = build(mb, row, r_i)
        if rec is not None:
            out.append(rec)
    return out


#: Values a spreadsheet writes into an untouched row on its own. A checkbox
#: column renders as FALSE in every row of the sheet, including the empty ones
#: below the last real entry, so "has any non-empty cell" is not a usable test
#: for whether a row carries data.
_DEFAULTED_CELLS = frozenset({"", "false", "true", "no", "0", "0.0", "-", "n/a"})


def _is_padding(row: list[str]) -> bool:
    """True when a row carries no content of its own.

    Every cell is either empty or a value the sheet supplies by default, which
    means nothing in this row was ever typed by a person. Real rows always
    carry at least a date, a client or an amount.
    """
    return all(c.strip().lower() in _DEFAULTED_CELLS for c in row)


def _clean_rows(header: list[str], rows: list[list[str]]) -> list[list[str]]:
    """Repair two things every hand-maintained sheet does.

    *merged cells* — Google returns a merged range's value only in its
    top-left cell; every other row comes back blank. The impressions sheet
    merges the date across its seven profile rows, so 134 of 162 rows arrived
    dateless and were silently dropped. Blank leading cells are carried down
    from the last non-blank value.

    *repeated header rows* — the same sheet re-prints its header every seventh
    row. Left alone those parse as data and become a client called
    "Client Name".

    *trailing blank rows* — and this is the one that mattered. Every tab in
    these workbooks carries hundreds of empty padding rows below the last real
    entry, because the sheet was sized generously and never trimmed. A wholly
    blank row is not a merged-cell continuation; it is nothing. Forward-filling
    it stamped the last real order's date and client onto all of them, which
    turned 6,152 real orders into 16,049 and invented a single client with
    1,311 same-day orders. Skip blank rows before the fill, never after: after
    the fill they are no longer blank and cannot be told apart from real rows.
    """
    hdr_sig = [h.strip().lower() for h in header]
    out: list[list[str]] = []
    carry: list[str] = []
    for row in rows:
        if [c.strip().lower() for c in row][:len(hdr_sig)] == hdr_sig:
            continue
        if _is_padding(row):
            continue
        fixed = list(row)
        # Only forward-fill the leading key columns (date, profile). Filling
        # value columns would invent numbers that were genuinely blank.
        for i in range(min(2, len(fixed))):
            if not fixed[i].strip() and i < len(carry) and carry[i].strip():
                fixed[i] = carry[i]
        carry = [fixed[i] if i < len(fixed) else "" for i in range(2)]
        out.append(fixed)
    return out


def ingest_snapshot(snap, source_id: str = "snapshot") -> IngestResult:
    """Ingest a :class:`xstudioz.snapshot.Snapshot`.

    Preferred over the markdown-export path: tabs arrive already labelled with
    a role and a real name, so the ingester maps columns rather than also
    having to guess what each block of text is. Header aliasing is unchanged —
    the same alias tables run, so a renamed column is still caught and
    reported rather than silently dropped.
    """
    res = IngestResult()
    res.blocks_seen = len(snap.tables)

    for t_i, table in enumerate(snap.tables):
        aliases = {
            "crm_orders": ORDER_ALIASES,
            "funnel": LEAD_ALIASES,
            "daily_flow": FLOW_ALIASES,
            "active_orders": TRACKER_ALIASES,
            "impressions": IMPRESSION_ALIASES,
            "disputes": DISPUTE_ALIASES,
        }.get(table.role)
        if aliases is None:
            if table.role == "automation_health":
                hdr = [_tok(h) for h in table.header]
                for row in table.rows:
                    d = dict(zip(hdr, row))
                    if d.get("message"):
                        res.automation_errors.append(
                            {"timestamp": d.get("timestamp", ""),
                             "message": d["message"]})
            elif table.role == "unknown":
                res.unmapped_columns[f"<unclassified tab: {table.name}>"] += 1
            continue

        f2c, unmapped = map_columns(table.header, aliases)
        res.blocks_used += 1
        res.header_cells_seen += len([h for h in table.header if h.strip()])
        res.unmapped_columns.update(unmapped)
        mb = MappedBlock(t_i, f2c, unmapped, table.header,
                         _clean_rows(table.header, table.rows))
        src = table.source_id or source_id
        # The tab name IS the profile in both workbooks. Fall back to None
        # rather than guessing, so an unrecognised tab is visibly unattributed
        # instead of quietly counted as the main profile.
        tab_profile = C.normalise_profile(table.name)
        if tab_profile not in KNOWN_PROFILES:
            tab_profile = None

        def prov(r_i: int, tid: str = table.role) -> Provenance:
            return Provenance(src, table.name, t_i, r_i)

        if table.role == "crm_orders":
            for r_i, row in enumerate(mb.rows):
                client = mb.get(row, "client")
                if not client:
                    continue
                raw_date = mb.get(row, "order_date")
                od = C.to_date(raw_date)
                if raw_date and od is None:
                    res.coercion_misses["order_date"] += 1
                res.orders.append(C.Order(
                    client=client.strip(), provenance=prov(r_i),
                    profile=tab_profile, order_date=od,
                    delivered_date=C.to_date(mb.get(row, "delivered_date")),
                    project=mb.get(row, "project"),
                    industry=(mb.get(row, "industry") or "").strip().title() or None,
                    country=C.normalise_country(mb.get(row, "country")),
                    order_type=C.to_order_type(mb.get(row, "order_type")),
                    status=C.to_order_status(mb.get(row, "status")),
                    amount=C.to_money(mb.get(row, "amount")),
                    tip=C.to_money(mb.get(row, "tip")),
                    rating=C.to_rating(mb.get(row, "rating")),
                    logo_designer=C.normalise_person(mb.get(row, "logo_designer")),
                    branding_designer=C.normalise_person(mb.get(row, "branding_designer")),
                    csr=C.normalise_person(mb.get(row, "csr")),
                    upsell=C.to_bool(mb.get(row, "upsell")),
                    upsell_detail=mb.get(row, "upsell_detail"),
                    notes=mb.get(row, "notes"),
                    rating_tracked="rating" in f2c,
                    upsell_tracked="upsell" in f2c,
                    status_tracked="status" in f2c))

        elif table.role == "funnel":
            for r_i, row in enumerate(mb.rows):
                client = mb.get(row, "client")
                if not client:
                    continue
                res.leads.append(C.Lead(
                    client=client.strip(), provenance=prov(r_i),
                    profile=tab_profile,
                    date=C.to_date(mb.get(row, "date")),
                    country=C.normalise_country(mb.get(row, "country")),
                    member_since=mb.get(row, "member_since"),
                    completed_orders=C.to_money(mb.get(row, "completed_orders")),
                    status=C.to_lead_status(mb.get(row, "status")),
                    quoted=C.to_money(mb.get(row, "quoted")),
                    upsell_attempted=C.to_bool(mb.get(row, "upsell_attempted")),
                    followup_1=C.to_bool(mb.get(row, "followup_1")),
                    followup_2=C.to_bool(mb.get(row, "followup_2")),
                    followup_3=C.to_bool(mb.get(row, "followup_3")),
                    shift=(mb.get(row, "shift") or "").strip().title() or None,
                    csr=C.normalise_person(mb.get(row, "csr")),
                    last_contact=C.to_date(mb.get(row, "last_contact")),
                    service=mb.get(row, "service"), note=mb.get(row, "note")))

        elif table.role == "daily_flow":
            for r_i, row in enumerate(mb.rows):
                d = C.to_date(mb.get(row, "date"))
                profile = mb.get(row, "profile")
                if not d or not profile:
                    continue
                bucket = (res.flow_aggregates if is_aggregate_profile(profile)
                          else res.flow)
                bucket.append(C.DailyFlow(
                    date=d, profile=profile.strip(), provenance=prov(r_i),
                    organic_orders=C.to_money(mb.get(row, "organic_orders")) or 0.0,
                    vvro_orders=C.to_money(mb.get(row, "vvro_orders")) or 0.0,
                    organic_revenue=C.to_money(mb.get(row, "organic_revenue")) or 0.0,
                    vvro_revenue=C.to_money(mb.get(row, "vvro_revenue")) or 0.0,
                    total_orders=C.to_money(mb.get(row, "total_orders")) or 0.0,
                    total_revenue=C.to_money(mb.get(row, "total_revenue")) or 0.0))

        elif table.role == "active_orders":
            for r_i, row in enumerate(mb.rows):
                client = mb.get(row, "client")
                if not client:
                    continue
                res.active.append(C.ActiveOrder(
                    order_no=str(mb.get(row, "order_no") or r_i + 1),
                    client=client.strip(), provenance=prov(r_i),
                    order_type=C.to_order_type(mb.get(row, "order_type")),
                    source=mb.get(row, "source"),
                    order_date=C.to_date(mb.get(row, "order_date")),
                    first_draft_date=C.to_date(mb.get(row, "first_draft_date")),
                    status=mb.get(row, "status"),
                    latest_sent=mb.get(row, "latest_sent"),
                    summary=mb.get(row, "summary"),
                    buyer_mood=mb.get(row, "buyer_mood"),
                    last_updated=C.to_date(mb.get(row, "last_updated")),
                    handoff_notes=mb.get(row, "handoff_notes")))

        elif table.role == "impressions":
            for r_i, row in enumerate(mb.rows):
                d = C.to_date(mb.get(row, "date"))
                if not d:
                    continue
                res.impressions.append(C.Impression(
                    date=d, provenance=prov(r_i),
                    profile=C.normalise_profile(mb.get(row, "profile")),
                    gig=mb.get(row, "gig"),
                    impressions=C.to_money(mb.get(row, "impressions")) or 0.0,
                    clicks=C.to_money(mb.get(row, "clicks")) or 0.0,
                    orders=C.to_money(mb.get(row, "orders")) or 0.0,
                    notes=mb.get(row, "notes")))

        elif table.role == "disputes":
            for r_i, row in enumerate(mb.rows):
                client = mb.get(row, "client")
                if not client:
                    continue
                res.disputes.append(C.Dispute(
                    client=client.strip(), provenance=prov(r_i),
                    date=C.to_date(mb.get(row, "date")),
                    amount=C.to_money(mb.get(row, "amount")),
                    dispute_type=C.to_dispute_type(mb.get(row, "dispute_type")),
                    status=mb.get(row, "status"),
                    opened_on=C.to_date(mb.get(row, "opened_on")),
                    resolved_on=C.to_date(mb.get(row, "resolved_on")),
                    refunded=C.to_money(mb.get(row, "refunded")),
                    root_cause=C.to_root_cause(mb.get(row, "root_cause")),
                    notes=mb.get(row, "notes")))

    return res


def merge(*results: IngestResult) -> IngestResult:
    out = IngestResult()
    for r in results:
        out.orders += r.orders
        out.leads += r.leads
        out.flow += r.flow
        out.flow_aggregates += r.flow_aggregates
        out.active += r.active
        out.impressions += r.impressions
        out.disputes += r.disputes
        out.automation_errors += r.automation_errors
        out.unmapped_columns.update(r.unmapped_columns)
        out.coercion_misses.update(r.coercion_misses)
        out.blocks_seen += r.blocks_seen
        out.blocks_used += r.blocks_used
        out.header_cells_seen += r.header_cells_seen
    return out


def write_normalized(res: IngestResult, out_dir: Path) -> dict[str, int]:
    """Persist canonical records as JSONL so every run is reproducible."""
    out_dir.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    for name, records in (("orders", res.orders), ("leads", res.leads),
                          ("flow", res.flow), ("active", res.active),
                          ("impressions", res.impressions),
                          ("disputes", res.disputes)):
        path = out_dir / f"{name}.jsonl"
        with path.open("w", encoding="utf-8") as fh:
            for rec in records:
                fh.write(json.dumps(C.as_dict(rec), ensure_ascii=False) + "\n")
        counts[name] = len(records)
    (out_dir / "ingest_stats.json").write_text(
        json.dumps(res.stats(), indent=2), encoding="utf-8")
    return counts
