const API_BASE = "https://bountyguild.deviyl.workers.dev";
const VIEW_STORAGE_KEY = "bg_current_view";
const ORDERS_CACHE_KEY = "bg_orders_cache_v1";
const RESOLVED_RETENTION_MS = 60 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

const state = { user: null, pollTimer: null, tickTimer: null };

const $app = document.getElementById("app");
const $topbar = document.getElementById("topbar");
const $nav = document.getElementById("nav");
const $identity = document.getElementById("identity");

const BOUNTY_COSTS = { 1: 4, 2: 6, 3: 8 };
const ADMIN_ONLY_VIEWS = new Set(["admin", "log"]);
const VALID_VIEWS = new Set(["bounties", "place-bounty", "admin", "log"]);

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "include",
  });
  const data = await res.json().catch(() => ({ success: false, message: "Unexpected response." }));
  return { ok: res.ok, status: res.status, data };
}

function fmtMoney(n) {
  return "$" + Number(n).toLocaleString("en-US");
}

function loadOrderCache() {
  try {
    const raw = localStorage.getItem(ORDERS_CACHE_KEY);
    if (!raw) return { orders: {}, receiver: null, message: "bounty" };
    const parsed = JSON.parse(raw);
    return { orders: parsed.orders || {}, receiver: parsed.receiver || null, message: parsed.message || "bounty" };
  } catch {
    return { orders: {}, receiver: null, message: "bounty" };
  }
}
function saveOrderCache(cache) {
  try { localStorage.setItem(ORDERS_CACHE_KEY, JSON.stringify(cache)); } catch { }
}

function cacheNewOrder(order) {
  const cache = loadOrderCache();
  cache.receiver = order.receiver;
  cache.message = order.message;
  cache.orders[order.id] = { ...order, firstSeenAt: Date.now(), resolvedAt: null };
  saveOrderCache(cache);
  return cache;
}

async function refreshOrders() {
  const { data } = await api("/api/orders/mine");
  if (!data.success) return;

  const cache = loadOrderCache();
  cache.receiver = data.receiver;
  cache.message = data.message;

  const serverById = new Map(data.orders.map((o) => [o.id, o]));
  const now = Date.now();

  for (const order of data.orders) {
    const existing = cache.orders[order.id];
    cache.orders[order.id] = {
      ...order,
      firstSeenAt: existing ? existing.firstSeenAt : now,
      resolvedAt: null,
    };
  }

  for (const [id, cached] of Object.entries(cache.orders)) {
    if (cached.status !== "pending_payment") continue;
    if (serverById.has(id)) continue;
    const expired = now >= cached.expiresAt;
    cache.orders[id] = { ...cached, status: expired ? "expired" : "active", resolvedAt: now };
  }

  for (const [id, cached] of Object.entries(cache.orders)) {
    if (cached.resolvedAt && now - cached.resolvedAt > RESOLVED_RETENTION_MS) {
      delete cache.orders[id];
    }
  }

  saveOrderCache(cache);
  renderPendingOrders();
}

function dismissOrder(orderId) {
  const cache = loadOrderCache();
  delete cache.orders[orderId];
  saveOrderCache(cache);
  renderPendingOrders();
}

function startOrderPolling() {
  stopOrderPolling();
  refreshOrders();
  state.pollTimer = setInterval(refreshOrders, POLL_INTERVAL_MS);
  state.tickTimer = setInterval(renderCountdownsOnly, 1000);
}
function stopOrderPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  if (state.tickTimer) clearInterval(state.tickTimer);
  state.pollTimer = null;
  state.tickTimer = null;
}

function render(viewName) {
  stopOrderPolling();
  $app.innerHTML = "";
  const tpl = document.getElementById(`tpl-${viewName}`);
  $app.appendChild(tpl.content.cloneNode(true));

  document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === viewName));

  if (viewName !== "login") {
    try { localStorage.setItem(VIEW_STORAGE_KEY, viewName); } catch { }
  }

  if (viewName === "login") wireLogin();
  if (viewName === "bounties") loadBounties();
  if (viewName === "place-bounty") { wirePlaceBounty(); startOrderPolling(); }
  if (viewName === "admin") loadAdmin();
  if (viewName === "log") loadLog();
}

