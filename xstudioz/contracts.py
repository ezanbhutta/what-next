"""Canonical data contracts.

The source sheets drift: across tabs the same field appears as ``Order Type``,
``Order type``, ``Gig``, or nothing at all; ``Date`` becomes ``Date of Order``
or gets overwritten by a project name. Ten distinct header layouts were
observed in the inquiry workbook alone and eight in the order workbook.

Rather than pin the engine to any one layout, everything upstream normalises
into the canonical records defined here, and every record carries the
provenance needed to trace a number back to the exact source row.
"""

from __future__ import annotations

import datetime as _dt
import re
from dataclasses import dataclass, field, asdict
from typing import Any, Iterable

# --------------------------------------------------------------------------
# Canonical vocabularies
# --------------------------------------------------------------------------

#: Inorganic / self-placed orders. The team writes this as "VVRO".
ORDER_TYPE_VVRO = "vvro"
ORDER_TYPE_ORGANIC = "organic"
ORDER_TYPE_UNKNOWN = "unknown"

_ORDER_TYPE_MAP = {
    "organic": ORDER_TYPE_ORGANIC,
    "orgnic": ORDER_TYPE_ORGANIC,
    "direct": ORDER_TYPE_ORGANIC,
    "direct order": ORDER_TYPE_ORGANIC,
    "vvro": ORDER_TYPE_VVRO,
    "vro": ORDER_TYPE_VVRO,
    "inorganic": ORDER_TYPE_VVRO,
}

ORDER_STATUSES = {
    "new", "in_progress", "rev_sent", "approved", "completed",
    "delivered", "on_hold", "dead", "cancelled", "revision",
}

_STATUS_MAP = {
    "new": "new",
    "in progress": "in_progress",
    "inprogress": "in_progress",
    "rev sent": "rev_sent",
    "revision": "revision",
    "approved": "approved",
    "completed": "completed",
    "complete": "completed",
    "auto-complete": "completed",
    "delivered": "delivered",
    "on hold": "on_hold",
    "dead": "dead",
    "cancel": "cancelled",
    "cancelled": "cancelled",
    "canceled": "cancelled",
}

#: An order is EARNED only when the buyer has accepted it. Everything else is
#: either still in flight or gone.
#:
#: This distinction is the operator's, not an invention: "active orders are all
#: that are in revisions, missing requirement, delivered — only completed order
#: are completed from sheet". On Fiverr a delivery is not money; the buyer has
#: to accept it, and until then the order can still be revised, disputed or
#: cancelled.
#:
#: Before this existed, ``economics()`` selected on ``amount > 0`` and never
#: looked at status, so revenue counted $4,350 of CANCELLED orders and $5,885
#: of work not yet accepted — 9.6% above what had actually been earned. A
#: revenue line that includes cancelled work is not a rounding error, it is a
#: different number wearing the same name.
EARNED_STATUSES = frozenset({"completed", "approved"})

#: In flight: the work exists, the money does not yet.
ACTIVE_STATUSES = frozenset({"new", "in_progress", "rev_sent", "revision", "delivered", "on_hold"})

#: Gone. Never counts as revenue, and never counts as a live order either.
CLOSED_LOST_STATUSES = frozenset({"cancelled", "dead"})


def is_earned(status: Any) -> bool:
    """True only when the buyer has accepted and the money is real."""
    return str(status or "").strip().lower() in EARNED_STATUSES


def is_active(status: Any) -> bool:
    """True while the order is live work — including delivered-but-not-accepted."""
    return str(status or "").strip().lower() in ACTIVE_STATUSES


def is_lost(status: Any) -> bool:
    return str(status or "").strip().lower() in CLOSED_LOST_STATUSES


LEAD_STATUSES = {"placed", "not_placed", "out_of_scope", "cancelled", "unknown"}

_LEAD_STATUS_MAP = {
    "placed": "placed",
    "direct order": "placed",
    "not placed": "not_placed",
    "notplaced": "not_placed",
    "out of scope": "out_of_scope",
    "cancel": "cancelled",
}


# --------------------------------------------------------------------------
# Coercion helpers — deliberately total. They never raise; they return None
# and the caller records a coercion miss, because a single malformed cell must
# never take down a daily run.
# --------------------------------------------------------------------------

