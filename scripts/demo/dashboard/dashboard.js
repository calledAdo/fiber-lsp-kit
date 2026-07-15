const ui = {
  content: document.querySelector("#dashboard"),
  title: document.querySelector("#view-title"),
  eyebrow: document.querySelector("#view-eyebrow"),
  subtitle: document.querySelector("#view-subtitle"),
  viewState: document.querySelector("#view-state"),
  scenario: document.querySelector("#scenario-label"),
  dot: document.querySelector("#connection-dot"),
  refreshStatus: document.querySelector("#refresh-status"),
  refreshTime: document.querySelector("#refresh-time"),
  hostedNotice: document.querySelector("[data-hosted-notice]"),
  controlScope: document.querySelector("#control-scope"),
  observerScope: document.querySelector("#observer-scope"),
  observerCopy: document.querySelector("#observer-copy"),
  templates: {
    merchant: document.querySelector("#merchant-action-template"),
    regular: document.querySelector("#regular-action-template"),
    customer: document.querySelector("#customer-action-template"),
    rent: document.querySelector("#rent-action-template"),
  },
};

let selectedView = "merchant";
let snapshot;
let refreshing = false;
let initialMerchantChannels;
let renderedSignature;
let localActivity;
let createdInvoice;
let createdInvoiceKind;
let observedResetAt;
const drafts = {
  amount: "",
  capacity: "",
  regularAmount: "",
  invoice: undefined,
  paymentKind: "jit",
  channelId: "",
  periods: "3",
};

const headings = {
  overview: ["Network", "Node overview", "Configured Fiber roles and asset liquidity."],
  customer: ["Node", "Customer", "Direct payment capacity to the hold node."],
  merchant: ["Node", "Merchant", "JIT channel state and received liquidity."],
  lsp: ["Operator", "LSP nodes", "Hold and payment liquidity operated by the provider."],
  checkout: ["Flow", "Atomic checkout", "Latest JIT order milestones."],
  payments: ["Flow", "Repeat payments", "Regular invoices routed over provisioned liquidity."],
  rent: ["Flow", "Channel rent", "Live pricing bound to the settled merchant channel."],
};

const actionEndpoints = {
  invoice: "/api/actions/invoice",
  pay: "/api/actions/pay",
  "regular-invoice": "/api/actions/regular-invoice",
  "regular-pay": "/api/actions/regular-pay",
  rent: "/api/actions/rent",
  reset: "/api/actions/reset",
};

const actionMessages = {
  invoice: { running: "Building proof and creating the hold invoice", success: "Hold invoice ready" },
  pay: { running: "Payment submitted; waiting for atomic settlement", success: "Atomic checkout settled" },
  "regular-invoice": { running: "Checking merchant inbound and creating a regular invoice", success: "Regular invoice ready" },
  "regular-pay": { running: "Checking the route and waiting for merchant confirmation", success: "Regular payment settled" },
  rent: { running: "Pricing remaining inbound and paying rent", success: "Rent payment complete" },
  reset: { running: "Resetting the shared simulation", success: "Simulation reset" },
};

