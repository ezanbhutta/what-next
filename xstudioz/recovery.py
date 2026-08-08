"""Recovery: money already won that is sitting still.

Everything in this module is derived from rows the team already maintains —
no new tracking, no new traffic, no marketplace lever. Two populations:

*Stale open orders* — orders whose status is still `in_progress`, `revision`
or `delivered`, whose order date is far behind. The buyer has paid or
committed; the work is real; nobody closed it out. This is the most defensible
line in the whole dataset because every row names a client, an amount and a
designer.

*Unanswered quotes* — leads that were given a price and never placed. The old
engine read these from a hand-copied block in ``config/profile.yml`` that went
stale in February, so it recommended chasing a 174-day-old quote every morning
and never mentioned a $950 quote from three weeks ago that had no follow-up at
all. Both populations are now computed live from the workbooks on every run.

The ranking is deliberately not "biggest number first". A quote nobody has
touched ranks above a bigger one that has already had three follow-ups,
because the second one has been answered — with silence — and the first has
not been asked.
"""
from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from . import contracts as C

#: Order statuses that mean work is still owed to a buyer. `delivered` counts:
#: the tracker's own legend defines it as "final files delivered", which is not
#: the same as the order being closed, and four X Studioz orders have sat in it
#: for an average of 126 days.
OPEN_STATUSES = frozenset({"in_progress", "revision", "delivered"})

#: Age bands, in days. The 60+ band is the one that matters — past sixty days a
#: logo order is not late, it is forgotten.
BANDS: tuple[tuple[str, int, int], ...] = (
    ("0-7", 0, 7),
    ("8-30", 8, 30),
    ("31-60", 31, 60),
    ("60+", 61, 10_000),
)

#: Past this age an open order is treated as stale rather than merely running.
STALE_AFTER_DAYS = 60


def band_for(age_days: int) -> str:
    for name, lo, hi in BANDS:
        if lo <= age_days <= hi:
            return name
    return BANDS[-1][0]


# --------------------------------------------------------------------------
# Stale open orders
# --------------------------------------------------------------------------

@dataclass
class StaleOrder:
    client: str
    age_days: int
    band: str
    status: str
    #: None means the sheet's Order Amount cell is EMPTY, which is not zero.
    #: It was `float` and built from `Order.revenue()`, which does
    #: `(self.amount or 0.0)`. That is right for summing a month of revenue and
    #: wrong here: two open orders had blank cells and were printed as "$0" on
    #: the brief and the dashboard, next to real amounts, in the same typeface.
    #: A reader has no way to tell "this order is worth nothing" from "nobody
    #: recorded what this order is worth", and only one of those is a problem.
    amount: float | None
    order_date: _dt.date
    project: str | None = None
    designer: str | None = None
    csr: str | None = None

    @property
    def is_stale(self) -> bool:
        return self.age_days > STALE_AFTER_DAYS

    def as_dict(self) -> dict[str, Any]:
        return {
            "client": self.client, "age_days": self.age_days, "band": self.band,
            "status": self.status,
            "amount": None if self.amount is None else round(self.amount, 2),
            "order_date": self.order_date.isoformat(), "project": self.project,
            "designer": self.designer, "csr": self.csr, "stale": self.is_stale,
        }


