/**
 * Budget Dashboard — a dedicated, Monarch-style view of the household's
 * budgeting picture (Reserve Floor / Safe-to-Spend follow-up).
 *
 * This is ADDITIVE. It does not touch budgeting.js, the legacy dashboard,
 * or the Goals / Sinking-Funds pages — it just reads the same live
 * endpoints they do and re-presents them as a clean, airy dashboard:
 *
 *   /#/budget  → BudgetDashboardPage.render()
 *
 * Wired in app.js (route map) and index.html (nav item + <script> include).
 *
 * Self-mounts a skeleton into #page-content on first paint, fetches all
 * sources in parallel, and returns the final HTML for the router to mount.
 * The route is registered `cabin: true`, so the router does NOT wrap this
 * output in .sb-page-pad — the page owns its own gutter via .bd-root.
 *
 * --- Honest-flag logic (the reason this page exists) -----------------------
 * The raw API fields are technically correct but misleading at a glance, so
 * three numbers are recomputed rather than echoed:
 *   1. Safe-to-Spend < 0 driven by an unfunded reserve floor is EXPECTED,
 *      not "broke" — framed as cushion coverage (balance / target).
 *   2. A goal's `on_track` only compares saved-vs-expected-by-today, so a
 *      $0 goal reads true even when the funding source can't hit the target.
 *      We compare monthly_required against the source's real net income and
 *      project the end balance at that fundable rate.
 *   3. An earner whose per-check set-asides exceed take-home is flagged
 *      (the same goal gap, seen from the paycheck side).
 *
 * No new color system is forced on the rest of the app: the Monarch palette
 * lives entirely inside .bd-root as scoped --bd-* custom properties, with a
 * dark-mode override block. Primary is a calm teal-green; amber = caution;
 * red = genuine negative. No purple (brand constraint).
 */

