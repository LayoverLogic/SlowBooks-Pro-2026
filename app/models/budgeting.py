# ============================================================================
# Budgeting — Goals + Sinking Funds + Pay Sources (Phase 1, Task 1B)
#
# Design principle (LOCKED): the household has two pay cadences, so a stored
# "per-paycheck" number is ambiguous. The canonical stored unit is the MONTHLY
# contribution. We store the natural inputs (bill amount + frequency, or
# target + date) and DERIVE monthly and per-paycheck figures in
# app/services/budget_calc.py. We never persist a per-paycheck amount.
#
# Architecture (LOCKED): virtual envelopes against ONE holding account
# (Monarch/YNAB model), not separate bank accounts. Funds/goals carry a
# virtual balance; linked_account_id points at the real holding savings
# account so the UI can show allocated-vs-unallocated against the real
# balance.
# ============================================================================

import enum

from sqlalchemy import (
    Column, Integer, String, Date, Numeric, DateTime, ForeignKey,
    CheckConstraint, func,
)
from sqlalchemy.orm import relationship

from app.database import Base


class PayCadence(str, enum.Enum):
    WEEKLY = "weekly"          # 52 / yr
    BIWEEKLY = "biweekly"      # 26 / yr
    SEMIMONTHLY = "semimonthly"  # 24 / yr
    MONTHLY = "monthly"        # 12 / yr