@dataclass
class OpenOrderBook:
    """Every open order, banded by age."""
    orders: list[StaleOrder] = field(default_factory=list)
    as_of: _dt.date | None = None

    @property
    def stale(self) -> list[StaleOrder]:
        return [o for o in self.orders if o.is_stale]

    @property
    def total_value(self) -> float:
        """Only the orders whose amount is known. See `unpriced`."""
        return sum(o.amount for o in self.orders if o.amount is not None)

    @property
    def stale_value(self) -> float:
        return sum(o.amount for o in self.stale if o.amount is not None)

    @property
    def unpriced(self) -> list[StaleOrder]:
        """Open orders whose Order Amount cell is empty in the sheet.

        Reported rather than absorbed. A total that silently skips them is a
        floor presented as a total, and one that counts them as zero is worse.
        """
        return [o for o in self.orders if o.amount is None]

    @property
    def stale_unpriced(self) -> list[StaleOrder]:
        return [o for o in self.stale if o.amount is None]

    def by_band(self) -> dict[str, dict[str, float]]:
        out = {name: {"count": 0, "value": 0.0, "unpriced": 0} for name, _, _ in BANDS}
        for o in self.orders:
            out[o.band]["count"] += 1
            if o.amount is None:
                out[o.band]["unpriced"] += 1
            else:
                out[o.band]["value"] += o.amount
        for v in out.values():
            v["value"] = round(v["value"], 2)
        return out

    def oldest(self, n: int = 5) -> list[StaleOrder]:
        return sorted(self.orders, key=lambda o: -o.age_days)[:n]

    def as_dict(self) -> dict[str, Any]:
        return {
            "as_of": self.as_of.isoformat() if self.as_of else None,
            "open_count": len(self.orders),
            "open_value": round(self.total_value, 2),
            # Every value above is a FLOOR when these are non-zero, and every
            # renderer has to say so. Serialised beside the totals rather than
            # left to be recomputed, so a page cannot show one without the other.
            "open_unpriced": len(self.unpriced),
            "stale_count": len(self.stale),
            "stale_value": round(self.stale_value, 2),
            "stale_unpriced": len(self.stale_unpriced),
            "stale_after_days": STALE_AFTER_DAYS,
            "bands": self.by_band(),
            "orders": [o.as_dict() for o in
                       sorted(self.orders, key=lambda o: -o.age_days)],
        }


def open_orders(orders: Iterable[C.Order], as_of: _dt.date,
                profile: str | None = None) -> OpenOrderBook:
    """Every order still owing work, banded by how long it has been open.

    Rows with no order date are skipped rather than assumed recent: an undated
    row cannot be aged, and guessing would put real stale work in the safe
    band.
    """
    book = OpenOrderBook(as_of=as_of)
    want = C.normalise_profile(profile) if profile else None
    for o in orders:
        if want and C.normalise_profile(o.profile) != want:
            continue
        if (o.status or "") not in OPEN_STATUSES:
            continue
        if not o.order_date:
            continue
        age = (as_of - o.order_date).days
        if age < 0:
            continue
        book.orders.append(StaleOrder(
            client=o.client, age_days=age, band=band_for(age),
            status=o.status or "",
            # NOT `o.revenue()`: that folds a missing amount into 0.0.
            amount=None if o.amount is None else (o.amount + (o.tip or 0.0)),
            order_date=o.order_date,
            project=o.project, designer=o.logo_designer, csr=o.csr))
    return book


# --------------------------------------------------------------------------
# Unanswered quotes
# --------------------------------------------------------------------------

@dataclass
class UnansweredQuote:
    client: str
    quoted: float
    age_days: int
    followups: int
    country: str | None = None
    csr: str | None = None
    date: _dt.date | None = None
    note: str | None = None

    @property
    def untouched(self) -> bool:
        """Quoted a price and never followed up even once."""
        return self.followups == 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "client": self.client, "quoted": round(self.quoted, 2),
            "age_days": self.age_days, "followups": self.followups,
            "untouched": self.untouched, "country": self.country,
            "csr": self.csr, "note": self.note,
            "date": self.date.isoformat() if self.date else None,
        }


@dataclass
class QuoteBook:
    quotes: list[UnansweredQuote] = field(default_factory=list)
    as_of: _dt.date | None = None

    @property
    def total(self) -> float:
        return sum(q.quoted for q in self.quotes)

    @property
    def untouched(self) -> list[UnansweredQuote]:
        return [q for q in self.quotes if q.untouched]

    @property
    def untouched_value(self) -> float:
        return sum(q.quoted for q in self.untouched)

    def ranked(self) -> list[UnansweredQuote]:
        """Never-asked first, then by value.

        A quote with three follow-ups and no reply has been answered; the buyer
        said no by not speaking. A quote with none has not been asked, and is
        the only one where a message today is new information.
        """
        return sorted(self.quotes, key=lambda q: (q.followups, -q.quoted))

    def as_dict(self) -> dict[str, Any]:
        return {
            "as_of": self.as_of.isoformat() if self.as_of else None,
            "count": len(self.quotes),
            "total": round(self.total, 2),
            "untouched_count": len(self.untouched),
            "untouched_value": round(self.untouched_value, 2),
            "quotes": [q.as_dict() for q in self.ranked()],
        }


