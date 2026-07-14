// ============================================================================
// DATA ADAPTER — v1 skeleton ships with SYNTHETIC data so the dashboard is
// fully developable before the POS feed exists.
//
// Phase 4 wiring: replace `loadData()` with a fetch to the Cloudflare Worker
// proxy, which queries the Supabase `marts` views with the service key:
//   marts.v_monthly_by_branch, marts.v_branch_channel, marts.v_daypart,
//   marts.v_category_mix, marts.v_menu_ranking, marts.v_basket_distribution,
//   marts.v_addon_attachment, marts.v_sales_vs_baseline
// The shapes below intentionally mirror those views' columns.
// ============================================================================

const BRANCHES = ['Gaysorn', 'Silom', 'Rama9', 'OCC'];        // fixed slot order 1-4
const CHANNELS = ['Dine-In', 'Take Away', 'Delivery'];
const CATEGORIES = ['Signature', 'Noodles', 'Snacks', 'Set', 'Gaolao', 'Rice', 'Beverages', 'Desserts'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
const HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];

// --- deterministic pseudo-random so the skeleton renders identically everywhere
let _seed = 42;
function rnd() { _seed = (_seed * 1103515245 + 12345) % 2147483648; return _seed / 2147483648; }

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

function synthChannelMix() {
  const mix = {
    Gaysorn: [69.7, 1.5, 28.8], Silom: [82.2, 0.9, 17.0],
    Rama9: [69.7, 1.5, 28.8], OCC: [92.3, 7.7, 0],
  };
  return BRANCHES.map(b => ({
    branch: b,
    values: CHANNELS.map((c, i) => mix[b][i === 0 ? 0 : i === 1 ? 1 : 2]),
  }));
}

function synthDaypart() {
  // hour-contribution % per branch x day type; lunch peak + branch quirks
  const out = { weekday: {}, weekend: {} };
  BRANCHES.forEach(b => {
    ['weekday', 'weekend'].forEach(dt => {
      const spread = dt === 'weekend' ? 0.55 : 1;             // weekends flatter
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

function synthCategoryMix() {
  const shares = { Signature: 27, Noodles: 24, Snacks: 17, Set: 10, Gaolao: 8, Rice: 6, Beverages: 5.6, Desserts: 2.4 };
  return CHANNELS.map(ch => ({
    channel: ch,
    values: CATEGORIES.map(cat => {
      let v = shares[cat];
      if (ch === 'Delivery' && cat === 'Signature') v = 46;
      if (ch === 'Delivery' && cat === 'Set') v = 0.5;
      if (ch === 'Take Away' && cat === 'Gaolao') v = 12;
      return +(v * (0.9 + rnd() * 0.2)).toFixed(1);
    }),
  }));
}

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

function synthBasket() {
  const dist = [46.3, 25.0, 12.4, 7.1, 4.2, 2.4, 1.3, 0.7, 0.4, 0.2];
  return dist.map((pct, i) => ({ bucket: String(i + 1), pctBills: pct }));
}

function synthAttachment() {
  return [
    { channel: 'Dine-In', pctWithAddon: 71.7, addonPerBill: 3.12, topSub: 'Soft drinks / water' },
    { channel: 'Take Away', pctWithAddon: 49.7, addonPerBill: 2.25, topSub: 'Side dishes' },
    { channel: 'Delivery', pctWithAddon: 50.6, addonPerBill: 1.59, topSub: 'Fried' },
  ];
}

function loadData() {
  return {
    synthetic: true,
    generatedAt: 'synthetic-v1',
    monthly: synthMonthly(),
    channelMix: synthChannelMix(),
    daypart: synthDaypart(),
    categoryMix: synthCategoryMix(),
    topItems: synthTopItems(),
    basket: synthBasket(),
    attachment: synthAttachment(),
    kpi: { sales: 12419062, transactions: 35772, abs: 347, vsBaseline: +4.2 },
  };
}

window.MP_DATA = loadData();
window.MP_DIMS = { BRANCHES, CHANNELS, CATEGORIES, MONTHS, HOURS };
