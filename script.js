// Bounty Guild frontend. Deployed on GitHub Pages, calling out to the
// Cloudflare Worker as a separate API origin (credentials: "include" so
// the session cookie rides along cross-site). Holds no secrets — the
// session lives in an HttpOnly cookie this script can never read.

const API_BASE = "https://bountyguild.deviyl.workers.dev";

const state = { user: null, pollTimer: null };

const $app = document.getElementById("app");
const $topbar = document.getElementById("topbar");
const $nav = document.getElementById("nav");
const $identity = document.getElementById("identity");

const BOUNTY_COSTS = { 1: 4, 2: 6, 3: 8 };

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

// ---------------------------------------------------------------------
// Routing / view rendering
// ---------------------------------------------------------------------

function render(viewName) {
  // The URL never changes — this is a single-page app that only ever
  // lives at one address. View state is tracked purely in memory.
  $app.innerHTML = "";
  const tpl = document.getElementById(`tpl-${viewName}`);
  $app.appendChild(tpl.content.cloneNode(true));

  document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === viewName));

  if (viewName === "login") wireLogin();
  if (viewName === "bounties") loadBounties();
  if (viewName === "place-bounty") wirePlaceBounty();
  if (viewName === "admin") loadAdmin();
}

function renderNav() {
  $nav.innerHTML = "";
  const items = [
    { id: "bounties", label: "Bounties" },
    { id: "place-bounty", label: "Place bounty" },
  ];
  if (state.user && state.user.isAdmin) items.push({ id: "admin", label: "Admin" });

  for (const item of items) {
    const btn = document.createElement("button");
    btn.textContent = item.label;
    btn.dataset.view = item.id;
    btn.addEventListener("click", () => render(item.id));
    $nav.appendChild(btn);
  }
  const logout = document.createElement("button");
  logout.textContent = "Logout";
  logout.addEventListener("click", handleLogout);
  $nav.appendChild(logout);
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

// ---------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------

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
    render("bounties");
  });
}

async function handleLogout() {
  await api("/api/logout", { method: "POST" });
  state.user = null;
  updateChrome();
  render("login");
}

// ---------------------------------------------------------------------
// Bounties
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// Place bounty
// ---------------------------------------------------------------------

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
    showPendingOrder(data.order);
  });
}

function showPendingOrder(order) {
  const panel = document.getElementById("pending-order");
  panel.hidden = false;
  document.getElementById("pending-amount").textContent = order.xanaxRequired;
  const link = document.getElementById("pending-receiver-link");
  link.textContent = `${order.receiver.name} [${order.receiver.id}]`;
  link.href = `https://www.torn.com/profiles.php?XID=${order.receiver.id}`;

  if (state.pollTimer) clearInterval(state.pollTimer);
  const countdownEl = document.getElementById("pending-countdown");

  function tick() {
    const remainingMs = order.expiresAt - Date.now();
    if (remainingMs <= 0) {
      countdownEl.textContent = "expired";
      clearInterval(state.pollTimer);
      return;
    }
    const mins = Math.floor(remainingMs / 60000);
    const secs = Math.floor((remainingMs % 60000) / 1000);
    countdownEl.textContent = `${mins}:${String(secs).padStart(2, "0")}`;
  }
  tick();
  state.pollTimer = setInterval(tick, 1000);
}

// ---------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

(async function boot() {
  const { data } = await api("/api/me");
  state.user = data.user || null;
  updateChrome();
  render(state.user ? "bounties" : "login");
})();
