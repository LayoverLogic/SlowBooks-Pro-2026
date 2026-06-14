# ============================================================================
# Multi-Company Service — create/switch company databases
# Feature 16: Most invasive change — routes to correct database
# ============================================================================

import logging
import re
import subprocess
from datetime import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.config import DATABASE_URL
from app.models.companies import Company

logger = logging.getLogger(__name__)

# Strict pattern for database names: alphanumeric, underscores, hyphens only.
# Must start with a letter; max 63 chars (PostgreSQL identifier limit).
_VALID_DB_NAME = re.compile(r'^[a-zA-Z][a-zA-Z0-9_-]{0,62}$')


def _base_url():
        """Get the base URL without database name."""
        # postgresql://user:pass@host:port/dbname → postgresql://user:pass@host:port/
        parts = DATABASE_URL.rsplit("/", 1)
        return parts[0] + "/"


def list_companies(db: Session) -> list[dict]:
        companies = db.query(Company).filter(Company.is_active == True).order_by(Company.name).all()
        return [
            {"id": c.id, "name": c.name, "database_name": c.database_name,
             "description": c.description, "last_accessed": c.last_accessed.isoformat() if c.last_accessed else None}
            for c in companies
        ]


def create_company(db: Session, name: str, database_name: str, description: str = None) -> dict:
        """Create a new company database."""
        # Validate database_name with a strict allowlist pattern before it touches
        # any SQL.  This is the primary injection defence; the dialect quoting below
        # is defence-in-depth for the CREATE DATABASE DDL statement specifically.
        if not _VALID_DB_NAME.match(database_name):
                    return {"success": False, "error": "Invalid database name. Use only letters, numbers, underscores, and hyphens."}

        # Check if company already exists
        existing = db.query(Company).filter(Company.database_name == database_name).first()
        if existing:
                    return {"success": False, "error": f"Database '{database_name}' already exists"}

        # Create the database
        base_url = _base_url()
        try:
                    # Connect to postgres system database to create new DB.
                    # Use exec_driver_sql with the dialect's identifier_preparer so the
                    # database name is quoted via PostgreSQL's own quoting rules rather
                    # than an f-string literal — defence-in-depth against SQL injection
                    # even after the regex guard above (CodeQL CWE-089 fix).
                    system_engine = create_engine(base_url + "postgres", isolation_level="AUTOCOMMIT")
                    with system_engine.connect() as conn:
                                    quoted_db_name = conn.dialect.identifier_preparer.quote(database_name)
                                    conn.exec_driver_sql(f"CREATE DATABASE {quoted_db_name}")
                                system_engine.dispose()

            # Run Alembic migrations on new database
                    new_engine = create_engine(base_url + database_name)
                    from app.database import Base
                    Base.metadata.create_all(new_engine)
                    new_engine.dispose()

            # Register in master DB
                    company = Company(name=name, database_name=database_name, description=description)
                    db.add(company)
                    db.commit()

            return {"success": True, "company_id": company.id, "database_name": database_name}

except Exception:
        logger.exception("Failed to create company database %s", database_name)
        return {"success": False, "error": "Failed to create company database. Check server logs for details."}


def get_company_db_url(database_name: str) -> str:
        """Get the full database URL for a company."""
    return _base_url() + database_name