function renderNav() {
  $nav.innerHTML = "";
  const items = [
    { id: "bounties", label: "Bounties" },
    { id: "place-bounty", label: "Place bounty" },
  ];
  if (state.user && state.user.isAdmin) {
    items.push({ id: "admin", label: "Admin" });
    items.push({ id: "log", label: "Log" });
  }
  for (const item of items) {
    const btn = document.createElement("button");
    btn.textContent = item.label;
    btn.dataset.view = item.id;
    btn.addEventListener("click", () => render(item.id));
    $nav.appendChild(btn);
  }
}

function updateChrome() {
  if (state.user) {
    $topbar.classList.remove("hidden");
    $identity.textContent = `${state.user.name} [${state.user.id}]`;
    renderNav();
  } else {
    $topbar.classList.add("hidden");
    $identity.textContent = "";
    $nav.innerHTML = "";
  }
}

function wireLogin() {
  const form = document.getElementById("login-form");
  const errorBox = document.getElementById("login-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    const apiKey = document.getElementById("api-key-input").value.trim();
    const submitBtn = form.querySelector("button");
    submitBtn.disabled = true;
    const { data } = await api("/api/login", { method: "POST", body: JSON.stringify({ apiKey }) });
    submitBtn.disabled = false;
    if (!data.success) {
      errorBox.textContent = data.message || "Login failed.";
      errorBox.hidden = false;
      return;
    }
    state.user = data.user;
    updateChrome();
    render(restoreViewOrDefault());
  });
}

async function handleLogout() {
  await api("/api/logout", { method: "POST" });
  state.user = null;
  updateChrome();
  render("login");
}

async function loadBounties() {
  const list = document.getElementById("bounty-list");
  list.innerHTML = "<p class=\"empty-state\">Loading bounties…</p>";
  const { data } = await api("/api/bounties");
  if (!data.success) {
    list.innerHTML = `<p class="empty-state">${escapeHtml(data.message || "Could not load bounties.")}</p>`;
    return;
  }
  if (data.bounties.length === 0) {
    list.innerHTML = "<p class=\"empty-state\">No bounties posted right now.</p>";
    return;
  }
  list.innerHTML = "";
  for (const bounty of data.bounties) list.appendChild(buildBountyCard(bounty));
}

function buildBountyCard(bounty) {
  const tpl = document.getElementById("tpl-bounty-card");
  const node = tpl.content.cloneNode(true);
  node.querySelector("[data-level]").textContent = `L${bounty.bountyLevel}`;
  node.querySelector("[data-target-name]").textContent = bounty.targetUserName;
  node.querySelector("[data-target-id]").textContent = `[${bounty.targetUserID}]`;
  node.querySelector("[data-reward]").textContent = fmtMoney(bounty.payoutAmount);
  node.querySelector("[data-requirement]").innerHTML = buildRequirementHtml(bounty.bountyLevel, bounty.targetUserName);

  const claimBtn = node.querySelector('[data-action="claim"]');
  const statusEl = node.querySelector("[data-status]");

  claimBtn.addEventListener("click", async () => {
    claimBtn.disabled = true;
    statusEl.hidden = false;
    statusEl.textContent = "Verifying attack…";
    const { data } = await api("/api/bounties/claim", { method: "POST", body: JSON.stringify({ bountyId: bounty.id }) });
    if (data.success) {
      statusEl.textContent = "Bounty claimed successfully.";
      claimBtn.remove();
    } else if (data.error === "ALREADY_CLAIMED") {
      statusEl.textContent = "This bounty has already been claimed.";
      claimBtn.remove();
    } else if (data.error === "NO_QUALIFYING_ATTACK") {
      statusEl.textContent = "No qualifying attack was found.";
      claimBtn.disabled = false;
    } else if (data.error === "TORN_API_UNAVAILABLE") {
      statusEl.textContent = data.message;
      claimBtn.disabled = false;
    } else {
      statusEl.textContent = data.message || "Something went wrong.";
      claimBtn.disabled = false;
    }
  });

  return node;
}

function buildRequirementHtml(level, targetName) {
  const name = escapeHtml(targetName);
  if (level === 1) {
    return `Claim this bounty <u>after</u> you have <strong>hospitalized</strong> ${name}.`;
  }
  if (level === 2) {
    return `Claim this bounty <u>after</u> you have <strong>hospitalized</strong> ${name} with EITHER <strong>stricken</strong> OR <strong>10/10 merits</strong>.`;
  }
  return `Claim this bounty <u>after</u> you have <strong>hospitalized</strong> ${name} with BOTH <strong>stricken</strong> AND <strong>10/10 merits</strong>.`;
}

