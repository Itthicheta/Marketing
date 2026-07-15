// ============================================================================
// DATA ADAPTER — v1 skeleton ships with SYNTHETIC data so the dashboard is
// fully developable before the POS feed exists.
//
// Phase 4 wiring: replace `loadData()` with a fetch to the Cloudflare Worker
// proxy, which queries the Supabase `marts` views with the service key.
// Every block below names the marts view it mirrors.
// ============================================================================

const BRANCHES = ['Gaysorn', 'Silom', 'Rama9', 'OCC'];        // fixed slot order 1-4
const CHANNELS = ['Dine-In', 'Take Away', 'Delivery'];
const CATEGORIES = ['Signature', 'Noodles', 'Snacks', 'Set', 'Gaolao', 'Rice', 'Beverages', 'Desserts'];
const NOODLES = ['Flat egg', 'Round egg', 'Thin rice', 'Vermicelli', 'Wide rice'];
const ADDON_SUBS = ['Soft drinks / water', 'Brewed drinks', 'Fried', 'General snacks', 'Side dishes', 'Sharing', 'Desserts'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
const HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];

// --- deterministic pseudo-random so the skeleton renders identically everywhere
let _seed = 42;
function rnd() { _seed = (_seed * 1103515245 + 12345) % 2147483648; return _seed / 2147483648; }

// marts.v_monthly_by_branch (deck p.4, p.53)
function synthMonthly() {
  const base = { Gaysorn: 0.95, Silom: 0.92, Rama9: 0.22, OCC: 0 };
  const rows = [];
  BRANCHES.forEach(b => MONTHS.forEach((m, i) => {
    if (b === 'OCC' && i < 4) return;                         // OCC opened month 5
    const trend = 1 + i * 0.06 + (rnd() - 0.5) * 0.12;
    const sales = Math.round((base[b] || 0.28) * 1e6 * trend);
    const abs = Math.round(300 + (b === 'OCC' ? 130 : 40) + (rnd() - 0.5) * 40);
    rows.push({ month: m, branch: b, sales, transactions: Math.round(sales / abs), abs });
  }));
  return rows;
}

// marts.v_branch_channel (deck p.5-8): per branch x channel sales/txn/ABS + % of branch
function synthBranchChannel() {
  const mixPct = { Gaysorn: [69.7, 1.5, 28.8], Silom: [82.2, 0.9, 17.0], Rama9: [69.7, 1.5, 28.8], OCC: [92.3, 7.7, 0] };
  const totals = { Gaysorn: 5083971, Silom: 5081056, Rama9: 987046, OCC: 1266989 };
  const absBy = { 'Dine-In': 361, 'Take Away': 240, 'Delivery': 304 };
  const rows = [];
  BRANCHES.forEach(b => CHANNELS.forEach((c, i) => {
    const pct = mixPct[b][i];
    if (pct === 0) return;
    const sales = Math.round(totals[b] * pct / 100);
    const abs = Math.round(absBy[c] * (0.9 + rnd() * 0.25) * (b === 'OCC' ? 1.25 : 1));
    rows.push({ branch: b, channel: c, sales, pct, abs, transactions: Math.round(sales / abs) });
  }));
  return rows;
}

// marts.v_daypart — hour contribution % (deck p.9, 30) and ABS by hour (p.10)
function synthDaypart() {
  const out = { weekday: {}, weekend: {} };
  BRANCHES.forEach(b => {
    ['weekday', 'weekend'].forEach(dt => {
      const spread = dt === 'weekend' ? 0.55 : 1;
      let vals = HOURS.map(h => {
        let v = 2 + rnd() * 2;
        if (h >= 11 && h <= 13) v += 14 * spread * (b === 'OCC' || b === 'Silom' ? 1.3 : 1);
        if ((h === 18 || h === 19) && (b === 'Gaysorn' || b === 'Silom')) v += 5;
        if (h >= 16 && h <= 17 && b === 'Rama9') v += 4;
        return v;
      });
      const t = vals.reduce((a, x) => a + x, 0);
      out[dt][b] = vals.map(v => +(100 * v / t).toFixed(1));
    });
  });
  return out;
}