_DATE_FORMATS = (
    "%Y-%m-%d", "%d-%b-%Y", "%d-%B-%Y", "%d %b %Y", "%d %B %Y",
    "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y", "%d-%b-%y", "%d/%m/%y",
    "%Y-%m-%d %H:%M:%S", "%d/%m/%Y %H:%M:%S", "%d-%m-%y",
)


def to_date(value: Any) -> _dt.date | None:
    """Parse the many date spellings found across the workbooks."""
    if value is None:
        return None
    if isinstance(value, _dt.datetime):
        return value.date()
    if isinstance(value, _dt.date):
        return value
    text = str(value).strip()
    if not text or text.lower() in {"-", "n/a", "na", "none", "tbd"}:
        return None
    for fmt in _DATE_FORMATS:
        try:
            return _dt.datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    # "26-01-26" style: ambiguous d-m-y with 2-digit year.
    m = re.fullmatch(r"(\d{1,2})[-/](\d{1,2})[-/](\d{2})", text)
    if m:
        d, mo, y = (int(x) for x in m.groups())
        if 1 <= mo <= 12 and 1 <= d <= 31:
            try:
                return _dt.date(2000 + y, mo, d)
            except ValueError:
                return None
    return None


_MONEY_RE = re.compile(r"-?\d+(?:[\d,]*\d)?(?:\.\d+)?")


def to_money(value: Any) -> float | None:
    """Parse ``$1,234.50``, ``1234``, ``$45.00 `` and friends."""
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    text = str(value).strip()
    if not text:
        return None
    m = _MONEY_RE.search(text.replace(",", ""))
    if not m:
        return None
    try:
        return float(m.group(0))
    except ValueError:
        return None


def to_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in {"true", "yes", "y", "1", "done", "checked"}:
        return True
    if text in {"false", "no", "n", "0", "unchecked"}:
        return False
    return None


def to_order_type(value: Any) -> str:
    text = str(value or "").strip().lower()
    return _ORDER_TYPE_MAP.get(text, ORDER_TYPE_UNKNOWN if text else ORDER_TYPE_UNKNOWN)