function clearDemoDrafts() {
  initialMerchantChannels = undefined;
  renderedSignature = undefined;
  localActivity = undefined;
  createdInvoice = undefined;
  createdInvoiceKind = undefined;
  Object.assign(drafts, {
    amount: "",
    capacity: "",
    regularAmount: "",
    invoice: undefined,
    paymentKind: "jit",
    channelId: "",
    periods: "3",
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function short(value) {
  const text = String(value ?? "");
  return text.length > 25 ? `${text.slice(0, 13)}...${text.slice(-8)}` : text || "-";
}

function titleCase(value) {
  return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function amount(value) {
  if (value === undefined || value === null) return "-";
  const decimals = Number(snapshot?.scenario.asset.decimals ?? 0);
  const scale = 10n ** BigInt(decimals);
  const raw = BigInt(value);
  const sign = raw < 0n ? "-" : "";
  const absolute = raw < 0n ? -raw : raw;
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""} ${snapshot.scenario.asset.symbol}`;
}

function metric(label, value, note = "", positive = false) {
  return `<div class="metric">
    <div class="metric-label">${escapeHtml(label)}</div>
    <div class="metric-value">${escapeHtml(value)}</div>
    ${note ? `<div class="metric-note${positive ? " is-positive" : ""}">${escapeHtml(note)}</div>` : ""}
  </div>`;
}

function actionTemplate(name) {
  return ui.templates[name].innerHTML;
}

function currentActivity(kind) {
  if (localActivity?.kind === kind) return localActivity;
  return snapshot?.activity?.kind === kind ? snapshot.activity : undefined;
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function activityElapsed(activity, now = Date.now()) {
  const started = Date.parse(activity.startedAt ?? "");
  if (!Number.isFinite(started)) return activity.elapsedMs;
  const finished = Date.parse(activity.finishedAt ?? "");
  return Math.max(0, (Number.isFinite(finished) ? finished : now) - started);
}

function activityFeedbackContent(activity) {
  const label = activity.status === "running" ? "Running" : activity.status === "success" ? "Completed" : "Failed";
  const elapsed = activityElapsed(activity);
  return `<strong class="action-feedback-state">${label}</strong>
    <span class="action-feedback-message">${escapeHtml(activity.message ?? activity.status)}</span>
    <time data-action-timer data-started-at="${escapeHtml(activity.startedAt ?? "")}" data-finished-at="${escapeHtml(activity.finishedAt ?? "")}">${elapsed === undefined ? "" : formatElapsed(elapsed)}</time>`;
}

function updateActionTimers(now = Date.now()) {
  for (const timer of document.querySelectorAll("[data-action-timer]")) {
    const started = Date.parse(timer.dataset.startedAt ?? "");
    if (!Number.isFinite(started)) continue;
    const finished = Date.parse(timer.dataset.finishedAt ?? "");
    timer.textContent = formatElapsed((Number.isFinite(finished) ? finished : now) - started);
  }
}

function activityMarkup(kind) {
  const activity = currentActivity(kind);
  if (!activity || activity.status === "idle") return "";
  const className = activity.status === "running"
    ? "is-running"
    : activity.status === "success"
      ? "is-success"
      : "is-error";
  return `<div class="action-feedback ${className}">${activityFeedbackContent(activity)}</div>`;
}

function statusChip(ok, readyText = "Ready", pendingText = "Pending") {
  return `<span class="status-chip${ok ? "" : " is-warning"}">${ok ? readyText : pendingText}</span>`;
}

function roleLabel(role) {
  if (role === "lsp") return "LSP";
  if (role === "hold") return "Hold node";
  if (role === "payment") return "Payment node";
  return titleCase(role);
}

function nodeSummaryRows(nodes) {
  return Object.entries(nodes).map(([role, node]) => `<tr>
    <td><span class="role-name">${escapeHtml(roleLabel(role))}</span><span class="mono">${escapeHtml(short(node.pubkey))}</span></td>
    <td>${statusChip(true, "Online")}</td>
    <td class="number">${node.peerCount}</td>
    <td class="number">${node.assetTotals.readyChannels}</td>
    <td class="number">${escapeHtml(amount(node.assetTotals.totalOutbound))}</td>
    <td class="number">${escapeHtml(amount(node.assetTotals.totalInbound))}</td>
  </tr>`).join("");
}

function nodeTable(nodes) {
  return `<section class="panel panel-scroll">
    <div class="panel-header"><h2>Configured nodes</h2><span class="panel-meta">${Object.keys(nodes).length} roles</span></div>
    <table class="node-table">
      <thead><tr><th style="width:28%">Role</th><th>Status</th><th>Peers</th><th>Channels</th><th>Outbound</th><th>Inbound</th></tr></thead>
      <tbody>${nodeSummaryRows(nodes)}</tbody>
    </table>
  </section>`;
}

function channelRail(channel) {
  const local = BigInt(channel.localBalance);
  const remote = BigInt(channel.remoteBalance);
  const capacity = local + remote;
  const localWidth = capacity > 0n ? Number((local * 10_000n) / capacity) / 100 : 0;
  return `<div class="channel-balance">
    <div class="balance-rail" title="Local versus remote channel balance">
      <span class="balance-local" style="width:${Math.max(0, Math.min(100, localWidth))}%"></span>
      <span class="balance-remote"></span>
    </div>
    <div class="balance-labels">
      <span>Local <strong>${escapeHtml(amount(channel.localBalance))}</strong></span>
      <span>Remote <strong>${escapeHtml(amount(channel.remoteBalance))}</strong></span>
    </div>
  </div>`;
}

function channelsPanel(node, title = "Channels") {
  if (!node?.channels.length) {
    return `<section class="panel">
      <div class="panel-header"><h2>${escapeHtml(title)}</h2><span class="panel-meta">0 channels</span></div>
      <div class="empty-state"><div><strong>No channels</strong>The node currently reports no channel state.</div></div>
    </section>`;
  }
  return `<section class="panel">
    <div class="panel-header"><h2>${escapeHtml(title)}</h2><span class="panel-meta">${node.channels.length} total</span></div>
    <div class="channel-list">${node.channels.map((channel) => `<div class="channel-row">
      <div class="channel-title">
        <div><strong>${escapeHtml(short(channel.channelId))}</strong><div class="mono">peer ${escapeHtml(short(channel.peerPubkey))}</div></div>
        ${statusChip(channel.ready && channel.enabled, channel.enabled ? "Ready" : "Disabled", channel.state)}
      </div>
      ${channel.assetMatches ? channelRail(channel) : `<p class="mono">${escapeHtml(channel.asset)}</p>`}
    </div>`).join("")}</div>
  </section>`;
}

function renderOverview() {
  const nodes = snapshot.nodes;
  const readyChannels = Object.values(nodes).reduce((sum, node) => sum + node.assetTotals.readyChannels, 0);
  const customerLimit = nodes.customer?.focusPeer?.maxSingleChannelOutbound;
  const merchantChannels = nodes.merchant?.assetTotals.readyChannels ?? 0;
  ui.content.innerHTML = `<div class="metrics">
    ${metric("Node roles", String(Object.keys(nodes).length), snapshot.scenario.profile)}
    ${metric("Reported channels", String(readyChannels), "summed across node roles")}
    ${metric("Customer maximum", amount(customerLimit), "single direct channel")}
    ${metric("Merchant channels", String(merchantChannels), merchantChannels > initialMerchantChannels ? `changed from ${initialMerchantChannels}` : "current node state", merchantChannels > initialMerchantChannels)}
  </div>${nodeTable(nodes)}`;
  setViewState(true, "Nodes online");
}

function renderCustomer() {
  const node = snapshot.nodes.customer;
  if (!node) return renderMissing("Customer node is not configured for this scenario.");
  const focus = node.focusPeer;
  ui.content.innerHTML = `${actionTemplate("customer")}<div class="metrics">
    ${metric("Maximum payment", amount(focus?.maxSingleChannelOutbound), "largest ready direct channel")}
    ${metric("Path channels", String(focus?.readyChannels ?? 0), focus?.connected ? "hold peer connected" : "hold peer disconnected", Boolean(focus?.connected))}
    ${metric("Total outbound", amount(focus?.totalOutbound), snapshot.scenario.asset.symbol)}
    ${metric("Total inbound", amount(focus?.totalInbound), snapshot.scenario.asset.symbol)}
  </div>${channelsPanel(node, "Customer channels")}`;
  setViewState(Boolean(focus?.connected && focus?.readyChannels), focus?.connected ? "Payment ready" : "Path unavailable");
}

function renderMerchant() {
  const node = snapshot.nodes.merchant;
  if (!node) return renderMissing("Merchant node is not configured for this scenario.");
  const ready = node.assetTotals.readyChannels;
  const changed = ready > initialMerchantChannels;
  const transition = ready === 0
    ? "The merchant has no existing asset channel. A successful JIT checkout will add the funded channel here."
    : changed
      ? `JIT provisioning changed the merchant from ${initialMerchantChannels} to ${ready} ready channel${ready === 1 ? "" : "s"}.`
      : snapshot.checkout.channelId
        ? "The latest JIT order records this merchant channel as settled."
        : "Current channel state was read from the merchant Fiber node.";
  const regularAction = snapshot.scenario.mode === "linked" && BigInt(node.assetTotals.totalInbound) > 0n
    ? actionTemplate("regular")
    : "";
  ui.content.innerHTML = `${actionTemplate("merchant")}${regularAction}<div class="metrics">
    ${metric("Ready channels", String(ready), changed ? `changed from ${initialMerchantChannels} after JIT` : "current node state", changed)}
    ${metric("Outbound received", amount(node.assetTotals.totalOutbound), "merchant-side balance")}
    ${metric("Remaining inbound", amount(node.assetTotals.totalInbound), "rent pricing basis")}
    ${metric("Connected peers", String(node.peerCount), ready ? "channel peer reachable" : "waiting for provisioning")}
  </div>${channelsPanel(node, "Merchant channels")}<div class="transition-note">${escapeHtml(transition)}</div>`;
  setViewState(ready > 0, ready > 0 ? "Channel ready" : "JIT eligible");
}

function renderPayments() {
  if (snapshot.scenario.mode !== "linked") {
    ui.content.innerHTML = `<section class="panel"><div class="panel-header"><h2>Repeat payment route</h2><span class="panel-meta">Topology dependent</span></div><div class="empty-state"><div><strong>No guaranteed route</strong>The split hold and payment nodes do not have a required channel between them. Connect a routed path before using a regular merchant invoice.</div></div></section>`;
    setViewState(false, "Topology dependent");
    return;
  }
  const payment = snapshot.regularPayment;
  if (!payment) {
    ui.content.innerHTML = `<section class="panel"><div class="panel-header"><h2>Repeat payment</h2><span class="panel-meta">Not started</span></div><div class="empty-state"><div><strong>No regular invoice recorded</strong>Create one from the Merchant view after the JIT channel is ready.</div></div></section>`;
    setViewState(false, "Not started");
    return;
  }
  const routeChecked = payment.customerPaymentStatus === "Success" || payment.settled;
  ui.content.innerHTML = `<div class="metrics">
    ${metric("Amount", amount(payment.amount), "regular merchant invoice")}
    ${metric("Routing fee", amount(payment.fee), "reported by customer FNN")}
    ${metric("Settlement time", payment.elapsedMs === undefined ? "-" : `${payment.elapsedMs} ms`, "dispatch to merchant confirmation", payment.settled)}
    ${metric("Payment hash", short(payment.paymentHash), payment.merchantInvoiceStatus ?? "Open")}
  </div><section class="panel">
    <div class="panel-header"><h2>Regular payment lifecycle</h2><span class="panel-meta">existing channel</span></div>
    <div class="timeline">
      ${step(Boolean(payment.invoice), "Regular invoice created", "Merchant inbound was checked before the invoice was issued.")}
      ${step(routeChecked, "Route accepted", "The customer node found and priced a route without moving funds.")}
      ${step(payment.customerPaymentStatus === "Success", "Customer payment settled", "The existing customer and merchant channels carried the payment.")}
      ${step(payment.merchantInvoiceStatus === "Paid", "Merchant confirmed receipt", "The merchant node reports the invoice as Paid.")}
    </div>
  </section>`;
  setViewState(payment.settled, payment.settled ? "Settled" : "In progress");
}

function renderLsp() {
  const nodes = Object.fromEntries(Object.entries(snapshot.nodes).filter(([role]) => role !== "customer" && role !== "merchant"));
  const totalOutbound = Object.values(nodes).reduce((sum, node) => sum + BigInt(node.assetTotals.totalOutbound), 0n);
  const totalInbound = Object.values(nodes).reduce((sum, node) => sum + BigInt(node.assetTotals.totalInbound), 0n);
  const fundingRole = snapshot.scenario.mode === "same_hash" ? "payment" : "lsp";
  const onchain = nodes[fundingRole]?.onchainAsset;
  ui.content.innerHTML = `<div class="metrics">
    ${metric("Operated nodes", String(Object.keys(nodes).length), snapshot.scenario.mode === "same_hash" ? "hold and payment roles" : "combined hold and payment role")}
    ${metric("Ready channels", String(Object.values(nodes).reduce((sum, node) => sum + node.assetTotals.readyChannels, 0)), snapshot.scenario.asset.symbol)}
    ${metric("Total outbound", amount(totalOutbound), "available across LSP roles")}
    ${metric("Total inbound", amount(totalInbound), "received across LSP roles")}
    ${metric(`On-chain ${snapshot.scenario.asset.symbol}`, onchain?.amount === undefined ? "Unavailable" : amount(onchain.amount), onchain?.error ? "CKB indexer unavailable" : `confirmed ${roleLabel(fundingRole)} token cells; upper bound for a new channel`)}
  </div>${nodeTable(nodes)}${Object.entries(nodes).map(([role, node]) => channelsPanel(node, `${roleLabel(role)} channels`)).join("")}`;
  setViewState(true, "Operator ready");
}

function step(done, title, description) {
  return `<div class="timeline-step${done ? " is-complete" : ""}">
    <span class="step-marker">${done ? "✓" : "·"}</span>
    <div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p></div>
    <span class="step-status">${done ? "Complete" : "Waiting"}</span>
  </div>`;
}

function renderCheckout() {
  const checkout = snapshot.checkout;
  const merchantHasChannel = (snapshot.nodes.merchant?.assetTotals.readyChannels ?? 0) > initialMerchantChannels || Boolean(checkout.channelId);
  const acceptedLabel = snapshot.scenario.mode === "linked" ? "Linkage proof accepted" : "Same-hash order accepted";
  const acceptedDescription = snapshot.scenario.mode === "linked"
    ? "The LSP accepted the Groth16 linkage before issuing the hold invoice."
    : "The hold and payment nodes accepted one shared payment hash.";
  const settled = checkout.settled && checkout.customerPaymentStatus === "Success";
  const completed = [checkout.invoiceReady, checkout.invoiceReady, merchantHasChannel, settled].filter(Boolean).length;
  const active = snapshot.activity?.status === "running" ? activityMarkup(snapshot.activity.kind) : "";
  ui.content.innerHTML = `${active}<div class="metrics">
    ${metric("Progress", `${completed} / 4`, settled ? "atomic checkout complete" : "latest local demo state", settled)}
    ${metric("Payment hash", short(checkout.paymentHash), checkout.invoiceReady ? "hold invoice issued" : "not issued")}
    ${metric("Requested channel", amount(checkout.requestedCapacity), snapshot.scenario.asset.symbol)}
    ${metric("Settled channel", short(checkout.channelId), checkout.customerPaymentStatus ?? "pending")}
  </div><section class="panel">
    <div class="panel-header"><h2>Checkout lifecycle</h2><span class="panel-meta">${escapeHtml(snapshot.scenario.mode)}</span></div>
    <div class="timeline">
      ${step(checkout.invoiceReady, "Hold invoice created", "Customer-facing payment request is ready.")}
      ${step(checkout.invoiceReady, acceptedLabel, acceptedDescription)}
      ${step(merchantHasChannel, "Merchant channel opened", "The funded asset channel is visible on the merchant node.")}
      ${step(settled, "Atomic settlement", "Merchant payment succeeded and the customer payment completed.")}
    </div>
  </section>`;
  setViewState(settled, settled ? "Settled" : checkout.invoiceReady ? "In progress" : "Waiting");
}

function renderRent() {
  const rent = snapshot.rent;
  if (!rent) {
    ui.content.innerHTML = `${actionTemplate("rent")}<section class="panel"><div class="panel-header"><h2>Rent stream</h2><span class="panel-meta">No periods</span></div><div class="empty-state"><div><strong>No rent payment recorded</strong>Rent appears after a settled JIT channel is selected.</div></div></section>`;
    setViewState(false, "Not started");
    return;
  }
  ui.content.innerHTML = `${actionTemplate("rent")}<div class="metrics">
    ${metric("Bound channel", short(rent.channelId), "exact merchant channel")}
    ${metric("Periods paid", String(rent.periodsPaid ?? 0), "live-priced periods")}
    ${metric("Initial inbound", amount(rent.initialRent?.remainingInbound), "pricing basis")}
    ${metric("Total rent", amount(rent.totalPaid), snapshot.scenario.asset.symbol, Number(rent.periodsPaid) > 0)}
  </div><section class="panel">
    <div class="panel-header"><h2>Rent periods</h2><span class="panel-meta">${escapeHtml(short(rent.channelId))}</span></div>
    <div class="timeline">${(rent.payments ?? []).map((payment) => step(
      payment.status === "paid",
      `Period ${payment.period}`,
      payment.status === "paid"
        ? `${amount(payment.amount)} paid with ${amount(payment.remainingInbound)} inbound remaining.`
        : payment.reason ?? "Payment skipped.",
    )).join("")}</div>
  </section>`;
  setViewState(Number(rent.periodsPaid) > 0, Number(rent.periodsPaid) > 0 ? "Streaming" : "No payment");
}

function renderMissing(message) {
  ui.content.innerHTML = `<div class="error-panel">${escapeHtml(message)}</div>`;
  setViewState(false, "Unavailable", "error");
}

function setViewState(ok, text, forced) {
  ui.viewState.textContent = text;
  ui.viewState.className = `view-state${forced === "error" ? " is-error" : ok ? "" : " is-warning"}`;
}

function updateCounts() {
  const nodes = snapshot.nodes;
  const lspRoles = Object.keys(nodes).filter((role) => role !== "customer" && role !== "merchant");
  document.querySelector("#overview-count").textContent = String(Object.keys(nodes).length);
  document.querySelector("#customer-count").textContent = String(nodes.customer?.assetTotals.readyChannels ?? 0);
  document.querySelector("#merchant-count").textContent = String(nodes.merchant?.assetTotals.readyChannels ?? 0);
  document.querySelector("#lsp-count").textContent = String(lspRoles.length);
  document.querySelector("#checkout-count").textContent = snapshot.checkout.settled ? "OK" : snapshot.checkout.invoiceReady ? "..." : "-";
  document.querySelector("#payments-count").textContent = snapshot.regularPayment?.settled ? "OK" : snapshot.regularPayment?.invoice ? "..." : "-";
  document.querySelector("#rent-count").textContent = String(snapshot.rent?.periodsPaid ?? 0);
}

function hydrateControls() {
  for (const asset of ui.content.querySelectorAll("[data-asset]")) {
    asset.textContent = snapshot.scenario.asset.symbol;
  }
  const amountInput = ui.content.querySelector('[name="amount"]');
  const capacityInput = ui.content.querySelector('[name="capacity"]');
  const regularAmountInput = ui.content.querySelector('[name="regularAmount"]');
  if (amountInput) amountInput.value = drafts.amount;
  if (capacityInput) capacityInput.value = drafts.capacity;
  if (regularAmountInput) regularAmountInput.value = drafts.regularAmount;

  if (drafts.invoice === undefined) drafts.invoice = snapshot.checkout.invoice ?? "";
  const invoiceInput = ui.content.querySelector('[name="invoice"]');
  if (invoiceInput) invoiceInput.value = drafts.invoice;
  const maximum = ui.content.querySelector("[data-customer-maximum]");
  if (maximum) {
    maximum.textContent = drafts.paymentKind === "regular"
      ? "Checked by Fiber route dry-run"
      : amount(snapshot.nodes.customer?.focusPeer?.maxSingleChannelOutbound);
  }
  const paymentTitle = ui.content.querySelector("[data-payment-title]");
  const paymentLabel = ui.content.querySelector("[data-payment-route-label]");
  const paymentSubmit = ui.content.querySelector("[data-payment-submit]");
  const paymentForm = ui.content.querySelector("[data-payment-form]");
  const paymentFeedback = ui.content.querySelector('[data-action-feedback="pay"], [data-action-feedback="regular-pay"]');
  const paymentAction = drafts.paymentKind === "regular" ? "regular-pay" : "pay";
  if (paymentTitle) paymentTitle.textContent = drafts.paymentKind === "regular" ? "Pay regular invoice" : "Pay hold invoice";
  if (paymentLabel) paymentLabel.textContent = drafts.paymentKind === "regular" ? "Route validation" : "Maximum direct payment";
  if (paymentSubmit) paymentSubmit.textContent = drafts.paymentKind === "regular" ? "Pay regular invoice" : "Pay hold invoice";
  if (paymentForm) paymentForm.dataset.action = paymentAction;
  if (paymentFeedback) paymentFeedback.dataset.actionFeedback = paymentAction;
  const merchantInbound = ui.content.querySelector("[data-merchant-inbound]");
  if (merchantInbound) merchantInbound.textContent = amount(snapshot.nodes.merchant?.assetTotals.totalInbound);

  const channelSelect = ui.content.querySelector('[name="channelId"]');
  if (channelSelect) {
    const channels = (snapshot.nodes.merchant?.channels ?? []).filter((channel) => channel.ready && channel.enabled && channel.assetMatches);
    const preferred = drafts.channelId || snapshot.checkout.channelId || channels[0]?.channelId || "";
    channelSelect.innerHTML = channels.length
      ? channels.map((channel) => `<option value="${escapeHtml(channel.channelId)}">${escapeHtml(short(channel.channelId))} · ${escapeHtml(amount(channel.remoteBalance))} inbound</option>`).join("")
      : '<option value="">No ready merchant channel</option>';
    channelSelect.value = channels.some((channel) => channel.channelId === preferred) ? preferred : channels[0]?.channelId ?? "";
    drafts.channelId = channelSelect.value;
  }
  const periodsInput = ui.content.querySelector('[name="periods"]');
  if (periodsInput) periodsInput.value = drafts.periods;

  for (const feedback of ui.content.querySelectorAll("[data-action-feedback]")) {
    const activity = currentActivity(feedback.dataset.actionFeedback);
    if (!activity || activity.status === "idle") continue;
    feedback.hidden = false;
    feedback.className = `action-feedback ${activity.status === "running" ? "is-running" : activity.status === "success" ? "is-success" : "is-error"}`;
    feedback.innerHTML = activityFeedbackContent(activity);
  }

  for (const invoiceResult of ui.content.querySelectorAll("[data-invoice-result]")) {
    const kind = invoiceResult.dataset.invoiceKind;
    const invoice = createdInvoiceKind === kind
      ? createdInvoice
      : kind === "regular"
        ? snapshot.regularPayment?.invoice
        : snapshot.checkout.invoice;
    if (invoice) {
      invoiceResult.hidden = false;
      invoiceResult.querySelector("[data-created-invoice]").value = invoice;
    }
  }

  const running = localActivity?.status === "running" || snapshot.activity?.status === "running";
  for (const button of ui.content.querySelectorAll('button[type="submit"]')) button.disabled = running;
}

function render() {
  const [eyebrow, title, subtitle] = headings[selectedView];
  ui.eyebrow.textContent = eyebrow;
  ui.title.textContent = title;
  ui.subtitle.textContent = subtitle;
  const renderers = {
    overview: renderOverview,
    customer: renderCustomer,
    merchant: renderMerchant,
    lsp: renderLsp,
    checkout: renderCheckout,
    payments: renderPayments,
    rent: renderRent,
  };
  renderers[selectedView]();
  updateCounts();
  hydrateControls();
}

function snapshotSignature(value) {
  const { generatedAt: _generatedAt, ...stable } = value;
  return JSON.stringify(stable);
}

function isEditing() {
  return Boolean(document.activeElement?.matches("input, textarea, select"));
}

async function refresh({ force = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    const signature = snapshotSignature(body);
    snapshot = body;
    const resetAt = snapshot.activity?.kind === "reset" && snapshot.activity.status === "success"
      ? snapshot.activity.finishedAt
      : undefined;
    if (resetAt && resetAt !== observedResetAt) {
      observedResetAt = resetAt;
      clearDemoDrafts();
    }
    if (initialMerchantChannels === undefined) {
      initialMerchantChannels = snapshot.nodes.merchant?.assetTotals.readyChannels ?? 0;
    }
    ui.scenario.textContent = `${titleCase(snapshot.scenario.mode)} · ${snapshot.scenario.profile} · ${snapshot.scenario.asset.symbol}`;
    const hosted = snapshot.deployment?.hosted === true;
    ui.hostedNotice.hidden = !hosted;
    ui.controlScope.textContent = hosted ? "Shared simulation" : "Local controls";
    ui.observerScope.textContent = hosted ? "MOCK" : "LOCAL";
    ui.observerCopy.textContent = hosted
      ? "Simulated FNN transport; no keys or funds"
      : "Shared CLI operations; no private keys in browser";
    ui.dot.className = "status-dot is-live";
    ui.refreshStatus.textContent = "Node snapshot current";
    ui.refreshTime.textContent = new Date(snapshot.generatedAt).toLocaleTimeString();
    ui.refreshTime.dateTime = snapshot.generatedAt;
    if (force || (!isEditing() && signature !== renderedSignature)) {
      render();
      renderedSignature = signature;
    } else {
      updateCounts();
    }
  } catch (error) {
    ui.dot.className = "status-dot is-error";
    ui.refreshStatus.textContent = error instanceof Error ? error.message : String(error);
    if (!snapshot) {
      ui.content.innerHTML = `<div class="error-panel">Unable to read the configured Fiber nodes. ${escapeHtml(ui.refreshStatus.textContent)}</div>`;
      setViewState(false, "Unavailable", "error");
    }
  } finally {
    refreshing = false;
  }
}

function selectView(view) {
  selectedView = view;
  for (const candidate of document.querySelectorAll("[data-view]")) {
    const active = candidate.dataset.view === view;
    candidate.classList.toggle("is-active", active);
    if (active) candidate.setAttribute("aria-current", "page");
    else candidate.removeAttribute("aria-current");
  }
  if (snapshot) render();
}

async function postAction(kind, body) {
  const startedAt = new Date().toISOString();
  localActivity = {
    kind,
    status: "running",
    startedAt,
    finishedAt: undefined,
    message: actionMessages[kind]?.running ?? "Running action",
  };
  render();
  try {
    const response = await fetch(actionEndpoints[kind], {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-action": "1" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    if (kind === "invoice" || kind === "regular-invoice") {
      createdInvoice = payload.result.invoice;
      createdInvoiceKind = kind === "invoice" ? "jit" : "regular";
      drafts.invoice = payload.result.invoice;
      drafts.paymentKind = createdInvoiceKind;
    }
    localActivity = {
      kind,
      status: "success",
      startedAt,
      finishedAt: new Date().toISOString(),
      message: actionMessages[kind]?.success ?? "Action complete",
    };
    await refresh({ force: true });
    return payload.result;
  } catch (error) {
    localActivity = {
      kind,
      status: "error",
      startedAt,
      finishedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    };
    render();
    return undefined;
  }
}

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => {
    selectView(button.dataset.view);
  });
}

document.addEventListener("input", (event) => {
  const name = event.target.name;
  if (name && name in drafts) drafts[name] = event.target.value;
});

document.addEventListener("change", (event) => {
  const name = event.target.name;
  if (name && name in drafts) drafts[name] = event.target.value;
});

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-action]");
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.action;
  if (kind === "invoice") {
    await postAction("invoice", { amount: drafts.amount, capacity: drafts.capacity });
  } else if (kind === "regular-invoice") {
    await postAction("regular-invoice", { amount: drafts.regularAmount });
  } else if (kind === "pay") {
    await postAction("pay", { invoice: drafts.invoice });
  } else if (kind === "regular-pay") {
    await postAction("regular-pay", { invoice: drafts.invoice });
  } else if (kind === "rent") {
    await postAction("rent", { channelId: drafts.channelId, periods: Number(drafts.periods) });
  }
});

document.addEventListener("click", async (event) => {
  const reset = event.target.closest('[data-action="reset"]');
  if (reset) {
    reset.disabled = true;
    reset.textContent = "Resetting...";
    const result = await postAction("reset", {});
    if (result) {
      clearDemoDrafts();
      selectView("merchant");
    }
    reset.disabled = false;
    reset.textContent = result ? "Reset complete" : "Reset demo";
  }
  const go = event.target.closest("[data-go]");
  if (go) {
    const result = go.closest("[data-invoice-result]");
    if (go.dataset.paymentKind) drafts.paymentKind = go.dataset.paymentKind;
    const invoice = result?.querySelector("[data-created-invoice]")?.value;
    if (invoice) drafts.invoice = invoice;
    selectView(go.dataset.go);
  }
  const copy = event.target.closest("[data-copy-invoice]");
  if (copy) {
    const invoice = copy.closest("[data-invoice-result]")?.querySelector("[data-created-invoice]")?.value;
    if (invoice) {
      await navigator.clipboard.writeText(invoice);
      copy.textContent = "Copied";
    }
  }
});

await refresh();
setInterval(refresh, 1_000);
setInterval(updateActionTimers, 1_000);
