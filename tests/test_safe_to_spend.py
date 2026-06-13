"""HTTP-level tests for the Safe-to-Spend endpoint + reserve fund type.

The acceptance fixtures in the work order are pinned in tests/test_budget_calc.py
against the pure calc layer; this file exercises the full POST→GET round
trip through the API, including:
  - Reserve creation rejects the cadence/funding fields per the discriminator
  - Reserves are excluded from /api/budget/per-paycheck-plan
  - /api/budget/safe-to-spend honours the is_spendable flag (explicit set)
  - /api/budget/safe-to-spend falls back to linked_account_id when no flag set
  - /api/budget/safe-to-spend returns 0 with source='none' on an empty DB
"""
from datetime import date
from decimal import Decimal


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _create_account(client, name, *, is_spendable=False, kind="bank",
                    currency="USD"):
    """Create a balance_only account, optionally flagged spendable."""
    r = client.post("/api/accounts", json={
        "name": name,
        "account_type": "asset",
        "account_kind": kind,
        "update_strategy": "balance_only",
        "currency": currency,
        "is_spendable": is_spendable,
    })
    assert r.status_code == 201, r.text
    return r.json()


def _snapshot(client, account_id, balance, as_of="2026-05-04"):
    r = client.post("/api/balances", json={
        "account_id": account_id,
        "as_of_date": as_of,
        "balance": str(balance),
    })
    assert r.status_code == 201, r.text


# ---------------------------------------------------------------------------
# Reserve fund type — schema + discriminator
# ---------------------------------------------------------------------------