def to_order_status(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    return _STATUS_MAP.get(text)


def to_lead_status(value: Any) -> str:
    text = str(value or "").strip().lower()
    return _LEAD_STATUS_MAP.get(text, "unknown")


def to_rating(value: Any) -> float | None:
    """Reviews are recorded as ``5.0``, ``5``, ``no review``, ``no``, ``0.0``.

    They are also recorded as ``5 star``, ``5 Star``, ``5 STAR``, ``4.7 star``
    and ``4.3 Star``. Nine CSRs have typed this column for nine months and no
    validation ever ran on it, so the suffix is not an edge case: 374 real
    ratings carry one. Parsing only the bare number silently reclassified all
    of them as "no review", which understated review capture by a factor of
    seven and put a fabricated "buyers are not reviewing" task at the top of
    every brief.
    """
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text or text.startswith("no"):
        return None
    # Drop a trailing "star"/"stars" before the numeric parse. Anchored to the
    # end so a genuinely unparseable note ("escalated, star client") still
    # fails rather than yielding a number.
    text = re.sub(r"\s*stars?\s*$", "", text)
    try:
        r = float(text)
    except ValueError:
        return None
    # 0.0 in this dataset means "not reviewed", not "rated zero" — Fiverr has
    # no zero-star rating.
    return r if 1.0 <= r <= 5.0 else None


def normalise_country(value: Any) -> str | None:
    text = re.sub(r"\s+", " ", str(value or "")).strip().title()
    if not text:
        return None
    return {
        "Us": "United States", "Usa": "United States", "U.S.": "United States",
        "Uk": "United Kingdom", "U.K.": "United Kingdom",
        "Uae": "United Arab Emirates",
        "Ksa": "Saudi Arabia",
    }.get(text, text)


#: The same seller is written "XStudioz" in the impressions sheet and
#: "X Studioz" in the orders ledger. Left unnormalised, every impressions row
#: silently belongs to a profile that has no orders, and the decomposition
#: quietly reports "no data" forever.
#:
#: Keys are matched on their *squashed* form — lowercase, alphanumerics only —
#: so one entry covers "Grid Designs", "grid designs", "GridDesigns" and
#: "grid_designs" without anyone having to think of each variant. The previous
#: version enumerated spellings by hand and was therefore only as good as
#: whoever last edited it: it carried "dygram" and "storm" while the sheets
#: actually say "Dygram Designs" and "Storm Design", so those two keys never
#: fired once and both profiles passed through uncanonicalised. An enumerated
#: list that looks exhaustive is worse than an obvious rule, because nobody
#: re-checks it. Add a spelling here only when squashing genuinely cannot
#: reach it (an abbreviation like "ah2", or a rename).
_PROFILE_CANON_RAW = {
    "xstudioz": "X Studioz",
    "carpicon": "Carpicon",
    "griddesigns": "Grid Designs",
    "eikondesigns": "Eikon Designs",
    "alee": "Alee Studioz",
    "aleestudioz": "Alee Studioz",
    "ah2": "Abdul Haseeb",
    "ah2branding": "Abdul Haseeb",
    "abdulhaseeb": "Abdul Haseeb",
    "bic": "BIC",
    "dygram": "Dygram Designs",
    "dygramdesigns": "Dygram Designs",
    "storm": "Storm Design",
    "stormdesign": "Storm Design",
    "stormdesigns": "Storm Design",
    "tariqmahmood": "Tariq Mahmood",
    # A different marketplace, not a spelling of the Fiverr profile. Kept
    # deliberately distinct so its orders never pool into Fiverr economics.
    "abdulhaseebupwork": "Abdul Haseeb Upwork",
}


def _squash(text: str) -> str:
    """Lowercase, alphanumerics only — 'Grid Designs' and 'GridDesigns' agree."""
    return re.sub(r"[^a-z0-9]", "", text.lower())


_PROFILE_CANON = {_squash(k): v for k, v in _PROFILE_CANON_RAW.items()}


def normalise_profile(value: Any) -> str | None:
    """Collapse the spellings of a seller profile to one canonical name."""
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if not text:
        return None
    return _PROFILE_CANON.get(_squash(text), text)


def normalise_person(value: Any) -> str | None:
    """People are typed inconsistently: ``Salman ``, ``ZUBAIR``, ``Ezan😊``."""
    text = str(value or "")
    text = re.sub(r"[^\w\s.'-]", "", text, flags=re.UNICODE).strip()
    text = re.sub(r"\s+", " ", text)
    if not text:
        return None
    canon = text.title()
    return {
        "Ashir": "Aashir",
        "Musharaf": "Musharaf",
        "Mushraf": "Musharaf",
        "Dulal Khan": "Dulal Khan",
    }.get(canon, canon)


# --------------------------------------------------------------------------
# Provenance
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Provenance:
    """Where a record came from, precisely enough to re-find it by hand."""
    source_id: str
    table_id: str
    block_index: int
    row_index: int

    def ref(self) -> str:
        return f"{self.source_id}/{self.table_id}#b{self.block_index}r{self.row_index}"


# --------------------------------------------------------------------------
# Canonical records
# --------------------------------------------------------------------------

@dataclass
class Order:
    client: str
    provenance: Provenance
    #: Which seller profile this order belongs to. The workbooks put every
    #: profile in its own TAB, so without this the engine pools all eleven
    #: into one and reports portfolio AOV as if it were X Studioz.
    profile: str | None = None
    order_date: _dt.date | None = None
    delivered_date: _dt.date | None = None
    project: str | None = None
    industry: str | None = None
    country: str | None = None
    order_type: str = ORDER_TYPE_UNKNOWN
    status: str | None = None
    amount: float | None = None
    tip: float | None = None
    rating: float | None = None
    logo_designer: str | None = None
    branding_designer: str | None = None
    csr: str | None = None
    upsell: bool | None = None
    upsell_detail: str | None = None
    notes: str | None = None
    #: Whether the source tab even had a column for these. Rates like "review
    #: capture" must divide by orders that *could* have been recorded, not by
    #: every row ever — the legacy board has no review or upsell column at all,
    #: and counting its rows as un-reviewed understates capture badly.
    rating_tracked: bool = False
    upsell_tracked: bool = False
    #: Whether the source tab had a status column at all. A blank cell in a tab
    #: that tracks status means "not accepted yet" and must not count as
    #: revenue. A tab with no status column tells us nothing about acceptance —
    #: it is a historical order record — and excluding all of it would erase a
    #: whole profile's revenue over a column that was never there. Same
    #: distinction as ``rating_tracked``, and it exists for the same reason.
    status_tracked: bool = False

    def revenue(self) -> float:
        return (self.amount or 0.0) + (self.tip or 0.0)


@dataclass
class Lead:
    client: str
    provenance: Provenance
    profile: str | None = None
    date: _dt.date | None = None
    country: str | None = None
    member_since: str | None = None
    completed_orders: float | None = None
    status: str = "unknown"
    quoted: float | None = None
    upsell_attempted: bool | None = None
    followup_1: bool | None = None
    followup_2: bool | None = None
    followup_3: bool | None = None
    shift: str | None = None
    csr: str | None = None
    last_contact: _dt.date | None = None
    service: str | None = None
    note: str | None = None

    def followup_depth(self) -> int:
        return sum(1 for f in (self.followup_1, self.followup_2, self.followup_3) if f)

    def converted(self) -> bool:
        return self.status == "placed"


@dataclass
class DailyFlow:
    """One row of the Organic-vs-VVRO daily ledger, per profile per day."""
    date: _dt.date
    profile: str
    provenance: Provenance
    organic_orders: float = 0.0
    vvro_orders: float = 0.0
    organic_revenue: float = 0.0
    vvro_revenue: float = 0.0
    total_orders: float = 0.0
    total_revenue: float = 0.0

    def computed_total_orders(self) -> float:
        return self.organic_orders + self.vvro_orders

    def vvro_share(self) -> float | None:
        t = self.computed_total_orders()
        return (self.vvro_orders / t) if t else None


@dataclass
class ActiveOrder:
    """A row of the live CSR handoff tracker — the highest-signal source for
    today's client-handling tasks."""
    order_no: str
    client: str
    provenance: Provenance
    order_type: str = ORDER_TYPE_UNKNOWN
    source: str | None = None
    order_date: _dt.date | None = None
    first_draft_date: _dt.date | None = None
    status: str | None = None
    latest_sent: str | None = None
    summary: str | None = None
    buyer_mood: str | None = None
    last_updated: _dt.date | None = None
    handoff_notes: str | None = None

    def days_since_update(self, today: _dt.date) -> int | None:
        if not self.last_updated:
            return None
        return (today - self.last_updated).days


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------

@dataclass
class Impression:
    """One gig's reach for one day.

    The analytically decisive source. Without it, a fall in organic orders is
    ambiguous: fewer people saw the gig (reach), or the same people saw it and
    did not buy (conversion). Those have opposite fixes — reach problems are
    ranking problems, conversion problems are gig-page problems — so guessing
    is worse than useless.
    """
    date: _dt.date
    provenance: Provenance
    profile: str | None = None
    gig: str | None = None
    impressions: float = 0.0
    clicks: float = 0.0
    orders: float = 0.0
    notes: str | None = None

    # The rest of what the sheet actually records. These were dropped on the
    # way in for a year, so the daily reach picture had to be rebuilt by hand
    # from the workbook whenever anybody wanted the money side of it.
    #
    # `None` and `0.0` are different and stay different: a blank cell is a day
    # nobody filled in, and a zero is a day with no orders. Collapsing them
    # turns every gap in the sheet into a reported zero, which is the one thing
    # a reach series must never do, because a run of zeroes reads as a collapse.
    organic_orders: float | None = None
    directed_orders: float | None = None
    organic_price: float | None = None
    directed_price: float | None = None
    orders_completed: float | None = None
    completed_price: float | None = None
    order_queue: float | None = None

    def ctr(self) -> float | None:
        return (self.clicks / self.impressions) if self.impressions else None

    def order_rate(self) -> float | None:
        """Orders per click — the gig page's closing rate."""
        return (self.orders / self.clicks) if self.clicks else None


DISPUTE_TYPES = {
    "refund_requested", "refund_given", "cancelled", "dead", "chargeback",
    "quality_complaint", "late_delivery", "unknown",
}

ROOT_CAUSES = {
    "brief_mismatch", "quality", "communication", "late", "scope_creep",
    "buyer_changed_mind", "scammer", "unknown",
}


@dataclass
class Dispute:
    """A disputed, refunded, cancelled or dead order."""
    client: str
    provenance: Provenance
    date: _dt.date | None = None
    amount: float | None = None
    dispute_type: str = "unknown"
    status: str | None = None
    opened_on: _dt.date | None = None
    resolved_on: _dt.date | None = None
    refunded: float | None = None
    root_cause: str = "unknown"
    notes: str | None = None

    def is_open(self) -> bool:
        return self.resolved_on is None

    def days_open(self, today: _dt.date) -> int | None:
        if not self.opened_on:
            return None
        return ((self.resolved_on or today) - self.opened_on).days

    def exposure(self) -> float:
        """Money still at risk on an unresolved dispute."""
        return (self.amount or 0.0) if self.is_open() else 0.0


def to_dispute_type(value: Any) -> str:
    t = re.sub(r"[^a-z]+", "_", str(value or "").strip().lower()).strip("_")
    return t if t in DISPUTE_TYPES else "unknown"


def to_root_cause(value: Any) -> str:
    t = re.sub(r"[^a-z]+", "_", str(value or "").strip().lower()).strip("_")
    return t if t in ROOT_CAUSES else "unknown"


@dataclass
class Violation:
    """A validation finding.

    ``domain`` is the important field:

    ``engine``
        The engine itself cannot trust what it read — a schema broke, a
        contract is violated, arithmetic does not close. These block the run,
        because acting on them would mean acting on numbers that are wrong.

    ``data``
        The *source data* has a mistake — a delivery dated before its order,
        a duplicate row, a placed lead with no value recorded. These must
        never block the run. Finding them is the product: they become tasks
        in the daily brief so the team fixes them.
    """
    severity: str          # "error" | "warn"
    domain: str            # "engine" | "data"
    code: str
    message: str
    ref: str | None = None

    def __str__(self) -> str:
        loc = f" [{self.ref}]" if self.ref else ""
        return f"{self.severity.upper()}/{self.domain} {self.code}: {self.message}{loc}"


@dataclass
class ValidationReport:
    violations: list[Violation] = field(default_factory=list)
    checked: int = 0

    def add(self, severity: str, domain: str, code: str, message: str,
            ref: str | None = None) -> None:
        self.violations.append(Violation(severity, domain, code, message, ref))

    @property
    def errors(self) -> list[Violation]:
        return [v for v in self.violations if v.severity == "error"]

    @property
    def warnings(self) -> list[Violation]:
        return [v for v in self.violations if v.severity == "warn"]

    @property
    def blocking(self) -> list[Violation]:
        """Only engine-domain errors stop a run."""
        return [v for v in self.violations
                if v.severity == "error" and v.domain == "engine"]

    @property
    def data_issues(self) -> list[Violation]:
        return [v for v in self.violations if v.domain == "data"]

    def ok(self) -> bool:
        return not self.blocking

    def by_code(self) -> dict[str, int]:
        c: dict[str, int] = {}
        for v in self.violations:
            c[v.code] = c.get(v.code, 0) + 1
        return dict(sorted(c.items(), key=lambda kv: -kv[1]))

    def summary(self) -> dict[str, Any]:
        return {
            "checked": self.checked,
            "blocking": len(self.blocking),
            "errors": len(self.errors),
            "warnings": len(self.warnings),
            "data_issues": len(self.data_issues),
            "by_code": self.by_code(),
        }

    def merge(self, other: "ValidationReport") -> "ValidationReport":
        self.violations += other.violations
        self.checked += other.checked
        return self


def validate_orders(orders: Iterable[Order], today: _dt.date | None = None) -> ValidationReport:
    today = today or _dt.date.today()
    rep = ValidationReport()
    seen: dict[tuple, str] = {}
    for o in orders:
        rep.checked += 1
        ref = o.provenance.ref()
        if not o.client:
            rep.add("error", "engine", "ORDER_NO_CLIENT", "order row has no client", ref)
        if o.amount is not None and o.amount < 0:
            rep.add("error", "data", "ORDER_NEG_AMOUNT", f"negative amount {o.amount}", ref)
        if o.amount is not None and o.amount > 5000:
            rep.add("warn", "data", "ORDER_AMOUNT_OUTLIER", f"amount {o.amount} far above p99", ref)
        if o.order_date and o.order_date > today:
            rep.add("warn", "data", "ORDER_FUTURE_DATE", f"order dated {o.order_date} in the future", ref)
        if o.order_date and o.delivered_date and o.delivered_date < o.order_date:
            rep.add("error", "data", "ORDER_DELIVERY_BEFORE_ORDER",
                    f"delivered {o.delivered_date} before ordered {o.order_date}", ref)
        if o.rating is not None and not (1.0 <= o.rating <= 5.0):
            rep.add("error", "data", "ORDER_BAD_RATING", f"rating {o.rating} out of range", ref)
        key = (o.client.lower().strip(), o.order_date, o.amount)
        if o.client and o.order_date and key in seen:
            rep.add("warn", "data", "ORDER_DUPLICATE",
                    f"possible duplicate of {seen[key]}", ref)
        elif o.client and o.order_date:
            seen[key] = ref
    return rep


def validate_leads(leads: Iterable[Lead], today: _dt.date | None = None) -> ValidationReport:
    today = today or _dt.date.today()
    rep = ValidationReport()
    for l in leads:
        rep.checked += 1
        ref = l.provenance.ref()
        if not l.client:
            rep.add("error", "engine", "LEAD_NO_CLIENT", "lead row has no client", ref)
        if l.status not in LEAD_STATUSES:
            rep.add("error", "engine", "LEAD_BAD_STATUS", f"unknown status {l.status!r}", ref)
        if l.status == "placed" and l.quoted is None:
            rep.add("warn", "data", "LEAD_PLACED_NO_VALUE",
                    "lead marked placed but no order value recorded", ref)
        if l.date and l.date > today:
            rep.add("warn", "data", "LEAD_FUTURE_DATE", f"lead dated {l.date} in the future", ref)
        if l.last_contact and l.date and l.last_contact < l.date:
            rep.add("warn", "data", "LEAD_CONTACT_BEFORE_INQUIRY",
                    f"last contact {l.last_contact} precedes inquiry {l.date}", ref)
    return rep


def validate_flow(rows: Iterable[DailyFlow]) -> ValidationReport:
    rep = ValidationReport()
    seen: set[tuple] = set()
    for r in rows:
        rep.checked += 1
        ref = r.provenance.ref()
        if (r.date, r.profile) in seen:
            rep.add("error", "data", "FLOW_DUPLICATE_DAY",
                    f"two ledger rows for {r.profile} on {r.date}", ref)
        seen.add((r.date, r.profile))
        for name, val in (("organic", r.organic_orders), ("vvro", r.vvro_orders)):
            if val < 0:
                rep.add("error", "data", "FLOW_NEGATIVE", f"{name} orders = {val}", ref)
        if r.total_orders and abs(r.total_orders - r.computed_total_orders()) > 1e-6:
            rep.add("error", "data", "FLOW_TOTAL_MISMATCH",
                    f"total_orders={r.total_orders} but organic+vvro="
                    f"{r.computed_total_orders()}", ref)
        if r.computed_total_orders() > 0 and r.total_revenue == 0:
            rep.add("warn", "data", "FLOW_REVENUE_MISSING",
                    f"{r.computed_total_orders():.0f} orders logged on {r.date} "
                    "but revenue is 0 — revenue is not being captured", ref)
    return rep


def as_dict(record: Any) -> dict[str, Any]:
    """Serialise a canonical record, rendering dates as ISO strings."""
    def conv(v: Any) -> Any:
        if isinstance(v, (_dt.date, _dt.datetime)):
            return v.isoformat()
        if isinstance(v, dict):
            return {k: conv(x) for k, x in v.items()}
        if isinstance(v, list):
            return [conv(x) for x in v]
        return v
    return {k: conv(v) for k, v in asdict(record).items()}