def unanswered_quotes(leads: Iterable[C.Lead], as_of: _dt.date,
                      profile: str | None = None) -> QuoteBook:
    """Leads that were quoted a price and never placed an order.

    No age cut-off. The team's read is that these buyers never replied rather
    than declined, so an old quote is not disqualified — it is just ranked
    below one nobody has asked yet.
    """
    book = QuoteBook(as_of=as_of)
    want = C.normalise_profile(profile) if profile else None
    for l in leads:
        if want and C.normalise_profile(l.profile) != want:
            continue
        if not l.quoted or l.quoted <= 0:
            continue
        if l.status == "placed":
            continue
        age = (as_of - l.date).days if l.date else -1
        book.quotes.append(UnansweredQuote(
            client=l.client, quoted=float(l.quoted), age_days=age,
            followups=sum(1 for f in (l.followup_1, l.followup_2, l.followup_3) if f),
            country=l.country, csr=l.csr, date=l.date, note=l.note))
    return book


# --------------------------------------------------------------------------
# Bundle
# --------------------------------------------------------------------------

@dataclass
class FollowupBenchmark:
    """What a logged follow-up is actually worth on a quoted lead.

    Read this carefully before using it, because the raw cut lies. Quoted leads
    with *no* logged follow-up convert at 90.6% — which does not mean chasing
    hurts. It means a follow-up only ever gets logged when the buyer did not
    say yes straight away, so the no-follow-up group is dominated by instant
    closes. Comparing the two groups directly measures nothing but that
    selection.

    The usable number is the conversion rate *within* the followed-up group:
    of the quoted leads that someone actually chased, this many placed. That is
    the closest observable estimate of what chasing a cold quote returns, and
    it is the rate the recovery task is costed on.
    """
    followed_n: int = 0
    followed_placed: int = 0
    never_n: int = 0
    never_placed: int = 0

    @property
    def followed_conv(self) -> float:
        return self.followed_placed / self.followed_n if self.followed_n else 0.0

    @property
    def has_signal(self) -> bool:
        """Below this the rate is noise and the caller should fall back."""
        return self.followed_n >= 10

    def as_dict(self) -> dict[str, Any]:
        return {
            "followed_n": self.followed_n,
            "followed_placed": self.followed_placed,
            "followed_conv": round(self.followed_conv, 4),
            "never_n": self.never_n,
            "never_placed": self.never_placed,
            "has_signal": self.has_signal,
        }


def followup_benchmark(leads: Iterable[C.Lead],
                       profile: str | None = None) -> FollowupBenchmark:
    """Conversion of quoted leads, split by whether anyone followed up."""
    b = FollowupBenchmark()
    want = C.normalise_profile(profile) if profile else None
    for l in leads:
        if want and C.normalise_profile(l.profile) != want:
            continue
        if not l.quoted or l.quoted <= 0:
            continue
        depth = sum(1 for f in (l.followup_1, l.followup_2, l.followup_3) if f)
        placed = l.status == "placed"
        if depth:
            b.followed_n += 1
            b.followed_placed += int(placed)
        else:
            b.never_n += 1
            b.never_placed += int(placed)
    return b


@dataclass
class RecoveryBundle:
    open_book: OpenOrderBook
    quote_book: QuoteBook
    benchmark: FollowupBenchmark = field(default_factory=FollowupBenchmark)

    @property
    def total_at_rest(self) -> float:
        """Money committed or quoted that is not moving."""
        return self.open_book.stale_value + self.quote_book.total

    def as_dict(self) -> dict[str, Any]:
        return {
            "open_orders": self.open_book.as_dict(),
            "quotes": self.quote_book.as_dict(),
            "followup_benchmark": self.benchmark.as_dict(),
            "total_at_rest": round(self.total_at_rest, 2),
        }


def compute(orders: Sequence[C.Order], leads: Sequence[C.Lead],
            as_of: _dt.date, profile: str | None = None) -> RecoveryBundle:
    return RecoveryBundle(
        open_book=open_orders(orders, as_of, profile),
        quote_book=unanswered_quotes(leads, as_of, profile),
        benchmark=followup_benchmark(leads, profile))