def test_create_reserve_fund_omits_bill_periods_and_funding_source(client):
    """A reserve fund is a maintained floor — no cadence, no funding stream.
    The API should accept it without bill_periods_per_year and report
    monthly_accrual=0."""
    r = client.post("/api/sinking-funds", json={
        "name": "Cushion",
        "amount": "3000.00",
        "fund_type": "reserve",
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["fund_type"] == "reserve"
    assert body["bill_periods_per_year"] is None
    assert body["funding_source_id"] is None
    assert Decimal(body["monthly_accrual"]) == Decimal("0.00")


def test_create_reserve_rejects_bill_periods_per_year(client):
    """Per the discriminator invariant: reserve + bill_periods → 422."""
    r = client.post("/api/sinking-funds", json={
        "name": "Bad Reserve",
        "amount": "3000.00",
        "fund_type": "reserve",
        "bill_periods_per_year": 12,
    })
    assert r.status_code == 422
    assert "reserve funds do not accrue on a cadence" in r.text


def test_create_reserve_rejects_funding_source_id(client):
    """A reserve is filled from lump deposits, not a paycheck stream."""
    src_id = client.post("/api/pay-sources",
                         json={"name": "Alex", "cadence": "biweekly"}).json()["id"]
    r = client.post("/api/sinking-funds", json={
        "name": "Bad Reserve",
        "amount": "3000.00",
        "fund_type": "reserve",
        "funding_source_id": src_id,
    })
    assert r.status_code == 422
    assert "filled from lump deposits" in r.text


def test_create_accrual_still_requires_bill_periods_per_year(client):
    """Default fund_type='accrual' (preserves 1B surface) still needs
    bill_periods_per_year — accrual without a cadence is meaningless."""
    r = client.post("/api/sinking-funds", json={
        "name": "Bad Accrual", "amount": "100.00",
    })
    assert r.status_code == 422
    assert "accrual funds require bill_periods_per_year" in r.text


def test_patch_fund_type_to_reserve_clears_bill_periods_and_funding(client):
    """Switching an accrual fund to reserve via PATCH should auto-clear
    bill_periods_per_year and funding_source_id so the DB CHECK doesn't
    fire on commit. Lets the UI flip the discriminator with a single
    PATCH instead of a 3-field PATCH."""
    src_id = client.post("/api/pay-sources",
                         json={"name": "Alex", "cadence": "biweekly"}).json()["id"]
    fund_id = client.post("/api/sinking-funds", json={
        "name": "Phone", "amount": "49.99",
        "bill_periods_per_year": 12, "funding_source_id": src_id,
    }).json()["id"]

    r = client.patch(f"/api/sinking-funds/{fund_id}",
                     json={"fund_type": "reserve", "amount": "3000.00"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["fund_type"] == "reserve"
    assert body["bill_periods_per_year"] is None
    assert body["funding_source_id"] is None


def test_patch_fund_type_to_accrual_requires_bill_periods(client):
    """Reverse direction: reserve → accrual must end up with a
    bill_periods_per_year, either from the PATCH body or the existing row.
    If the row has neither, reject with 422 rather than letting the DB
    CHECK surface as a generic 500."""
    fund_id = client.post("/api/sinking-funds", json={
        "name": "Cushion", "amount": "3000.00", "fund_type": "reserve",
    }).json()["id"]

    r = client.patch(f"/api/sinking-funds/{fund_id}", json={"fund_type": "accrual"})
    assert r.status_code == 422
    assert "accrual funds require bill_periods_per_year" in r.text

    # Supplying it on the same PATCH succeeds.
    r = client.patch(f"/api/sinking-funds/{fund_id}", json={
        "fund_type": "accrual", "bill_periods_per_year": 12,
    })
    assert r.status_code == 200, r.text
    assert r.json()["bill_periods_per_year"] == 12


# ---------------------------------------------------------------------------
# Per-paycheck plan excludes reserves
# ---------------------------------------------------------------------------

def test_reserves_are_excluded_from_per_paycheck_plan(client):
    """A reserve carries no funding_source_id by construction so it's
    already invisible to the plan; this test pins the contract end-to-end
    so a future refactor that changes the filter has to update this assertion."""
    src_id = client.post("/api/pay-sources",
                         json={"name": "Alex", "cadence": "biweekly"}).json()["id"]
    client.post("/api/sinking-funds", json={
        "name": "Phone", "amount": "49.99",
        "bill_periods_per_year": 12, "funding_source_id": src_id,
    })
    client.post("/api/sinking-funds", json={
        "name": "Cushion", "amount": "3000.00", "fund_type": "reserve",
    })
    plans = client.get("/api/budget/per-paycheck-plan").json()
    alex = next(p for p in plans if p["pay_source_name"] == "Alex")
    names = {it["name"] for it in alex["items"]}
    assert "Phone" in names
    assert "Cushion" not in names


# ---------------------------------------------------------------------------
# /api/budget/safe-to-spend
# ---------------------------------------------------------------------------

def test_safe_to_spend_explicit_flag_acceptance_fixture_1(client):
    """End-to-end check of work-order fixture #1: a $4,000 spendable
    checking with a $500 accrual envelope, a $200 goal, and a $3,000
    reserve TARGET → safe-to-spend 300."""
    chk = _create_account(client, "Heartland Joint Checking", is_spendable=True)
    _snapshot(client, chk["id"], "4000.00")

    # Accrual envelope with $500 banked.
    fund_id = client.post("/api/sinking-funds", json={
        "name": "Phone", "amount": "49.99",
        "bill_periods_per_year": 12,
        "linked_account_id": chk["id"],
    }).json()["id"]
    client.patch(f"/api/sinking-funds/{fund_id}",
                 json={"current_balance": "500.00"})

    # Goal with $200 saved.
    client.post("/api/goals", json={
        "name": "Japan", "target_amount": "13500",
        "target_date": "2027-06-01",
        "current_saved": "200",
        "linked_account_id": chk["id"],
    })

    # Reserve TARGET $3,000 (unfunded — current_balance=0).
    client.post("/api/sinking-funds", json={
        "name": "Cushion", "amount": "3000.00", "fund_type": "reserve",
        "linked_account_id": chk["id"],
    })

    body = client.get("/api/budget/safe-to-spend").json()
    assert Decimal(body["spendable_balance"]) == Decimal("4000.00")
    assert Decimal(body["accrual_allocated"]) == Decimal("500.00")
    assert Decimal(body["goals_allocated"]) == Decimal("200.00")
    assert Decimal(body["reserve_target"]) == Decimal("3000.00")
    assert Decimal(body["safe_to_spend"]) == Decimal("300.00")
    assert body["spendable_source"] == "explicit"


def test_safe_to_spend_unfunded_reserve_goes_negative(client):
    """Work order fixture #2: spendable $2,000, reserve TARGET $3,000
    → safe -1000 ('Below cushion by $1,000')."""
    chk = _create_account(client, "Checking", is_spendable=True)
    _snapshot(client, chk["id"], "2000.00")

    client.post("/api/sinking-funds", json={
        "name": "Cushion", "amount": "3000.00", "fund_type": "reserve",
        "linked_account_id": chk["id"],
    })

    body = client.get("/api/budget/safe-to-spend").json()
    assert Decimal(body["safe_to_spend"]) == Decimal("-1000.00")
    assert Decimal(body["reserve_target"]) == Decimal("3000.00")


def test_safe_to_spend_funded_reserve_still_subtracts_target(client):
    """Work order fixture #3: even when the reserve is at target, the
    cushion is locked. Spendable $6,000, reserve target $3,000
    (current_balance $3,000 too) → safe $3,000 (non-cushion portion)."""
    chk = _create_account(client, "Checking", is_spendable=True)
    _snapshot(client, chk["id"], "6000.00")

    fund_id = client.post("/api/sinking-funds", json={
        "name": "Cushion", "amount": "3000.00", "fund_type": "reserve",
        "linked_account_id": chk["id"],
    }).json()["id"]
    # Fully fund it.
    client.patch(f"/api/sinking-funds/{fund_id}",
                 json={"current_balance": "3000.00"})

    body = client.get("/api/budget/safe-to-spend").json()
    assert Decimal(body["safe_to_spend"]) == Decimal("3000.00")
    assert Decimal(body["reserve_target"]) == Decimal("3000.00")


def test_safe_to_spend_falls_back_to_linked_account_when_no_flag_set(client):
    """If NO account is flagged spendable, the endpoint should fall back
    to the union of sinking_funds.linked_account_id — the household's
    natural bills account by construction. Savings/retirement should NOT
    be swept in."""
    chk = _create_account(client, "Checking", is_spendable=False)
    sav = _create_account(client, "Vanguard Brokerage", is_spendable=False,
                          kind="brokerage")
    _snapshot(client, chk["id"], "1000.00")
    _snapshot(client, sav["id"], "50000.00")

    # An envelope linked to checking bootstraps the spendable set.
    client.post("/api/sinking-funds", json={
        "name": "Phone", "amount": "49.99", "bill_periods_per_year": 12,
        "linked_account_id": chk["id"],
    })

    body = client.get("/api/budget/safe-to-spend").json()
    assert body["spendable_source"] == "fallback"
    assert body["spendable_account_ids"] == [chk["id"]]
    assert Decimal(body["spendable_balance"]) == Decimal("1000.00")  # not 51000
    # The envelope has no current_balance yet (default 0) so it doesn't
    # subtract — the headline matches the spendable balance.
    assert Decimal(body["safe_to_spend"]) == Decimal("1000.00")


def test_safe_to_spend_empty_db_returns_zero_with_source_none(client):
    """No accounts, no funds, no snapshots → safe = 0, source = 'none'.
    Lets the dashboard render an onboarding empty state instead of
    error-banner noise on a fresh install."""
    body = client.get("/api/budget/safe-to-spend").json()
    assert body["spendable_source"] == "none"
    assert body["spendable_account_ids"] == []
    assert Decimal(body["safe_to_spend"]) == Decimal("0.00")
    assert Decimal(body["spendable_balance"]) == Decimal("0.00")
