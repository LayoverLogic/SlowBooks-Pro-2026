"""Reserve Floor + Safe-to-Spend: sinking_funds.fund_type + accounts.is_spendable

Revision ID: t2k3l4m5n6o7
Revises: s1j2k3l4m5n6
Create Date: 2026-06-13 20:30:00.000000

Two schema additions in support of the Reserve Floor + Safe-to-Spend
follow-up to 1B:

  1. sinking_funds.fund_type — String(20), CHECK ('accrual', 'reserve'),
     default 'accrual'. Existing rows default to 'accrual' (no behaviour
     change). 'reserve' rows hold a target floor (no accrual cadence, no
     funding source, excluded from the per-paycheck plan, subtracted at
     TARGET from Safe-to-Spend).

  2. sinking_funds.bill_periods_per_year — relaxed to nullable. Reserve
     rows have no accrual cadence so the field is NULL on them. The old
     CHECK is replaced with one that allows NULL or one of the four
     valid cadence values. A second CHECK enforces the discriminator
     invariant: accrual rows must have bill_periods_per_year set,
     reserve rows must not.

  3. accounts.is_spendable — Boolean, NOT NULL, default false. Marks
     which accounts the Safe-to-Spend calc sums over. Default false so
     existing accounts opt in deliberately rather than sweep savings /
     retirement into the spendable set.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 't2k3l4m5n6o7'
down_revision: Union[str, None] = 's1j2k3l4m5n6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ---- sinking_funds.fund_type -----------------------------------------
    op.add_column(
        'sinking_funds',
        sa.Column(
            'fund_type', sa.String(20),
            nullable=False, server_default='accrual',
        ),
    )
    op.create_check_constraint(
        'ck_sinking_funds_fund_type_values', 'sinking_funds',
        "fund_type IN ('accrual', 'reserve')",
    )

    # ---- bill_periods_per_year: drop NOT NULL + widen CHECK to allow NULL
    op.drop_constraint(
        'ck_sinking_funds_bill_periods_values',
        'sinking_funds', type_='check',
    )
    op.alter_column(
        'sinking_funds', 'bill_periods_per_year',
        existing_type=sa.Integer(), nullable=True,
    )
    op.create_check_constraint(
        'ck_sinking_funds_bill_periods_values', 'sinking_funds',
        "bill_periods_per_year IS NULL "
        "OR bill_periods_per_year IN (1, 2, 4, 12)",
    )

    # Discriminator invariant: accrual <-> bill_periods_per_year IS NOT NULL;
    # reserve <-> bill_periods_per_year IS NULL. Pydantic enforces this too,
    # but a CHECK is the safety net for direct DB writes / seeds.
    op.create_check_constraint(
        'ck_sinking_funds_type_periods_consistent', 'sinking_funds',
        "(fund_type = 'accrual' AND bill_periods_per_year IS NOT NULL) "
        "OR (fund_type = 'reserve' AND bill_periods_per_year IS NULL)",
    )

    # ---- accounts.is_spendable ------------------------------------------
    op.add_column(
        'accounts',
        sa.Column(
            'is_spendable', sa.Boolean(),
            nullable=False, server_default=sa.text('false'),
        ),
    )


def downgrade() -> None:
    op.drop_column('accounts', 'is_spendable')

    op.drop_constraint(
        'ck_sinking_funds_type_periods_consistent',
        'sinking_funds', type_='check',
    )
    op.drop_constraint(
        'ck_sinking_funds_bill_periods_values',
        'sinking_funds', type_='check',
    )
    op.alter_column(
        'sinking_funds', 'bill_periods_per_year',
        existing_type=sa.Integer(), nullable=False,
    )
    op.create_check_constraint(
        'ck_sinking_funds_bill_periods_values', 'sinking_funds',
        "bill_periods_per_year IN (1, 2, 4, 12)",
    )

    op.drop_constraint(
        'ck_sinking_funds_fund_type_values',
        'sinking_funds', type_='check',
    )
    op.drop_column('sinking_funds', 'fund_type')