class PaySource(Base):
    """An earner / income stream with a fixed pay cadence.

    `periods_per_year` is stored explicitly (rather than derived from
    `cadence`) so the per-paycheck math is a single multiply and never has
    to branch on the enum. The two must agree; the API validates that.

    `net_per_check` is the take-home per paycheck. Nullable — the household
    enters it later; the per-paycheck PLAN math does not need it (it converts
    a monthly set-aside into a per-check figure via periods_per_year).
    """
    __tablename__ = "pay_sources"
    __table_args__ = (
        CheckConstraint(
            "cadence IN ('weekly', 'biweekly', 'semimonthly', 'monthly')",
            name="ck_pay_sources_cadence_values",
        ),
        CheckConstraint(
            "periods_per_year IN (52, 26, 24, 12)",
            name="ck_pay_sources_periods_values",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(120), nullable=False)
    # Cadence is stored as the lowercase string value (matches the CHECK
    # constraint + the API's `Literal` type). Using `String` instead of
    # `Enum(PayCadence)` avoids SQLAlchemy's default behaviour of writing
    # the enum NAME ('BIWEEKLY'), which would violate the CHECK that
    # accepts 'biweekly'. The `PayCadence` Python enum above is kept as
    # a typing constant for callers that prefer symbolic refs.
    cadence = Column(String(20), nullable=False)
    periods_per_year = Column(Integer, nullable=False)
    net_per_check = Column(Numeric(12, 2), nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(),
                        onupdate=func.now(), nullable=False)


class FundType(str, enum.Enum):
    """Discriminator on `sinking_funds` (Reserve Floor + Safe-to-Spend
    follow-up). Stored as the lowercase string value (matches the CHECK
    constraint + the API's `Literal` type), same convention as PayCadence."""
    ACCRUAL = "accrual"   # accrues toward `next_due` via bill_periods_per_year
    RESERVE = "reserve"   # holds a target floor; no due date, no accrual cadence


class SinkingFund(Base):
    """A pre-funded bill envelope OR a maintained cash floor (reserve).

    `fund_type='accrual'` (default — existing rows): accrues toward a
    recurring bill. `amount` is the per-occurrence bill; combined with
    `bill_periods_per_year` (1=annual, 2=semiannual, 4=quarterly, 12=monthly)
    the calc layer derives the monthly accrual:
        monthly_accrual = amount * bill_periods_per_year / 12
    Funded from a `funding_source_id` (pay source); contributes to that
    earner's per-paycheck plan.

    `fund_type='reserve'`: a maintained cash floor (e.g. a $3,000 cushion).
    `amount` is the TARGET floor; `bill_periods_per_year`, `next_due`, and
    `funding_source_id` are all NULL/ignored (filled from lump deposits
    when money lands, not from a paycheck stream). EXCLUDED from the
    per-paycheck plan. Subtracted from Safe-to-Spend at the TARGET, not at
    `current_balance` — so an unfunded cushion behaves honestly (pulls the
    Safe-to-Spend headline down by the full target until it's filled).

    `current_balance` is the VIRTUAL envelope balance in both cases —
    money notionally set aside, held inside the real `linked_account_id`
    account along with other envelopes.
    """
    __tablename__ = "sinking_funds"
    __table_args__ = (
        # bill_periods_per_year is NULL for reserves and one of the four
        # valid cadence values for accrual rows. Existing rows pre-fund-type
        # all have a non-NULL value, so dropping the NOT NULL is safe.
        CheckConstraint(
            "bill_periods_per_year IS NULL "
            "OR bill_periods_per_year IN (1, 2, 4, 12)",
            name="ck_sinking_funds_bill_periods_values",
        ),
        CheckConstraint(
            "fund_type IN ('accrual', 'reserve')",
            name="ck_sinking_funds_fund_type_values",
        ),
        # An accrual fund must have bill_periods_per_year; a reserve fund
        # must NOT. This is the discriminator's hard invariant — Pydantic
        # also enforces it but the CHECK is the safety net for direct DB
        # writes or seeds.
        CheckConstraint(
            "(fund_type = 'accrual' AND bill_periods_per_year IS NOT NULL) "
            "OR (fund_type = 'reserve' AND bill_periods_per_year IS NULL)",
            name="ck_sinking_funds_type_periods_consistent",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(120), nullable=False)
    amount = Column(Numeric(12, 2), nullable=False)
    # Reserve rows: NULL. Accrual rows: one of (1, 2, 4, 12).
    bill_periods_per_year = Column(Integer, nullable=True)
    next_due = Column(Date, nullable=True)
    current_balance = Column(Numeric(12, 2), nullable=False, default=0, server_default="0")
    linked_account_id = Column(
        Integer, ForeignKey("accounts.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    funding_source_id = Column(
        Integer, ForeignKey("pay_sources.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    currency = Column(String(3), nullable=False, default="USD", server_default="USD")
    # Discriminator: 'accrual' (default — existing behaviour) or 'reserve'
    # (maintained floor; see class docstring). Stored as lowercase String
    # matching the CHECK + the API Literal, same convention as cadence.
    fund_type = Column(
        String(20), nullable=False, default="accrual", server_default="accrual",
    )

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(),
                        onupdate=func.now(), nullable=False)

    linked_account = relationship("Account", foreign_keys=[linked_account_id])
    funding_source = relationship("PaySource", foreign_keys=[funding_source_id])


class Goal(Base):
    """A savings target with a date (e.g. a Japan trip).

    The calc layer derives the monthly contribution required to hit
    `target_amount` by `target_date` from where we are now:
        monthly_required = max(0, (target_amount - current_saved)
                                   / months_until(target_date))    # months >= 1

    `current_saved` is the VIRTUAL envelope balance, same model as
    SinkingFund.current_balance.
    """
    __tablename__ = "goals"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(120), nullable=False)
    target_amount = Column(Numeric(12, 2), nullable=False)
    target_date = Column(Date, nullable=False)
    current_saved = Column(Numeric(12, 2), nullable=False, default=0, server_default="0")
    linked_account_id = Column(
        Integer, ForeignKey("accounts.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    funding_source_id = Column(
        Integer, ForeignKey("pay_sources.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    currency = Column(String(3), nullable=False, default="USD", server_default="USD")

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(),
                        onupdate=func.now(), nullable=False)

    linked_account = relationship("Account", foreign_keys=[linked_account_id])
    funding_source = relationship("PaySource", foreign_keys=[funding_source_id])