const BudgetDashboardPage = {

    // ----------------------------------------------------------------------
    // Numeric + formatting helpers. Every money field on these endpoints is
    // a STRING ("2025.60"), so coerce before any arithmetic.
    // ----------------------------------------------------------------------
    _n(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; },
    _money(v, ccy) { return formatCurrency(this._n(v), ccy || 'USD'); },
    _pct0(n) { return `${Math.round(n)}%`; },
    _pct1(n) {
        const r = Math.round(n * 10) / 10;
        return `${Number.isInteger(r) ? r : r.toFixed(1)}%`;
    },

    /** Thin-stroke SVG progress ring. Optional faint "ghost" arc behind the
     *  value arc is used to show a projection (e.g. where a goal lands at its
     *  realistic funding rate) against the solid arc (saved today). */
    _ring(o) {
        const size = o.size || 132, stroke = o.stroke || 10;
        const r = (size - stroke) / 2, c = 2 * Math.PI * r, cx = size / 2, cy = size / 2;
        const len = p => c * Math.max(0, Math.min(100, p || 0)) / 100;
        const arc = (p, color, opacity) => ((p || 0) <= 0.1) ? '' :
            `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}"
                 stroke-width="${stroke}" stroke-linecap="round"
                 stroke-dasharray="${len(p)} ${c}" transform="rotate(-90 ${cx} ${cy})"
                 opacity="${opacity}"/>`;
        return `<svg class="bd-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
            <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--bd-rule)" stroke-width="${stroke}"/>
            ${o.ghostPct != null ? arc(o.ghostPct, o.ghostColor || 'var(--bd-amber)', '0.32') : ''}
            ${arc(o.pct, o.color || 'var(--bd-accent)', '1')}
            <text x="${cx}" y="${cy - 3}" text-anchor="middle" dominant-baseline="middle" class="bd-ring-num">${o.center}</text>
            ${o.sub ? `<text x="${cx}" y="${cy + 17}" text-anchor="middle" class="bd-ring-sub">${o.sub}</text>` : ''}
        </svg>`;
    },

    /** Horizontal envelope bar (rounded track + fill). */
    _bar(pct, color) {
        const cl = Math.max(0, Math.min(100, pct || 0));
        return `<div class="bd-track"><div class="bd-fill" style="width:${cl}%;background:${color || 'var(--bd-accent)'};"></div></div>`;
    },

    // ======================================================================
    // Entry point
    // ======================================================================
    async render() {
        this._injectStyle();

        // Paint a skeleton straight into the content host so the user sees
        // the dashboard scaffold while the six fetches resolve. The router
        // will overwrite this with our returned HTML once render() resolves.
        const host = document.getElementById('page-content');
        if (host) host.innerHTML = this._skeleton();

        // All six sources in parallel; each degrades to null independently so
        // one dead endpoint can't blank the whole page.
        const [sts, goals, funds, plan, paySources, netWorth] = await Promise.all([
            API.get('/budget/safe-to-spend').catch(() => null),
            API.get('/goals').catch(() => null),
            API.get('/sinking-funds').catch(() => null),
            API.get('/budget/per-paycheck-plan').catch(() => null),
            API.get('/pay-sources').catch(() => null),
            API.get('/net-worth').catch(() => null),
        ]);

        const asOf = netWorth && netWorth.as_of ? ` · as of ${formatDate(netWorth.as_of)}` : '';

        return `
        <div class="bd-root">
            <header class="bd-page-head">
                <div>
                    <div class="bd-eyebrow">Household budget</div>
                    <h1 class="bd-title">Budget</h1>
                </div>
                <div class="bd-page-meta">Slowbooks Pro 2026${asOf}</div>
            </header>

            ${this._heroSafeToSpend(sts)}
            ${this._goalsSection(goals, plan, paySources)}
            ${this._envelopesSection(funds)}
            ${this._perPaycheckSection(plan, paySources)}
            ${this._netWorthSection(netWorth, sts)}
        </div>`;
    },

    // ======================================================================
    // 1 — Safe-to-Spend hero
    // ======================================================================
    _heroSafeToSpend(sts) {
        if (!sts) {
            return this._heroShell('Safe to spend', `
                <div class="bd-empty">Safe-to-Spend is unavailable right now.</div>`);
        }
        // No spendable set resolved — nudge rather than show a meaningless $0.
        if (sts.spendable_source === 'none') {
            return this._heroShell('Safe to spend', `
                <div class="bd-empty">
                    No spendable account is configured yet. Open an account in
                    <a href="#/accounts">Chart of Accounts</a> and flag it
                    <em>spendable</em>, or link an envelope to your checking
                    account, to bootstrap Safe-to-Spend.
                </div>`);
        }

        const spendable = this._n(sts.spendable_balance);
        const accrual   = this._n(sts.accrual_allocated);
        const goals     = this._n(sts.goals_allocated);
        const reserve   = this._n(sts.reserve_target);
        const safe      = this._n(sts.safe_to_spend);

        const negative   = safe < 0;
        // The cushion is the driver when the floor exists and the spendable
        // balance doesn't yet cover it. This is honest-flag #1: expected
        // behaviour while the cushion fills — not "broke".
        const cushionDriven = negative && reserve > 0 && spendable < reserve;
        const belowFloor    = reserve - spendable;        // how far under the floor
        const coverage      = reserve > 0 ? (spendable / reserve) * 100 : 0;

        const sourceTag = sts.spendable_source === 'fallback'
            ? `<span class="bd-tag bd-tag-muted" title="No accounts flagged spendable — auto-detected from linked envelopes">auto-detected</span>`
            : '';

        // Headline. Never a bare negative: when the cushion is the driver we
        // colour it amber (caution, not alarm) and wrap it in the coverage
        // story right below.
        const headColor = negative ? (cushionDriven ? 'var(--bd-amber)' : 'var(--bd-red)') : 'var(--bd-green)';
        const headNum = `<div class="bd-hero-num" style="color:${headColor}">${this._money(safe)}</div>`;
        const headLabel = negative
            ? (cushionDriven ? 'while you build your cushion' : 'over your committed budget')
            : 'free to spend after every commitment';

        // Cushion coverage block (only when the cushion is the reason).
        const cushionBlock = cushionDriven ? `
            <div class="bd-cushion">
                <div class="bd-cushion-top">
                    <span class="bd-cushion-label">Cushion ${this._pct1(coverage)} funded</span>
                    <span class="bd-cushion-figs">${this._money(spendable)} <span class="bd-muted">/ ${this._money(reserve)}</span></span>
                </div>
                ${this._bar(coverage, 'var(--bd-amber)')}
                <div class="bd-cushion-note">
                    Checking is <strong>${this._money(belowFloor)}</strong> below your
                    ${this._money(reserve)} cushion floor. Safe-to-Spend reads
                    negative until the floor is funded — that's expected, not overspending.
                </div>
            </div>` : '';

        // Allocation breakdown — spendable, minus each commitment, equals safe.
        const brkRow = (label, val, sign) => `
            <div class="bd-brk-row">
                <span class="bd-brk-label">${label}</span>
                <span class="bd-num ${sign === '−' && this._n(val) > 0 ? 'bd-neg' : ''}">${sign === '−' && this._n(val) > 0 ? '−' : ''}${this._money(val)}</span>
            </div>`;
        const breakdown = `
            <div class="bd-brk">
                ${brkRow('Spendable balance', spendable, '+')}
                ${brkRow('Envelopes set aside', accrual, '−')}
                ${brkRow('Goals set aside', goals, '−')}
                ${brkRow('Cushion floor', reserve, '−')}
                <div class="bd-brk-row bd-brk-total">
                    <span class="bd-brk-label">Safe to spend</span>
                    <span class="bd-num" style="color:${headColor}">${this._money(safe)}</span>
                </div>
            </div>`;

        return `
        <section class="bd-card bd-hero">
            <div class="bd-hero-main">
                <div class="bd-eyebrow">Safe to spend ${sourceTag}</div>
                ${headNum}
                <div class="bd-hero-sub">${headLabel}</div>
                ${cushionBlock}
            </div>
            <div class="bd-hero-side">
                <div class="bd-side-title">Where it goes</div>
                ${breakdown}
                <div class="bd-fineprint">A cushion subtracts its full <em>target</em>, not its current balance — it stays reserved even once funded.</div>
            </div>
        </section>`;
    },

    _heroShell(eyebrow, inner) {
        return `<section class="bd-card bd-hero"><div class="bd-hero-main">
            <div class="bd-eyebrow">${eyebrow}</div>${inner}</div></section>`;
    },

    // ======================================================================
    // 2 — Savings goals (rings + real funding gap)
    // ======================================================================
    _goalsSection(goals, plan, paySources) {
        if (!goals) return this._sectionShell('Savings goals', '', `<div class="bd-empty">Goals are unavailable right now.</div>`);
        if (goals.length === 0) {
            return this._sectionShell('Savings goals', '',
                `<div class="bd-empty">No goals yet. Add a target on the <a href="#/goals">Savings Goals</a> page to start tracking.</div>`);
        }
        const psById = new Map((paySources || []).map(s => [s.id, s]));
        const cards = goals.map(g => this._goalCard(g, plan, psById)).join('');
        return this._sectionShell('Savings goals',
            'true funding outlook — not just progress-by-today',
            `<div class="bd-grid bd-grid-goals">${cards}</div>`);
    },

    _goalCard(g, plan, psById) {
        const ccy      = g.currency || 'USD';
        const target   = this._n(g.target_amount);
        const saved    = this._n(g.current_saved);
        const progress = this._n(g.progress_pct);
        const required = this._n(g.monthly_required);
        const months   = Number(g.months_until) || 0;

        // Fundable monthly = the funding source's real net monthly income.
        const ps = psById.get(g.funding_source_id);
        const hasIncome = ps && ps.net_per_check != null && ps.periods_per_year;
        const fundable = hasIncome ? this._n(ps.net_per_check) * Number(ps.periods_per_year) / 12 : null;
        const sourceLabel = ps ? ps.name : null;

        // Honest-flag #2: a goal is only really on track if its source can
        // actually fund monthly_required. Project the end balance at the
        // fundable rate (the realistic best case for this income).
        let short = false, shortBy = 0, projectedEnd = null, projectedPct = 0;
        if (fundable != null) {
            projectedEnd = saved + fundable * months;
            projectedPct = target > 0 ? (projectedEnd / target) * 100 : 0;
            if (required > fundable + 0.005) { short = true; shortBy = required - fundable; }
        }
        // Status: prefer the recomputed picture; only fall back to raw
        // on_track when there's no income linked to judge against.
        const realOnTrack = fundable != null ? !short : !!g.on_track;
        const unknown = fundable == null;

        const ringColor  = short ? 'var(--bd-amber)' : 'var(--bd-accent)';
        const ghostColor = short ? 'var(--bd-amber)' : 'var(--bd-green)';
        const ring = this._ring({
            pct: progress,
            ghostPct: projectedEnd != null ? projectedPct : null,
            color: ringColor, ghostColor,
            center: this._pct0(progress),
            sub: 'saved',
        });

        const pill = unknown
            ? `<span class="bd-pill bd-pill-muted">No income linked</span>`
            : (short
                ? `<span class="bd-pill bd-pill-warn">${this._money(shortBy, ccy)}/mo short</span>`
                : `<span class="bd-pill bd-pill-ok">On track</span>`);

        // The projection line — the honest headline for a short goal.
        let projLine = '';
        if (short) {
            projLine = `<div class="bd-proj bd-proj-warn">
                At ${this._money(fundable, ccy)}/mo from ${escapeHtml(sourceLabel)}, this projects
                <strong>${this._money(projectedEnd, ccy)}</strong> of ${this._money(target, ccy)}
                (${this._pct0(projectedPct)}) by ${formatDate(g.target_date)}.</div>`;
        } else if (!unknown) {
            projLine = `<div class="bd-proj bd-proj-ok">
                ${escapeHtml(sourceLabel)} can fund ${this._money(fundable, ccy)}/mo —
                covers the ${this._money(required, ccy)}/mo needed.</div>`;
        } else {
            projLine = `<div class="bd-proj bd-proj-muted">
                Needs ${this._money(required, ccy)}/mo. Link a pay source on the
                <a href="#/goals">Goals</a> page to project the outcome.</div>`;
        }

        return `
        <article class="bd-card bd-goal">
            <div class="bd-goal-head">
                <div class="bd-goal-name">${escapeHtml(g.name)}</div>
                ${pill}
            </div>
            <div class="bd-goal-body">
                <div class="bd-goal-ring">${ring}</div>
                <div class="bd-goal-facts">
                    <div class="bd-kv"><span>Saved</span><strong>${this._money(saved, ccy)}</strong></div>
                    <div class="bd-kv"><span>Target</span><strong>${this._money(target, ccy)}</strong></div>
                    <div class="bd-kv"><span>By</span><strong>${formatDate(g.target_date)}</strong></div>
                    <div class="bd-kv"><span>Need</span><strong>${this._money(required, ccy)}/mo · ${months} mo</strong></div>
                </div>
            </div>
            ${projLine}
        </article>`;
    },

    // ======================================================================
    // 3 — Sinking-fund envelopes (reserve distinct from accrual)
    // ======================================================================
    _envelopesSection(funds) {
        if (!funds) return this._sectionShell('Envelopes', '', `<div class="bd-empty">Sinking funds are unavailable right now.</div>`);
        if (funds.length === 0) {
            return this._sectionShell('Envelopes', '',
                `<div class="bd-empty">No sinking funds yet. Add recurring bills or a cushion on the <a href="#/sinking-funds">Sinking Funds</a> page.</div>`);
        }
        const reserves = funds.filter(f => f.fund_type === 'reserve');
        const accrual  = funds.filter(f => f.fund_type !== 'reserve');

        const reserveHtml = reserves.map(f => this._reserveRow(f)).join('');
        const accrualHtml = accrual.length
            ? accrual.map(f => this._envelopeRow(f)).join('')
            : `<div class="bd-empty bd-empty-sm">No accrual envelopes yet.</div>`;

        return this._sectionShell('Envelopes',
            'pre-funded bills and cash floors',
            `${reserves.length ? `<div class="bd-card bd-env-card bd-reserve-card">
                <div class="bd-env-card-title">Cushion floor<span class="bd-muted"> — reserved from Safe-to-Spend</span></div>
                ${reserveHtml}
            </div>` : ''}
            <div class="bd-card bd-env-card">
                <div class="bd-env-card-title">Accrual envelopes<span class="bd-muted"> — climbing toward each bill</span></div>
                ${accrualHtml}
            </div>`);
    },

    _envelopeRow(f) {
        const ccy = f.currency || 'USD';
        const amount  = this._n(f.amount);
        const balance = this._n(f.current_balance);
        const fill = amount > 0 ? Math.min(100, (balance / amount) * 100) : 0;
        const unfunded = balance === 0;
        const due = f.next_due ? `next ${formatDate(f.next_due)}` : 'no due date';
        return `
        <div class="bd-env-row">
            <div class="bd-env-row-top">
                <span class="bd-env-name">${escapeHtml(f.name)}
                    ${unfunded ? `<span class="bd-tag bd-tag-muted">not yet funded</span>` : ''}</span>
                <span class="bd-num">${this._money(balance, ccy)} <span class="bd-muted">/ ${this._money(amount, ccy)}</span></span>
            </div>
            ${this._bar(fill, 'var(--bd-accent)')}
            <div class="bd-env-row-meta">
                <span>${this._money(f.monthly_accrual, ccy)}/mo accrual</span>
                <span>${due}</span>
            </div>
        </div>`;
    },

    _reserveRow(f) {
        const ccy = f.currency || 'USD';
        const target  = this._n(f.amount);
        const balance = this._n(f.current_balance);
        const pct = target > 0 ? Math.min(100, (balance / target) * 100) : 0;
        const atTarget = balance >= target && target > 0;
        const unfunded = balance === 0;
        const color = atTarget ? 'var(--bd-green)' : 'var(--bd-amber)';
        const status = atTarget
            ? `<span class="bd-env-status" style="color:var(--bd-green)">At target</span>`
            : `<span class="bd-env-status" style="color:var(--bd-amber)">${this._money(target - balance, ccy)} to floor</span>`;
        return `
        <div class="bd-env-row">
            <div class="bd-env-row-top">
                <span class="bd-env-name">${escapeHtml(f.name)}
                    ${unfunded ? `<span class="bd-tag bd-tag-muted">not yet funded</span>` : ''}</span>
                <span class="bd-num">${this._money(balance, ccy)} <span class="bd-muted">/ ${this._money(target, ccy)}</span></span>
            </div>
            ${this._bar(pct, color)}
            <div class="bd-env-row-meta">
                ${status}
                <span>${this._pct1(pct)} funded</span>
            </div>
        </div>`;
    },

    // ======================================================================
    // 4 — Per-paycheck plan (one column per earner)
    // ======================================================================
    _perPaycheckSection(plan, paySources) {
        if (!plan) return this._sectionShell('Per-paycheck plan', '', `<div class="bd-empty">The per-paycheck plan is unavailable right now.</div>`);
        if (plan.length === 0) {
            return this._sectionShell('Per-paycheck plan', '',
                `<div class="bd-empty">No pay sources configured. Add earners on the <a href="#/goals">Goals</a> page.</div>`);
        }
        const psById = new Map((paySources || []).map(s => [s.id, s]));
        const cols = plan.map(p => this._paycheckColumn(p, psById)).join('');
        return this._sectionShell('Per-paycheck plan',
            'what to set aside each check, and what is left to spend',
            `<div class="bd-grid bd-grid-pay">${cols}</div>`);
    },

    _paycheckColumn(p, psById) {
        const setAside = this._n(p.per_check_total);
        const monthly  = this._n(p.monthly_total);
        const ps = psById.get(p.pay_source_id);
        const hasNet = ps && ps.net_per_check != null;
        const net = hasNet ? this._n(ps.net_per_check) : null;

        // Honest-flag #3: set-asides that exceed take-home = overcommit.
        const disc = hasNet ? net - setAside : null;
        const over = hasNet && setAside > net + 0.005;
        const discColor = disc == null ? 'var(--bd-ink-3)' : (disc < 0 ? 'var(--bd-red)' : 'var(--bd-green)');

        const cadenceLabel = `per ${p.cadence} check · ${p.periods_per_year}/yr`;

        const items = (p.items || []).map(it => `
            <div class="bd-pi-row">
                <span class="bd-pi-name">${escapeHtml(it.name)}
                    <span class="bd-pi-kind">${escapeHtml((it.kind || '').replace('_', ' '))}</span></span>
                <span class="bd-num">${this._money(it.per_check)}</span>
            </div>`).join('') || `<div class="bd-empty bd-empty-sm">Nothing set aside.</div>`;

        const overBanner = over
            ? `<div class="bd-overcommit">Set-asides exceed take-home by <strong>${this._money(setAside - net)}</strong>/check.</div>`
            : '';

        return `
        <article class="bd-card bd-pay">
            <div class="bd-eyebrow">${escapeHtml(p.pay_source_name)}</div>
            <div class="bd-pay-cadence">${cadenceLabel}</div>

            <div class="bd-pay-disc">
                <div class="bd-pay-disc-num" style="color:${discColor}">${disc == null ? '—' : this._money(disc)}</div>
                <div class="bd-pay-disc-label">discretionary / check</div>
            </div>
            ${overBanner}

            <div class="bd-pay-stats">
                <div class="bd-kv"><span>Take-home</span><strong>${hasNet ? this._money(net) : '—'}</strong></div>
                <div class="bd-kv"><span>Set aside</span><strong>${this._money(setAside)}</strong></div>
                <div class="bd-kv"><span>Monthly</span><strong>${this._money(monthly)}</strong></div>
            </div>

            <details class="bd-pay-details">
                <summary>${(p.items || []).length} item${(p.items || []).length === 1 ? '' : 's'}</summary>
                <div class="bd-pi-list">${items}</div>
            </details>
        </article>`;
    },

    // ======================================================================
    // 5 — Net worth (degrades gracefully when no balances entered)
    // ======================================================================
    _netWorthSection(nw, sts) {
        const household = nw && nw.totals && nw.totals.household ? nw.totals.household : null;
        const populated = household &&
            (this._n(household.net) !== 0 || this._n(household.assets) !== 0 || this._n(household.liabilities) !== 0);

        if (!populated) {
            // Degrade: show known cash from spendable accounts + a nudge,
            // rather than a broken/empty net-worth card.
            const cash = sts && sts.spendable_source !== 'none' ? this._n(sts.spendable_balance) : null;
            return this._sectionShell('Net worth', '',
                `<div class="bd-card bd-nw">
                    <div class="bd-nw-degrade">
                        <div>
                            <div class="bd-side-title">Known cash</div>
                            <div class="bd-nw-cash">${cash != null ? this._money(cash) : '—'}</div>
                            <div class="bd-muted">from spendable accounts</div>
                        </div>
                        <div class="bd-empty bd-empty-sm" style="max-width:340px;">
                            Add account balances on the <a href="#/balances">Balance Entry</a>
                            page (and house / loan values) to see your full net worth here.
                        </div>
                    </div>
                </div>`);
        }

        const ccy = nw.home_currency || 'USD';
        const net = this._n(household.net);
        const slices = (nw.slices_by_person || []).map(s => {
            const sn = this._n(s.net);
            const share = net !== 0 ? (sn / net) * 100 : 0;
            return `<div class="bd-nw-slice">
                <div class="bd-nw-slice-name">${escapeHtml(s.name)}</div>
                <div class="bd-nw-slice-net">${this._money(sn, ccy)}</div>
                <div class="bd-muted">${this._pct0(share)} of household</div>
            </div>`;
        }).join('');

        return this._sectionShell('Net worth',
            'assets minus liabilities across the household',
            `<div class="bd-card bd-nw">
                <div class="bd-nw-top">
                    <div>
                        <div class="bd-side-title">Household net worth</div>
                        <div class="bd-nw-net">${this._money(net, ccy)}</div>
                    </div>
                    <div class="bd-nw-al">
                        <div class="bd-kv"><span>Assets</span><strong>${this._money(household.assets, ccy)}</strong></div>
                        <div class="bd-kv"><span>Liabilities</span><strong>${this._money(household.liabilities, ccy)}</strong></div>
                        <a class="bd-nw-link" href="#/net-worth">Full breakdown →</a>
                    </div>
                </div>
                ${slices ? `<div class="bd-nw-slices">${slices}</div>` : ''}
            </div>`);
    },

    // ======================================================================
    // Section + skeleton shells
    // ======================================================================
    _sectionShell(title, sub, inner) {
        return `
        <section class="bd-sec">
            <div class="bd-sec-head">
                <h2 class="bd-sec-title">${title}</h2>
                ${sub ? `<span class="bd-sec-sub">${sub}</span>` : ''}
            </div>
            ${inner}
        </section>`;
    },

    _skeleton() {
        const block = (h) => `<div class="bd-skel" style="height:${h}px"></div>`;
        const card = (h) => `<div class="bd-card bd-skel-card">${block(h)}</div>`;
        return `
        <div class="bd-root">
            <header class="bd-page-head">
                <div><div class="bd-eyebrow">Household budget</div><h1 class="bd-title">Budget</h1></div>
            </header>
            ${card(120)}
            <div class="bd-sec"><div class="bd-sec-head"><h2 class="bd-sec-title">Savings goals</h2></div>
                <div class="bd-grid bd-grid-goals">${card(190)}${card(190)}</div></div>
            <div class="bd-sec"><div class="bd-sec-head"><h2 class="bd-sec-title">Envelopes</h2></div>${card(150)}</div>
            <div class="bd-sec"><div class="bd-sec-head"><h2 class="bd-sec-title">Per-paycheck plan</h2></div>
                <div class="bd-grid bd-grid-pay">${card(170)}${card(170)}</div></div>
        </div>`;
    },

    // ======================================================================
    // Scoped styles — injected once. All theming via --bd-* custom props so
    // nothing leaks into the rest of the app; dark-mode override included.
    // ======================================================================
    _injectStyle() {
        if (document.getElementById('bd-styles')) return;
        const el = document.createElement('style');
        el.id = 'bd-styles';
        el.textContent = `
        .bd-root{
            --bd-canvas:#F6F5F2; --bd-card:#FFFFFF;
            --bd-ink:#1A2230; --bd-ink-2:#5A6478; --bd-ink-3:#8A93A6;
            --bd-rule:#ECEAE3; --bd-rule-2:#F2F1EC;
            --bd-accent:#0F7C66; --bd-accent-soft:#E4F1ED;
            --bd-green:#2E7D5B; --bd-amber:#B7791F; --bd-amber-soft:#FBF1DD;
            --bd-red:#C4112E; --bd-red-soft:#FBE9EC;
            --bd-shadow:0 1px 2px rgba(20,30,50,.05), 0 10px 30px -16px rgba(20,30,50,.14);
            --bd-radius:16px;
            background:var(--bd-canvas); color:var(--bd-ink);
            min-height:100%; box-sizing:border-box;
            padding:28px clamp(20px,4vw,44px) 56px;
            font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
            font-variant-numeric:tabular-nums;
        }
        [data-theme="dark"] .bd-root{
            --bd-canvas:#121419; --bd-card:#1E2129;
            --bd-ink:#E6E9F0; --bd-ink-2:#A4ACBC; --bd-ink-3:#79839A;
            --bd-rule:#2C303B; --bd-rule-2:#23262F;
            --bd-accent:#3FC2A2; --bd-accent-soft:#16312B;
            --bd-green:#4CAF7A; --bd-amber:#E0A840; --bd-amber-soft:#2A2414;
            --bd-red:#E0596A; --bd-red-soft:#2E191D;
            --bd-shadow:0 1px 2px rgba(0,0,0,.4), 0 10px 30px -16px rgba(0,0,0,.5);
        }
        .bd-root *{box-sizing:border-box;}
        .bd-root a{color:var(--bd-accent); text-decoration:none;}
        .bd-root a:hover{text-decoration:underline;}
        .bd-num{font-weight:650; color:var(--bd-ink); white-space:nowrap;}
        .bd-num.bd-neg{color:var(--bd-red);}
        .bd-muted{color:var(--bd-ink-3); font-weight:400;}

        .bd-page-head{display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:22px; gap:16px; flex-wrap:wrap;}
        .bd-title{font-size:30px; font-weight:760; letter-spacing:-.02em; margin:2px 0 0; color:var(--bd-ink);}
        .bd-page-meta{font-size:12px; color:var(--bd-ink-3);}
        .bd-eyebrow{font-size:11px; font-weight:680; letter-spacing:.12em; text-transform:uppercase; color:var(--bd-ink-3); display:flex; align-items:center; gap:8px;}

        .bd-card{background:var(--bd-card); border:1px solid var(--bd-rule); border-radius:var(--bd-radius);
            box-shadow:var(--bd-shadow); padding:22px 24px;}

        /* sections */
        .bd-sec{margin-top:30px;}
        .bd-sec-head{display:flex; align-items:baseline; gap:12px; margin-bottom:14px; flex-wrap:wrap;}
        .bd-sec-title{font-size:17px; font-weight:720; letter-spacing:-.01em; margin:0; color:var(--bd-ink);}
        .bd-sec-sub{font-size:12.5px; color:var(--bd-ink-3);}
        .bd-grid{display:grid; gap:18px;}
        .bd-grid-goals{grid-template-columns:repeat(auto-fill, minmax(300px,1fr));}
        .bd-grid-pay{grid-template-columns:repeat(auto-fit, minmax(260px,1fr));}

        .bd-empty{color:var(--bd-ink-2); font-size:13.5px; line-height:1.55; padding:6px 0;}
        .bd-empty-sm{font-size:12.5px; padding:10px 0; color:var(--bd-ink-3);}

        /* hero */
        .bd-hero{display:grid; grid-template-columns:1.4fr 1fr; gap:30px; align-items:stretch;}
        @media (max-width:760px){ .bd-hero{grid-template-columns:1fr;} }
        .bd-hero-main{display:flex; flex-direction:column;}
        .bd-hero-num{font-size:46px; font-weight:780; letter-spacing:-.025em; line-height:1.05; margin-top:8px;}
        .bd-hero-sub{font-size:13.5px; color:var(--bd-ink-2); margin-top:4px;}
        .bd-cushion{margin-top:18px; background:var(--bd-amber-soft); border-radius:12px; padding:14px 16px;}
        .bd-cushion-top{display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px; gap:10px;}
        .bd-cushion-label{font-size:12.5px; font-weight:680; color:var(--bd-amber); text-transform:uppercase; letter-spacing:.04em;}
        .bd-cushion-figs{font-size:13.5px; font-weight:650; color:var(--bd-ink);}
        .bd-cushion-note{font-size:12.5px; color:var(--bd-ink-2); line-height:1.55; margin-top:10px;}
        .bd-hero-side{border-left:1px solid var(--bd-rule); padding-left:28px; display:flex; flex-direction:column;}
        @media (max-width:760px){ .bd-hero-side{border-left:none; border-top:1px solid var(--bd-rule); padding-left:0; padding-top:20px;} }
        .bd-side-title{font-size:11px; font-weight:680; letter-spacing:.1em; text-transform:uppercase; color:var(--bd-ink-3); margin-bottom:10px;}
        .bd-brk-row{display:flex; justify-content:space-between; align-items:baseline; padding:7px 0; border-bottom:1px dotted var(--bd-rule); font-size:13.5px; color:var(--bd-ink-2); gap:14px;}
        .bd-brk-label{}
        .bd-brk-total{border-bottom:none; border-top:1.5px solid var(--bd-rule); margin-top:4px; padding-top:11px; font-weight:700; color:var(--bd-ink);}
        .bd-fineprint{font-size:11.5px; color:var(--bd-ink-3); line-height:1.5; margin-top:14px;}

        /* goals */
        .bd-goal{display:flex; flex-direction:column;}
        .bd-goal-head{display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:6px;}
        .bd-goal-name{font-size:16px; font-weight:700; color:var(--bd-ink);}
        .bd-goal-body{display:flex; gap:18px; align-items:center; margin:6px 0 4px;}
        .bd-goal-ring{flex:0 0 auto;}
        .bd-goal-facts{flex:1; min-width:0;}
        .bd-kv{display:flex; justify-content:space-between; gap:10px; font-size:13px; padding:3px 0; color:var(--bd-ink-2);}
        .bd-kv strong{color:var(--bd-ink); font-weight:650; text-align:right;}
        .bd-proj{font-size:12.5px; line-height:1.5; border-radius:10px; padding:10px 12px; margin-top:10px;}
        .bd-proj-warn{background:var(--bd-amber-soft); color:var(--bd-ink-2);}
        .bd-proj-ok{background:var(--bd-accent-soft); color:var(--bd-ink-2);}
        .bd-proj-muted{background:var(--bd-rule-2); color:var(--bd-ink-2);}
        .bd-proj strong{color:var(--bd-ink);}

        /* rings */
        .bd-ring-num{font-size:22px; font-weight:740; fill:var(--bd-ink);}
        .bd-ring-sub{font-size:10px; fill:var(--bd-ink-3); text-transform:uppercase; letter-spacing:.1em;}

        /* pills + tags */
        .bd-pill{font-size:11px; font-weight:680; padding:3px 10px; border-radius:999px; white-space:nowrap;}
        .bd-pill-ok{background:var(--bd-accent-soft); color:var(--bd-accent);}
        .bd-pill-warn{background:var(--bd-amber-soft); color:var(--bd-amber);}
        .bd-pill-muted{background:var(--bd-rule-2); color:var(--bd-ink-3);}
        .bd-tag{font-size:10px; font-weight:640; padding:1px 7px; border-radius:999px; margin-left:6px; vertical-align:middle;}
        .bd-tag-muted{background:var(--bd-rule-2); color:var(--bd-ink-3);}

        /* bars */
        .bd-track{height:8px; border-radius:999px; background:var(--bd-rule); overflow:hidden;}
        .bd-fill{height:100%; border-radius:999px; transition:width .3s ease;}

        /* envelopes */
        .bd-env-card + .bd-env-card{margin-top:18px;}
        .bd-reserve-card{border-left:3px solid var(--bd-amber);}
        .bd-env-card-title{font-size:13px; font-weight:700; color:var(--bd-ink); margin-bottom:14px;}
        .bd-env-row{padding:11px 0; border-top:1px solid var(--bd-rule-2);}
        .bd-env-row:first-of-type{border-top:none; padding-top:0;}
        .bd-env-row-top{display:flex; justify-content:space-between; align-items:baseline; gap:12px; margin-bottom:7px; font-size:13.5px;}
        .bd-env-name{font-weight:650; color:var(--bd-ink);}
        .bd-env-row-meta{display:flex; justify-content:space-between; gap:12px; font-size:11.5px; color:var(--bd-ink-3); margin-top:7px;}
        .bd-env-status{font-weight:640;}

        /* per-paycheck */
        .bd-pay{display:flex; flex-direction:column;}
        .bd-pay-cadence{font-size:12px; color:var(--bd-ink-3); margin-top:2px;}
        .bd-pay-disc{margin:16px 0 4px;}
        .bd-pay-disc-num{font-size:30px; font-weight:760; letter-spacing:-.02em; line-height:1;}
        .bd-pay-disc-label{font-size:11.5px; color:var(--bd-ink-3); text-transform:uppercase; letter-spacing:.08em; margin-top:5px;}
        .bd-overcommit{background:var(--bd-red-soft); color:var(--bd-red); font-size:12px; line-height:1.45; border-radius:10px; padding:9px 12px; margin:10px 0 2px;}
        .bd-overcommit strong{color:var(--bd-red);}
        .bd-pay-stats{margin-top:14px; border-top:1px solid var(--bd-rule-2); padding-top:10px;}
        .bd-pay-details{margin-top:12px;}
        .bd-pay-details summary{cursor:pointer; font-size:12px; font-weight:640; color:var(--bd-accent); user-select:none; list-style:none;}
        .bd-pay-details summary::-webkit-details-marker{display:none;}
        .bd-pay-details summary::before{content:"▸ "; font-size:10px;}
        .bd-pay-details[open] summary::before{content:"▾ ";}
        .bd-pi-list{margin-top:8px;}
        .bd-pi-row{display:flex; justify-content:space-between; align-items:baseline; gap:12px; padding:5px 0; border-bottom:1px dotted var(--bd-rule); font-size:12.5px;}
        .bd-pi-row:last-child{border-bottom:none;}
        .bd-pi-name{color:var(--bd-ink); font-weight:600;}
        .bd-pi-kind{font-size:10px; color:var(--bd-ink-3); text-transform:uppercase; letter-spacing:.06em; margin-left:6px; font-weight:600;}

        /* net worth */
        .bd-nw-top{display:flex; justify-content:space-between; gap:24px; align-items:flex-start; flex-wrap:wrap;}
        .bd-nw-net{font-size:34px; font-weight:770; letter-spacing:-.02em; color:var(--bd-ink); margin-top:2px;}
        .bd-nw-al{min-width:200px;}
        .bd-nw-link{display:inline-block; font-size:12.5px; font-weight:640; margin-top:6px;}
        .bd-nw-slices{display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:14px; margin-top:20px; border-top:1px solid var(--bd-rule); padding-top:18px;}
        .bd-nw-slice-name{font-size:12px; color:var(--bd-ink-2); font-weight:600;}
        .bd-nw-slice-net{font-size:18px; font-weight:700; color:var(--bd-ink); margin:2px 0;}
        .bd-nw-degrade{display:flex; gap:30px; align-items:center; flex-wrap:wrap;}
        .bd-nw-cash{font-size:28px; font-weight:760; color:var(--bd-ink); margin:2px 0;}

        /* skeleton */
        .bd-skel{background:linear-gradient(90deg,var(--bd-rule-2) 25%,var(--bd-rule) 37%,var(--bd-rule-2) 63%); background-size:400% 100%; border-radius:10px; animation:bd-shimmer 1.4s ease infinite;}
        .bd-skel-card{padding:0; overflow:hidden;}
        .bd-skel-card .bd-skel{border-radius:var(--bd-radius);}
        @keyframes bd-shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}
        @media (prefers-reduced-motion:reduce){ .bd-skel{animation:none;} .bd-fill{transition:none;} }
        `;
        document.head.appendChild(el);
    },
};