function synthDaypartAbs() {                                   // ABS THB by hour per branch
  const out = {};
  BRANCHES.forEach(b => {
    const base = b === 'OCC' ? 430 : 330;
    out[b] = HOURS.map(h => {
      let v = base + (rnd() - 0.5) * 40;
      if (h === 12 && (b === 'OCC' || b === 'Silom')) v += 60; // office lunch groups
      if (h >= 19 && (b === 'Silom' || b === 'Gaysorn')) v += 45; // evening take-away
      return Math.round(v);
    });
  });
  return out;
}

// deck p.29 — channel x hour contribution, weekday vs weekend
function synthChannelHour() {
  const out = { weekday: {}, weekend: {} };
  CHANNELS.forEach(c => {
    ['weekday', 'weekend'].forEach(dt => {
      const spread = dt === 'weekend' ? 0.6 : 1;
      let vals = HOURS.map(h => {
        let v = 2 + rnd() * 2;
        if (c === 'Dine-In' && h >= 12 && h <= 13) v += 16 * spread;
        if (c === 'Take Away' && h >= 16 && h <= 19) v += 6 * (dt === 'weekend' && h === 19 ? 1.6 : 1);
        if (c === 'Delivery' && (h === 11 || h === 12 || h === 18)) v += 8;
        return v;
      });
      const t = vals.reduce((a, x) => a + x, 0);
      out[dt][c] = vals.map(v => +(100 * v / t).toFixed(1));
    });
  });
  return out;
}

// marts.v_category_mix by channel (deck p.13) and by branch (p.16)
function synthCategoryMix() {
  const shares = { Signature: 27, Noodles: 24, Snacks: 17, Set: 10, Gaolao: 8, Rice: 6, Beverages: 5.6, Desserts: 2.4 };
  return CHANNELS.map(ch => ({
    group: ch,
    values: CATEGORIES.map(cat => {
      let v = shares[cat];
      if (ch === 'Delivery' && cat === 'Signature') v = 46;
      if (ch === 'Delivery' && cat === 'Set') v = 0.5;
      if (ch === 'Take Away' && cat === 'Gaolao') v = 12;
      return +(v * (0.9 + rnd() * 0.2)).toFixed(1);
    }),
  }));
}
function synthCategoryMixBranch() {
  const shares = { Signature: 27, Noodles: 24, Snacks: 17, Set: 10, Gaolao: 8, Rice: 6, Beverages: 5.6, Desserts: 2.4 };
  return BRANCHES.map(b => ({
    group: b,
    values: CATEGORIES.map(cat => {
      let v = shares[cat];
      if (b === 'Rama9' && cat === 'Gaolao') v = 13;           // deck: gaolao strong at Rama9
      return +(v * (0.9 + rnd() * 0.2)).toFixed(1);
    }),
  }));
}

// marts.v_noodle_mix (deck p.15 by channel, p.17 by branch) — 100% stacks
function synthNoodleMix(groups, tweak) {
  return groups.map(g => {
    let base = [64, 16.5, 11, 3.5, 2.5].map(v => v * (0.92 + rnd() * 0.16));
    tweak(g, base);
    const t = base.reduce((a, x) => a + x, 0);
    return { group: g, values: base.map(v => +(100 * v / t).toFixed(1)) };
  });
}

// marts.v_menu_ranking (deck p.14)
function synthTopItems() {
  return [
    { sku: 'S1', name: 'Pork-neck noodles (ก๋วยเตี๋ยวคอหมู)', share: 18.8 },
    { sku: 'S2', name: 'Pork-collar noodles (สันคอหมู)', share: 9.4 },
    { sku: 'SET1', name: 'Set Sudkoom', share: 7.2 },
    { sku: 'N3', name: 'Dry tom yum deluxe (ต้มยำแห้ง ทรงเครื่อง)', share: 6.1 },
    { sku: 'N6', name: 'Thick-broth tom yum (ต้มยำน้ำข้น)', share: 4.9 },
    { sku: 'N1', name: 'Dry tom yum (ต้มยำแห้ง ธรรมดา)', share: 4.3 },
    { sku: 'A2', name: 'Rolled noodles (ก๋วยเตี๋ยวหลอดโบราณ)', share: 3.6 },
    { sku: 'C1', name: 'Fried assortment (รวมทอด)', share: 3.1 },
  ];
}