function wirePlaceBounty() {
  const form = document.getElementById("place-form");
  const qtyInput = document.getElementById("quantity-input");
  const costTotal = document.getElementById("cost-total");
  const errorBox = document.getElementById("place-error");

  function recalcCost() {
    const level = Number(form.querySelector('input[name="level"]:checked').value);
    const qty = Math.max(1, Number(qtyInput.value) || 1);
    costTotal.textContent = BOUNTY_COSTS[level] * qty;
  }
  form.querySelectorAll('input[name="level"]').forEach((r) => r.addEventListener("change", recalcCost));
  qtyInput.addEventListener("input", recalcCost);
  recalcCost();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    const targetId = document.getElementById("target-id-input").value.trim();
    const level = Number(form.querySelector('input[name="level"]:checked').value);
    const quantity = Number(qtyInput.value);
    const submitBtn = form.querySelector("button");
    submitBtn.disabled = true;

    const { data } = await api("/api/bounties/create", { method: "POST", body: JSON.stringify({ targetId, level, quantity }) });
    submitBtn.disabled = false;

    if (!data.success) {
      errorBox.textContent = data.message || "Could not place bounty.";
      errorBox.hidden = false;
      return;
    }

    cacheNewOrder(data.order);
    renderPendingOrders();
    form.reset();
    recalcCost();
  });

  renderPendingOrders();
}

function renderPendingOrders() {
  const listEl = document.getElementById("pending-order-list");
  const totalBanner = document.getElementById("pending-total");
  if (!listEl) return;

  const cache = loadOrderCache();
  const entries = Object.values(cache.orders).sort((a, b) => a.firstSeenAt - b.firstSeenAt);

  const totalDue = entries
    .filter((o) => o.status === "pending_payment")
    .reduce((sum, o) => sum + Math.max(0, o.xanaxRequired - o.xanaxReceived), 0);

  if (totalDue > 0 && cache.receiver) {
    totalBanner.hidden = false;
    document.getElementById("pending-total-amount").textContent = totalDue;
    const link = document.getElementById("pending-total-receiver-link");
    link.textContent = `${cache.receiver.name} [${cache.receiver.id}]`;
    link.href = `https://www.torn.com/profiles.php?XID=${cache.receiver.id}`;
  } else {
    totalBanner.hidden = true;
  }

  listEl.innerHTML = "";
  for (const order of entries) listEl.appendChild(buildPendingOrderCard(order));
}

function buildPendingOrderCard(order) {
  const tpl = document.getElementById("tpl-pending-order-card");
  const node = tpl.content.cloneNode(true);
  const article = node.querySelector("[data-status]");
  article.dataset.status = order.status;
  article.dataset.orderId = order.id;

  node.querySelector("[data-target]").textContent =
    `${order.targetUserName} [${order.targetUserID}] — Level ${order.bountyLevel} × ${order.quantity}`;

  const remaining = Math.max(0, order.xanaxRequired - order.xanaxReceived);
  const body = node.querySelector("[data-body]");
  if (order.status === "pending_payment") {
    body.textContent = order.xanaxReceived > 0
      ? `${remaining} Xanax still needed (${order.xanaxReceived} of ${order.xanaxRequired} received).`
      : `${order.xanaxRequired} Xanax needed with the message "bounty".`;
    const countdown = node.querySelector("[data-countdown]");
    countdown.hidden = false;
    countdown.dataset.expiresAt = order.expiresAt;
    countdown.textContent = formatCountdown(order.expiresAt);
  } else if (order.status === "active") {
    body.textContent = "Payment confirmed — this bounty is now live on the board.";
  } else if (order.status === "expired") {
    body.textContent = order.xanaxReceived > 0
      ? `Payment window expired with only ${order.xanaxReceived} of ${order.xanaxRequired} Xanax received.`
      : "Payment window expired — no payment was received.";
    node.querySelector("[data-hint]").hidden = order.xanaxReceived === 0;
  }

  node.querySelector('[data-action="dismiss"]').addEventListener("click", () => dismissOrder(order.id));
  return node;
}

