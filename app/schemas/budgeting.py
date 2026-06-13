"""Pydantic schemas for the budgeting feature (Phase 1, Task 1B).

Three resources: pay_sources, sinking_funds, goals. Plus a response model
for the per-paycheck plan.
"""
from datetime import date as date_type, datetime
from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


Cadence = Literal["weekly", "biweekly", "semimonthly", "monthly"]
_PERIODS_BY_CADENCE: dict[str, int] = {
    "weekly": 52,
    "biweekly": 26,
    "semimonthly": 24,
    "monthly": 12,
}


# ---------------------------------------------------------------------------
# PaySource
# ---------------------------------------------------------------------------

class PaySourceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    cadence: Cadence
    periods_per_year: Optional[int] = Field(default=None, ge=1, le=366)
    net_per_check: Optional[Decimal] = None

    @model_validator(mode="after")
    def _periods_match_cadence(self):
        expected = _PERIODS_BY_CADENCE[self.cadence]
        if self.periods_per_year is None:
            self.periods_per_year = expected
        elif self.periods_per_year != expected:
            raise ValueError(
                f"periods_per_year {self.periods_per_year} does not match "
                f"cadence {self.cadence!r} (expected {expected})"
            )
        return self


class PaySourceUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    cadence: Optional[Cadence] = None
    periods_per_year: Optional[int] = None
    net_per_check: Optional[Decimal] = None

    @model_validator(mode="after")
    def _check_periods(self):
        if self.cadence is not None:
            expected = _PERIODS_BY_CADENCE[self.cadence]
            if self.periods_per_year is None:
                self.periods_per_year = expected
            elif self.periods_per_year != expected:
                raise ValueError(
                    f"periods_per_year {self.periods_per_year} does not match "
                    f"cadence {self.cadence!r} (expected {expected})"
                )
        return self


class PaySourceResponse(BaseModel):
    id: int
    name: str
    cadence: str
    periods_per_year: int
    net_per_check: Optional[Decimal]
    created_at: datetime
    updated_at: datetime
    model_config = {"from_attributes": True}

    @field_validator("cadence", mode="before")
    @classmethod
    def _cadence_to_str(cls, v):
        # Column is String(20) now, but kept for forward-compat if a caller
        # ever passes a PayCadence enum directly.
        return v.value if hasattr(v, "value") else v


# ---------------------------------------------------------------------------
# SinkingFund (accrual envelopes + reserve floors share this table)
# ---------------------------------------------------------------------------

BillPeriods = Literal[1, 2, 4, 12]
FundTypeStr = Literal["accrual", "reserve"]


def _validate_fund_type_invariants(*, fund_type, bill_periods_per_year,
                                   funding_source_id):
    """Discriminator invariant — also enforced at the DB level by the
    ck_sinking_funds_type_periods_consistent CHECK. We validate here too
    so the API rejects bad inputs with 422 + a useful message instead of
    a generic integrity-error 500."""
    if fund_type == "accrual":
        if bill_periods_per_year is None:
            raise ValueError(
                "accrual funds require bill_periods_per_year "
                "(1, 2, 4, or 12)"
            )
    elif fund_type == "reserve":
        if bill_periods_per_year is not None:
            raise ValueError(
                "reserve funds do not accrue on a cadence; "
                "bill_periods_per_year must be omitted (null)"
            )
        if funding_source_id is not None:
            raise ValueError(
                "reserve funds are filled from lump deposits, not a "
                "paycheck stream; funding_source_id must be omitted (null)"
            )


class SinkingFundCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    amount: Decimal = Field(gt=0)
    # Default 'accrual' preserves the existing 1B API surface: callers that
    # don't pass fund_type get the same behaviour as before.
    fund_type: FundTypeStr = "accrual"
    # NULL for reserve rows; required for accrual rows. The model-validator
    # below enforces the discriminator invariant.
    bill_periods_per_year: Optional[BillPeriods] = None
    next_due: Optional[date_type] = None
    current_balance: Decimal = Field(default=Decimal("0"), ge=0)
    linked_account_id: Optional[int] = None
    funding_source_id: Optional[int] = None
    currency: str = Field(default="USD", min_length=3, max_length=3)

    @model_validator(mode="after")
    def _check_fund_type_invariants(self):
        _validate_fund_type_invariants(
            fund_type=self.fund_type,
            bill_periods_per_year=self.bill_periods_per_year,
            funding_source_id=self.funding_source_id,
        )
        return self


class SinkingFundUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    amount: Optional[Decimal] = Field(default=None, gt=0)
    fund_type: Optional[FundTypeStr] = None
    bill_periods_per_year: Optional[BillPeriods] = None
    next_due: Optional[date_type] = None
    current_balance: Optional[Decimal] = Field(default=None, ge=0)
    linked_account_id: Optional[int] = None
    funding_source_id: Optional[int] = None
    currency: Optional[str] = Field(default=None, min_length=3, max_length=3)
    # NB: partial PATCH cannot enforce the cross-field invariant on its own
    # (e.g. "change fund_type to reserve" without touching the other fields
    # has to clear bill_periods_per_year and funding_source_id at the DB
    # level, which the route handler does). We only validate when the
    # caller sent enough fields to make a complete picture.

    @model_validator(mode="after")
    def _check_fund_type_invariants(self):
        if self.fund_type is not None:
            _validate_fund_type_invariants(
                fund_type=self.fund_type,
                bill_periods_per_year=self.bill_periods_per_year,
                funding_source_id=self.funding_source_id,
            )
        return self


class SinkingFundResponse(BaseModel):
    id: int
    name: str
    amount: Decimal
    fund_type: str
    bill_periods_per_year: Optional[int]
    next_due: Optional[date_type]
    current_balance: Decimal
    linked_account_id: Optional[int]
    funding_source_id: Optional[int]
    currency: str
    # Derived (computed by the route, not stored). Always 0 for reserves
    # since they don't accrue on a cadence.
    monthly_accrual: Decimal
    created_at: datetime
    updated_at: datetime
    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Goal
# ---------------------------------------------------------------------------

class GoalCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    target_amount: Decimal = Field(gt=0)
    target_date: date_type
    current_saved: Decimal = Field(default=Decimal("0"), ge=0)
    linked_account_id: Optional[int] = None
    funding_source_id: Optional[int] = None
    currency: str = Field(default="USD", min_length=3, max_length=3)


class GoalUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    target_amount: Optional[Decimal] = Field(default=None, gt=0)
    target_date: Optional[date_type] = None
    current_saved: Optional[Decimal] = Field(default=None, ge=0)
    linked_account_id: Optional[int] = None
    funding_source_id: Optional[int] = None
    currency: Optional[str] = Field(default=None, min_length=3, max_length=3)


class GoalResponse(BaseModel):
    id: int
    name: str
    target_amount: Decimal
    target_date: date_type
    current_saved: Decimal
    linked_account_id: Optional[int]
    funding_source_id: Optional[int]
    currency: str
    # Derived:
    monthly_required: Decimal
    months_until: int
    progress_pct: float           # 0..100 (or > 100 if overfunded)
    on_track: bool                # current_saved >= expected by today's date
    created_at: datetime
    updated_at: datetime
    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Per-Paycheck Plan (read-only aggregation)
# ---------------------------------------------------------------------------

class PerCheckLineResponse(BaseModel):
    kind: Literal["sinking_fund", "goal"]
    id: int
    name: str
    monthly: Decimal
    per_check: Decimal


class PerCheckPlanResponse(BaseModel):
    pay_source_id: int
    pay_source_name: str
    cadence: str
    periods_per_year: int
    monthly_total: Decimal
    per_check_total: Decimal
    items: list[PerCheckLineResponse]


# ---------------------------------------------------------------------------
# Safe-to-Spend (Reserve Floor follow-up)
# ---------------------------------------------------------------------------

class SafeToSpendResponse(BaseModel):
    """Dashboard headline + breakdown the widget can expand inline.

    `spendable_source` tells the UI which set was used:
      - 'explicit'  → at least one account is flagged is_spendable
      - 'fallback'  → no flags set; using sinking_funds.linked_account_id union
      - 'none'      → no spendable accounts could be resolved at all
                      (balance, allocations, and headline will all be 0)
    """
    spendable_balance: Decimal
    accrual_allocated: Decimal
    goals_allocated: Decimal
    reserve_target: Decimal
    safe_to_spend: Decimal
    spendable_account_ids: list[int]
    spendable_source: Literal["explicit", "fallback", "none"]