// marts.v_basket_distribution (deck p.19, 33)
function synthBasket() {
  const dist = [46.3, 25.0, 12.4, 7.1, 4.2, 2.4, 1.3, 0.7, 0.4, 0.2];
  return dist.map((pct, i) => ({ bucket: String(i + 1), pctBills: pct }));
}

// marts.v_combo_patterns (deck p.19 right side)
function synthCombos() {
  return {
    '1': [{ p: 'Noodles x1', pct: 42.1 }, { p: 'Signature x1', pct: 38.7 }, { p: 'Rice x1', pct: 11.2 }, { p: 'Gaolao x1', pct: 8.0 }],
    '2': [{ p: 'Noodles x2', pct: 31.4 }, { p: 'Signature x1 + Noodles x1', pct: 27.8 }, { p: 'Signature x2', pct: 22.5 }, { p: 'Noodles x1 + Gaolao x1', pct: 9.1 }],
    '3': [{ p: 'Signature x1 + Noodles x2', pct: 26.3 }, { p: 'Noodles x3', pct: 21.7 }, { p: 'Signature x2 + Noodles x1', pct: 18.9 }, { p: 'Signature x1 + Noodles x1 + Gaolao x1', pct: 10.4 }],
  };
}

// marts.v_addon_attachment (deck p.20-23) + v_addon_by_subcategory (p.20/26)
function synthAttachment() {
  return [
    { channel: 'Dine-In', pctWithAddon: 71.7, addonPerBill: 3.12, topSub: 'Soft drinks / water' },
    { channel: 'Take Away', pctWithAddon: 49.7, addonPerBill: 2.25, topSub: 'Side dishes' },
    { channel: 'Delivery', pctWithAddon: 50.6, addonPerBill: 1.59, topSub: 'Fried' },
  ];
}
function synthAddonSub() {
  const byChan = { 'Dine-In': [1.95, 0.24, 0.31, 0.28, 0.22, 0.09, 0.03], 'Take Away': [0.35, 0.08, 0.47, 0.47, 0.93, 0.05, 0.02], 'Delivery': [0.22, 0.05, 0.51, 0.48, 0.25, 0.06, 0.02] };
  return CHANNELS.map(c => ({ group: c, values: byChan[c] }));
}
function synthAddonSubBranch() {                                // deck p.26 benchmark matrix
  const byBranch = { Gaysorn: [1.21, 0.15, 0.38, 0.31, 0.29, 0.09, 0.02], Silom: [1.56, 0.21, 0.42, 0.35, 0.57, 0.11, 0.03], Rama9: [1.44, 0.18, 0.45, 0.33, 0.38, 0.08, 0.03], OCC: [1.95, 0.26, 0.40, 0.37, 0.41, 0.13, 0.04] };
  return BRANCHES.map(b => ({ group: b, values: byBranch[b] }));
}

// marts.v_abs_by_basket (deck p.24)
function synthAbsByBasket() {
  return ['1', '2', '3', '4', '5', '6+'].map((bucket, i) => {
    const mains = i + 1;
    const abs = Math.round(210 + mains * 165 + (rnd() - 0.5) * 30);
    return { bucket, bills: [16500, 8900, 4400, 2500, 1500, 1900][i], abs, absPerMain: Math.round(abs / mains), pctSales: [28.1, 24.4, 17.3, 11.9, 8.6, 9.7][i] };
  });
}

// marts.v_weekday_weekend (deck p.28)
function synthWdWe() {
  const base = { Gaysorn: [28500, 26900], Silom: [32800, 22100], Rama9: [4900, 6300], OCC: [9800, 5200] };
  return BRANCHES.map(b => {
    const [wd, we] = base[b];
    const absWd = Math.round(320 + (b === 'OCC' ? 120 : 20));
    const absWe = Math.round(absWd * (0.95 + rnd() * 0.1));
    return {
      branch: b,
      salesPerDay: { weekday: wd * 10, weekend: we * 10 },
      ordersPerDay: { weekday: Math.round(wd * 10 / absWd), weekend: Math.round(we * 10 / absWe) },
      abs: { weekday: absWd, weekend: absWe },
    };
  });
}