function formatCountdown(expiresAt) {
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) return "expired";
  const mins = Math.floor(remainingMs / 60000);
  const secs = Math.floor((remainingMs % 60000) / 1000);
  return `${mins}:${String(secs).padStart(2, "0")} remaining`;
}

function renderCountdownsOnly() {
  document.querySelectorAll("[data-countdown][data-expires-at]").forEach((el) => {
    el.textContent = formatCountdown(Number(el.dataset.expiresAt));
  });
}

async function loadAdmin() {
  const list = document.getElementById("admin-list");
  list.innerHTML = "<p class=\"empty-state\">Loading…</p>";
  const { data } = await api("/api/admin/payouts");
  if (!data.success) {
    list.innerHTML = `<p class="empty-state">${escapeHtml(data.message || "Could not load payouts.")}</p>`;
    return;
  }
  if (data.claimants.length === 0) {
    list.innerHTML = "<p class=\"empty-state\">Nothing outstanding.</p>";
    return;
  }
  list.innerHTML = "";
  for (const claimant of data.claimants) list.appendChild(buildClaimantCard(claimant));
}

function buildClaimantCard(claimant) {
  const tpl = document.getElementById("tpl-admin-claimant");
  const node = tpl.content.cloneNode(true);
  const link = node.querySelector("[data-claimant-link]");
  link.textContent = `${claimant.claimantUserName} [${claimant.claimantUserID}]`;
  link.href = `https://www.torn.com/profiles.php?XID=${claimant.claimantUserID}`;
  node.querySelector("[data-total]").textContent = fmtMoney(claimant.totalDue);

  const rows = node.querySelector("[data-rows]");
  for (const b of claimant.bounties) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(b.targetUserName)} <span class="mono">[${b.targetUserID}]</span></td>
      <td>L${b.bountyLevel}</td>
      <td class="mono">${fmtMoney(b.payoutAmount)}</td>
      <td></td>`;
    rows.appendChild(tr);
  }

  const markPaidBtn = node.querySelector('[data-action="mark-paid"]');
  markPaidBtn.addEventListener("click", async () => {
    if (!confirm(`Mark ${claimant.bounties.length} bounty payout(s) for ${claimant.claimantUserName} as paid? This cannot be undone automatically.`)) return;
    const reason = prompt("Reason / note for the audit log (optional):") || "";
    markPaidBtn.disabled = true;
    const bountyIds = claimant.bounties.map((b) => b.id);
    const { data } = await api("/api/admin/mark-paid", { method: "POST", body: JSON.stringify({ bountyIds, reason }) });
    if (data.success) {
      loadAdmin();
    } else {
      alert(data.message || "Could not mark as paid.");
      markPaidBtn.disabled = false;
    }
  });

  return node;
}

async function loadLog() {
  const list = document.getElementById("log-list");
  list.innerHTML = "<p class=\"empty-state\">Loading…</p>";
  const { data } = await api("/api/admin/log");
  if (!data.success) {
    list.innerHTML = `<p class="empty-state">${escapeHtml(data.message || "Could not load the log.")}</p>`;
    return;
  }
  if (data.entries.length === 0) {
    list.innerHTML = "<p class=\"empty-state\">Nothing recorded yet.</p>";
    return;
  }
  list.innerHTML = "";
  for (const entry of data.entries) list.appendChild(buildLogRow(entry));
}

function buildLogRow(entry) {
  const row = document.createElement("div");
  row.className = "log-row";
  const time = entry.time ? new Date(entry.time).toLocaleString() : "unknown time";
  const details = Object.entries(entry)
    .filter(([k]) => k !== "type" && k !== "time")
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("  ");
  row.innerHTML = `<span class="log-time">${escapeHtml(time)}</span><span class="log-type">${escapeHtml(entry.type || "EVENT")}</span>${escapeHtml(details)}`;
  return row;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

function restoreViewOrDefault() {
  let stored;
  try { stored = localStorage.getItem(VIEW_STORAGE_KEY); } catch { stored = null; }
  if (!stored || !VALID_VIEWS.has(stored)) return "bounties";
  if (ADMIN_ONLY_VIEWS.has(stored) && !(state.user && state.user.isAdmin)) return "bounties";
  return stored;
}

document.getElementById("logout-btn").addEventListener("click", handleLogout);

(async function boot() {
  const { data } = await api("/api/me");
  state.user = data.user || null;
  updateChrome();
  render(state.user ? restoreViewOrDefault() : "login");
})();