// marts.v_insights — the suggestion layer (ops.generate_insights() output)
function synthInsights() {
  return [
    { status: 'bad', rule: 'sales_slump', title: 'Rama9 sales below baseline 4 of last 7 days', detail: 'Average −22% vs 4-week same-weekday baseline.', action: 'Check operations first (staffing, stockouts, platform downtime). If ops is clean, run a traffic promo in the weekend daypart — Rama9 is your weekend-first branch.' },
    { status: 'bad', rule: 'attachment_drop', title: 'Delivery add-on attachment dropped to 44.9%', detail: 'Down from 50.6% in the prior 4 weeks.', action: 'Check that add-on options and set menus are still visible and in stock on the Grab/LINE MAN storefront.' },
    { status: 'good', rule: 'sales_surge', title: 'Gaysorn running +24% vs baseline', detail: '5 strong days in the last 7.', action: 'Identify the driver (campaign overlay, holiday, viral post) and repeat it deliberately. Verify stock and staffing can hold the new level.' },
    { status: 'amplify', rule: 'set_opportunity', title: 'Set candidate: Pork-neck noodles + Thai iced tea', detail: '412 bills already pair these (lift 1.8). Target Take Away where only 49.7% of bills have add-ons.', action: 'Launch as a set at ฿105 on Take Away. Register it in the campaign plan so uplift and cannibalization are measured automatically.' },
    { status: 'amplify', rule: 'peak_saturated', title: 'Silom 12:00 runs near capacity 74% of weekdays', detail: 'Lunch demand exceeds throughput — promos in this window waste budget.', action: 'Shift, don’t stoke: pre-order/Grab-and-go for 11:30, happy-hour pricing 13:30–16:00, route ad spend off-peak.' },
    { status: 'amplify', rule: 'payday_pattern', title: 'OCC payday lift is 19%', detail: 'Sales on payday windows (1st/15th/month-end) consistently beat baseline.', action: 'Time premium sets and content to payday windows; discount mid-cycle instead.' },
  ];
}

// marts.v_set_candidates — ranked set-menu suggestions
function synthSetCandidates() {
  return [
    { anchor: 'S1 Pork-neck noodles', companion: 'Thai iced tea', lift: 1.8, bills: 412, price: 105, foodCost: 38.2, target: 'Take Away', score: 168 },
    { anchor: 'N3 Dry tom yum deluxe', companion: 'Fried assortment', lift: 1.6, bills: 287, price: 130, foodCost: 41.7, target: 'Take Away', score: 131 },
    { anchor: 'S1 Pork-neck noodles', companion: 'Minced-pork soup', lift: 1.5, bills: 244, price: 115, foodCost: 40.1, target: 'Take Away', score: 118 },
    { anchor: 'N1 Dry tom yum', companion: 'Soft-boiled egg', lift: 1.4, bills: 198, price: 85, foodCost: 36.4, target: 'Take Away', score: 96 },
  ];
}

function loadData() {
  return {
    synthetic: true,
    insights: synthInsights(),
    setCandidates: synthSetCandidates(),
    monthly: synthMonthly(),
    branchChannel: synthBranchChannel(),
    daypart: synthDaypart(),
    daypartAbs: synthDaypartAbs(),
    channelHour: synthChannelHour(),
    categoryMix: synthCategoryMix(),
    categoryMixBranch: synthCategoryMixBranch(),
    noodleByChannel: synthNoodleMix(CHANNELS, (g, v) => { if (g === 'Delivery') { v[1] += 4; v[2] -= 1.5; } if (g === 'Take Away') v[2] += 4; }),
    noodleByBranch: synthNoodleMix(BRANCHES, (g, v) => { if (g === 'OCC') { v[0] -= 3; v[1] += 1.5; v[3] += 1; } }),
    topItems: synthTopItems(),
    basket: synthBasket(),
    combos: synthCombos(),
    attachment: synthAttachment(),
    addonSub: synthAddonSub(),
    addonSubBranch: synthAddonSubBranch(),
    absByBasket: synthAbsByBasket(),
    wdwe: synthWdWe(),
    kpi: { sales: 12419062, transactions: 35772, abs: 347, vsBaseline: +4.2 },
  };
}

window.MP_DATA = loadData();
window.MP_DIMS = { BRANCHES, CHANNELS, CATEGORIES, NOODLES, ADDON_SUBS, MONTHS, HOURS };
