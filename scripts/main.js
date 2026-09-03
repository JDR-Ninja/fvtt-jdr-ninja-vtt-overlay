/**
 * JDR Ninja VTT Overlay, a Foundry VTT v14 module.
 *
 * Hooks the table's dice rolls (`createChatMessage`) and forwards each PUBLIC roll's
 * exact pre-rolled result to JDR Ninja, which REPLAYS it (never re-rolls) on a
 * transparent OBS overlay.
 *
 * Design rules honored here (see the implementation brief):
 *  - Replay, do NOT re-roll: we send formula + per-die faces + total; the server animates them.
 *  - Every setting is `client` scope. No world settings. The relay is elected purely by
 *    "does this browser hold the streaming token" + the local relay toggle. No GM check.
 *  - Hidden rolls (gmroll / blindroll / selfroll) are filtered by `whisper`/`blind`,
 *    NEVER by `isContentVisible` (which is true for a GM even on secret rolls).
 *  - Works with or without Dice So Nice. When DSN is present we dispatch on its animation
 *    start (id-matched, persistent hook + ~2s safety fallback); otherwise we POST immediately.
 *  - Dice So Nice appearance pass-through is a copyright-safe SUBSET (colors + material/font
 *    NAMES only) read from the ROLLER's flags. Never DSN textures/meshes/colorset tables.
 *  - Free to install and pair; relaying real rolls requires a paid JDR Ninja plan (server-enforced).
 */

const MODULE_ID = "jdr-ninja-vtt-overlay";
const I18N = "JDRNINJA_VTT_OVERLAY";

/** Persistent hook only needs to fire the fallback if DSN never starts this roll. */
const DSN_FALLBACK_MS = 2000;

/** Minimum gap between two `lastSuccessAt` writes (see recordSuccess). */
const SUCCESS_STAMP_THROTTLE_MS = 60_000;

/** Setting keys (all client scope). */
const S = Object.freeze({
  baseUrl: "baseUrl",
  deviceToken: "deviceToken",
  relayEnabled: "relayEnabled",
  forwardFilter: "forwardFilter",
  lastSuccessAt: "lastSuccessAt",
  lastErrorAt: "lastErrorAt",
  lastError: "lastError"
});

/** Forward-filter values. */
const FILTER = Object.freeze({ allPublic: "allPublic", playersOnly: "playersOnly" });

/* ------------------------------------------------------------------ */
/* i18n helpers                                                        */
/* ------------------------------------------------------------------ */

const L = (key) => game.i18n.localize(`${I18N}.${key}`);
const Fmt = (key, data) => game.i18n.format(`${I18N}.${key}`, data);

/* ------------------------------------------------------------------ */
/* Settings accessors                                                  */
/* ------------------------------------------------------------------ */

function getBaseUrl() {
  return String(game.settings.get(MODULE_ID, S.baseUrl) || "").trim().replace(/\/+$/, "");
}
function getToken() {
  return String(game.settings.get(MODULE_ID, S.deviceToken) || "").trim();
}
function getRelayToggle() {
  return game.settings.get(MODULE_ID, S.relayEnabled) === true;
}
function getForwardFilter() {
  return game.settings.get(MODULE_ID, S.forwardFilter) || FILTER.allPublic;
}

/** This browser relays iff it holds a device token AND the local relay toggle is on. */
function thisClientRelays() {
  return getToken().length > 0 && getRelayToggle();
}

/**
 * `lastSuccessAt` only exists to render "last successful test: <when>" in the panel, so it does not
 * need per-roll precision. Client-scope settings write to localStorage synchronously; stamping every
 * relayed roll would mean one write per die roll at a busy table. Throttle to one write a minute.
 */
let lastSuccessWrittenAt = 0;
async function recordSuccess() {
  const now = Date.now();
  if (now - lastSuccessWrittenAt < SUCCESS_STAMP_THROTTLE_MS) return;
  lastSuccessWrittenAt = now;
  await game.settings.set(MODULE_ID, S.lastSuccessAt, now);
}

/** Force the next recordSuccess() through the throttle (the panel's test buttons want it immediate). */
function resetSuccessThrottle() {
  lastSuccessWrittenAt = 0;
}
async function recordError(message) {
  await game.settings.set(MODULE_ID, S.lastError, String(message ?? "").slice(0, 400));
  await game.settings.set(MODULE_ID, S.lastErrorAt, Date.now());
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const isHex = (v) => typeof v === "string" && HEX_RE.test(v.trim());

/** Flavor is HTML; the overlay wants plain text (it HTML-encodes on its side). */
function stripHtml(html) {
  if (!html) return "";
  try {
    // Parse into an inert document (no scripts run, no resource loads) rather than assigning to a
    // live element's innerHTML, where `<img src=x onerror=...>` executes even when detached (L21).
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    return (doc.body.textContent || "").trim();
  } catch {
    return String(html).replace(/<[^>]*>/g, "").trim();
  }
}

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function defaultDeviceName() {
  const world = game.world?.title || "Foundry";
  // Localized: this name is sent to the server and listed on the user's JDR Ninja device page.
  let browser = L("misc.browserFallback");
  try {
    const ua = navigator.userAgent || "";
    if (/edg/i.test(ua)) browser = "Edge";
    else if (/chrome/i.test(ua)) browser = "Chrome";
    else if (/firefox/i.test(ua)) browser = "Firefox";
    else if (/safari/i.test(ua)) browser = "Safari";
  } catch { /* ignore */ }
  return `Foundry ${browser} (${world})`.slice(0, 120);
}

/* ------------------------------------------------------------------ */
/* Dice So Nice appearance pass-through (cosmetic, copyright-safe subset)*/
/* ------------------------------------------------------------------ */

/**
 * Read the ROLLER's (message.author) DSN appearance flags and forward ONLY a safe subset:
 * hex colors + material/font NAMES (hints). Never textures, meshes or DSN colorset tables.
 * Defensive: any missing/odd shape -> return undefined so the overlay uses the brand theme.
 */
function extractAppearance(author) {
  try {
    if (!author) return undefined;
    // Prefer the documented API; fall back to the raw flag object.
    let dsn;
    if (typeof author.getFlag === "function") {
      dsn = author.getFlag("dice-so-nice", "appearance");
    }
    if (!dsn) {
      dsn = foundry.utils.getProperty(author, "flags.dice-so-nice.appearance");
    }
    if (!dsn || typeof dsn !== "object") return undefined;

    // DSN stores a per-die map with a `global` key; older shapes are flat.
    const a = (dsn.global && typeof dsn.global === "object") ? dsn.global : dsn;
    if (!a || typeof a !== "object") return undefined;

    const appearance = {};
    // DSN: background = dice color, foreground = label color.
    if (isHex(a.background)) appearance.diceColor = a.background.trim();
    if (isHex(a.foreground)) appearance.labelColor = a.foreground.trim();
    if (isHex(a.outline)) appearance.outlineColor = a.outline.trim();
    if (isHex(a.edge)) appearance.edgeColor = a.edge.trim();
    // NAME-only hints (never DSN shaders/env-maps/textures).
    if (typeof a.material === "string" && a.material && a.material !== "auto" && a.material !== "none") {
      appearance.material = a.material;
    }
    if (typeof a.font === "string" && a.font && a.font !== "auto") {
      appearance.font = a.font;
    }

    return Object.keys(appearance).length > 0 ? appearance : undefined;
  } catch (err) {
    console.warn(`${MODULE_ID} | appearance read failed`, err);
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Roll extraction (generic, system-agnostic, NO game-system flags)   */
/* ------------------------------------------------------------------ */

function resolveRoller(message) {
  const speaker = message.speaker;
  if (speaker?.actor) {
    const actor = game.actors?.get(speaker.actor);
    if (actor?.name) return actor.name;
  }
  if (speaker?.alias) return speaker.alias;
  if (message.author?.name) return message.author.name;
  return L("misc.unknownRoller");
}

/** Build the device-token API POST body from core fields only. Returns null if no dice. */
function buildPayload(message) {
  const rolls = message.rolls ?? [];
  const dice = [];
  for (const roll of rolls) {
    for (const term of (roll.dice ?? [])) {
      dice.push({
        faces: term.faces,
        results: (term.results ?? []).map((r) => r.result)
      });
    }
  }
  if (dice.length === 0) return null;

  const total = rolls.reduce((sum, r) => sum + (r.total ?? 0), 0);
  const formula = rolls.map((r) => r.formula).filter(Boolean).join(" + ");
  const label = stripHtml(message.flavor);
  const roller = resolveRoller(message);
  const appearance = extractAppearance(message.author);

  const payload = {
    rollId: message.id,
    formula,
    total,
    dice,
    label,
    roller
  };
  if (appearance) payload.appearance = appearance;
  return payload;
}

/* ------------------------------------------------------------------ */
/* HTTP: roll ingest, diagnostics, device flow                         */
/* ------------------------------------------------------------------ */

async function postRoll(payload) {
  const baseUrl = getBaseUrl();
  const token = getToken();
  if (!baseUrl || !token) {
    await recordError(L("diag.configuration.broken"));
    return { ok: false, status: 0 };
  }
  try {
    const res = await fetch(`${baseUrl}/api/vtt-overlay/foundry/rolls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      await recordError(`HTTP ${res.status}`);
      return { ok: false, status: res.status };
    }
    await recordSuccess();
    return { ok: true, status: res.status };
  } catch (err) {
    await recordError(String(err?.message ?? err));
    return { ok: false, status: 0, error: err };
  }
}

/**
 * GET the diagnostics snapshot (locale-neutral machine codes/booleans).
 * Returns a discriminated result the panel maps to localized checklist rows.
 */
async function fetchDiagnostics() {
  const baseUrl = getBaseUrl();
  const token = getToken();
  if (!baseUrl || !token) return { kind: "unconfigured" };
  try {
    const res = await fetch(`${baseUrl}/api/vtt-overlay/foundry/diagnostics`, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`
      }
    });
    if (res.status === 401 || res.status === 403) return { kind: "unauthorized", httpStatus: res.status };
    if (!res.ok) return { kind: "httpError", httpStatus: res.status };
    const data = await res.json();
    return { kind: "ok", data };
  } catch (err) {
    return { kind: "network", error: String(err?.message ?? err) };
  }
}

/**
 * RFC 8628 device authorization grant. Returns { ok, token } on approval, or
 * { ok:false, reason } for denied/expired/timeout/error.
 */
async function runDeviceFlow(onStatus) {
  const baseUrl = getBaseUrl();
  if (!baseUrl) return { ok: false, reason: "noBaseUrl" };

  const deviceName = defaultDeviceName();
  let auth;
  try {
    const res = await fetch(`${baseUrl}/api/vtt-overlay/device/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ kind: "foundry", deviceName })
    });
    if (!res.ok) return { ok: false, reason: "authorizeFailed", httpStatus: res.status };
    auth = await res.json();
  } catch (err) {
    return { ok: false, reason: "network", error: String(err?.message ?? err) };
  }

  const verificationUri = auth.verificationUriComplete || auth.verificationUri;
  if (verificationUri) {
    try { window.open(verificationUri, "_blank", "noopener,noreferrer"); } catch { /* popup blocked */ }
  }
  if (typeof onStatus === "function") onStatus(auth.userCode, verificationUri);

  const deviceCode = auth.deviceCode;
  let intervalMs = Math.max(1, Number(auth.intervalSeconds) || 5) * 1000;
  const expiresMs = Math.max(30, Number(auth.expiresInSeconds) || 600) * 1000;
  const deadline = Date.now() + expiresMs;

  // Wait one interval before the first poll (RFC 8628).
  await delay(intervalMs);

  while (Date.now() < deadline) {
    let poll;
    try {
      const res = await fetch(`${baseUrl}/api/vtt-overlay/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ deviceCode })
      });
      poll = await res.json().catch(() => ({}));
    } catch (err) {
      // Transient network error while polling: keep trying until the deadline.
      await delay(intervalMs);
      continue;
    }

    switch (poll?.status) {
      case "approved":
        if (poll.token) return { ok: true, token: String(poll.token) };
        return { ok: false, reason: "error" };
      case "denied":
        return { ok: false, reason: "denied" };
      case "expired":
        return { ok: false, reason: "expired" };
      case "slow_down":
        intervalMs += 5000;
        break;
      case "pending":
      default:
        break;
    }
    await delay(intervalMs);
  }
  return { ok: false, reason: "expired" };
}

/* ------------------------------------------------------------------ */
/* Dispatch timing (DSN-aware)                                         */
/* ------------------------------------------------------------------ */

/** messageId -> { payload, timer } while awaiting diceSoNiceRollStart. */
const pendingDsn = new Map();

function dispatch(messageId, payload) {
  if (game.dice3d) {
    // DSN present: POST when DSN starts animating THIS roll, with a safety fallback.
    const timer = setTimeout(() => {
      if (pendingDsn.has(messageId)) {
        pendingDsn.delete(messageId);
        void postRoll(payload);
      }
    }, DSN_FALLBACK_MS);
    pendingDsn.set(messageId, { payload, timer });
  } else {
    // No DSN: post immediately.
    void postRoll(payload);
  }
}

/* ------------------------------------------------------------------ */
/* ApplicationV2 settings panel                                        */
/* ------------------------------------------------------------------ */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class JdrNinjaOverlayPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {Array|null} last built diagnostic rows */
  #rows = null;
  /** @type {string|null} account name from the last diagnostics call */
  #account = null;
  /** @type {boolean} paid feature active from the last diagnostics call */
  #entitled = true;
  /** @type {boolean} advanced config section expanded */
  #advancedOpen = false;
  /** @type {boolean} a request is in flight */
  #busy = false;

  static DEFAULT_OPTIONS = {
    id: "jdr-ninja-vtt-overlay-panel",
    tag: "form",
    classes: ["jdr-ninja-vtt-overlay"],
    window: {
      title: `${I18N}.panel.title`,
      icon: "fas fa-dice-d20",
      resizable: true
    },
    position: { width: 560, height: "auto" },
    actions: {
      link: JdrNinjaOverlayPanel.#onLink,
      testConnection: JdrNinjaOverlayPanel.#onTestConnection,
      sendTestRoll: JdrNinjaOverlayPanel.#onSendTestRoll,
      toggleRelay: JdrNinjaOverlayPanel.#onToggleRelay,
      toggleAdvanced: JdrNinjaOverlayPanel.#onToggleAdvanced,
      saveAdvanced: JdrNinjaOverlayPanel.#onSaveAdvanced,
      openSubscription: JdrNinjaOverlayPanel.#onOpenSubscription
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/settings-panel.hbs` }
  };

  /** Build the render context. */
  async _prepareContext() {
    const linked = getToken().length > 0;
    const relayOn = getRelayToggle();

    const lastSuccessAt = Number(game.settings.get(MODULE_ID, S.lastSuccessAt) || 0);
    const lastErrorAt = Number(game.settings.get(MODULE_ID, S.lastErrorAt) || 0);
    const lastError = String(game.settings.get(MODULE_ID, S.lastError) || "");

    let lastTestLine = "";
    if (lastSuccessAt && lastSuccessAt >= lastErrorAt) {
      lastTestLine = Fmt("panel.lastTestSuccess", { when: this.#formatWhen(lastSuccessAt) });
    } else if (lastErrorAt) {
      lastTestLine = Fmt("panel.lastTestError", { when: this.#formatWhen(lastErrorAt), reason: lastError });
    }

    return {
      linked,
      relayOn,
      account: this.#account,
      statusClass: linked ? "connected" : "disconnected",
      statusLabel: linked ? L("panel.status.connected") : L("panel.status.disconnected"),
      linkButtonLabel: linked ? L("panel.button.relink") : L("panel.button.link"),
      deviceName: defaultDeviceName(),
      rows: this.#rows,
      hasDiagnostics: Array.isArray(this.#rows),
      entitled: this.#entitled,
      showPaidNotice: Array.isArray(this.#rows) && this.#entitled === false,
      lastTestLine,
      advancedOpen: this.#advancedOpen,
      baseUrl: getBaseUrl(),
      busy: this.#busy
    };
  }

  #formatWhen(ts) {
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return "";
    }
  }

  #setBusy(busy) {
    this.#busy = busy;
    return this.render();
  }

  /** Recompute the diagnostics checklist from a fresh /diagnostics call + local state. */
  async #refreshDiagnostics() {
    const result = await fetchDiagnostics();
    const rows = [];
    const hasToken = getToken().length > 0;
    const hasBaseUrl = getBaseUrl().length > 0;
    const relayOn = getRelayToggle();

    const configured = hasToken && hasBaseUrl;
    const push = (key, status, message) => rows.push(this.#row(key, status, message));

    // 1. Configuration
    push("configuration", configured ? "ok" : "error",
      configured ? L("diag.configuration.ok") : L("diag.configuration.broken"));

    // 2. Relay, evaluated CLIENT-SIDE (local toggle + token presence), not from the response.
    if (!hasToken) {
      push("relay", "error", L("diag.relay.broken"));
    } else {
      push("relay", relayOn ? "ok" : "warn", relayOn ? L("diag.relay.ok") : L("diag.relay.broken"));
    }

    // Remaining rows depend on the server call.
    this.#account = null;
    this.#entitled = true;

    if (result.kind === "unconfigured") {
      push("auth", "unknown", L("diag.auth.unknown"));
      push("subscription", "unknown", L("diag.subscription.unknown"));
      push("overlay", "unknown", L("diag.overlay.unknown"));
      push("obs", "unknown", L("diag.obs.unknown"));
      push("network", "unknown", L("diag.network.unknown"));
    } else if (result.kind === "network") {
      push("auth", "unknown", L("diag.auth.unknown"));
      push("subscription", "unknown", L("diag.subscription.unknown"));
      push("overlay", "unknown", L("diag.overlay.unknown"));
      push("obs", "unknown", L("diag.obs.unknown"));
      push("network", "error", L("diag.network.broken"));
    } else if (result.kind === "unauthorized") {
      push("auth", "error", L("diag.auth.broken"));
      push("subscription", "unknown", L("diag.subscription.unknown"));
      push("overlay", "unknown", L("diag.overlay.unknown"));
      push("obs", "unknown", L("diag.obs.unknown"));
      push("network", "ok", L("diag.network.ok"));
    } else if (result.kind === "httpError") {
      push("auth", "error", Fmt("diag.auth.httpError", { status: result.httpStatus }));
      push("subscription", "unknown", L("diag.subscription.unknown"));
      push("overlay", "unknown", L("diag.overlay.unknown"));
      push("obs", "unknown", L("diag.obs.unknown"));
      push("network", "ok", L("diag.network.ok"));
    } else {
      // kind === "ok"
      const data = result.data ?? {};
      const overlay = data.overlay ?? {};
      this.#account = data.account ?? null;
      this.#entitled = data.entitled === true;

      push("auth", "ok", L("diag.auth.ok"));
      push("subscription", this.#entitled ? "ok" : "error",
        this.#entitled ? L("diag.subscription.ok") : L("diag.subscription.broken"));

      const overlayReady = overlay.exists === true && overlay.enabled === true;
      push("overlay", overlayReady ? "ok" : "error",
        overlayReady ? L("diag.overlay.ok") : L("diag.overlay.broken"));

      const clients = Number(overlay.connectedClients || 0);
      // connectedClients: 0 is a WARNING, not a failure.
      push("obs", clients > 0 ? "ok" : "warn",
        clients > 0 ? Fmt("diag.obs.ok", { count: clients }) : L("diag.obs.broken"));

      push("network", "ok", L("diag.network.ok"));
    }

    this.#rows = rows;
  }

  #row(key, status, message) {
    const visuals = {
      ok: { icon: "fa-circle-check", cls: "jdrn-ok" },
      warn: { icon: "fa-triangle-exclamation", cls: "jdrn-warn" },
      error: { icon: "fa-circle-xmark", cls: "jdrn-error" },
      unknown: { icon: "fa-circle-question", cls: "jdrn-unknown" }
    };
    const v = visuals[status] ?? visuals.unknown;
    return {
      key,
      status,
      icon: v.icon,
      cssClass: v.cls,
      label: L(`diag.${key}.label`),
      message
    };
  }

  /* --- action handlers (bound to the instance by ApplicationV2) --- */

  static async #onLink() {
    if (this.#busy) return;
    const baseUrl = getBaseUrl();
    if (!baseUrl) {
      ui.notifications.error(L("toast.noBaseUrl"));
      return;
    }
    await this.#setBusy(true);
    ui.notifications.info(L("device.starting"));
    try {
      const result = await runDeviceFlow((userCode) => {
        if (userCode) ui.notifications.info(Fmt("device.enterCode", { code: userCode }));
      });
      if (result.ok) {
        await game.settings.set(MODULE_ID, S.deviceToken, result.token);
        // Pairing itself is the signal "this is my streaming machine": auto-arm relay.
        await game.settings.set(MODULE_ID, S.relayEnabled, true);
        ui.notifications.info(L("device.approved"));
        ui.notifications.info(L("device.relayAutoEnabled"));
        await this.#refreshDiagnostics();
      } else {
        ui.notifications.error(L(`device.${this.#deviceErrorKey(result.reason)}`));
      }
    } catch (err) {
      console.error(`${MODULE_ID} | device flow failed`, err);
      ui.notifications.error(L("device.error"));
    } finally {
      await this.#setBusy(false);
    }
  }

  #deviceErrorKey(reason) {
    switch (reason) {
      case "denied": return "denied";
      case "expired": return "expired";
      case "noBaseUrl": return "noBaseUrl";
      default: return "error";
    }
  }

  static async #onTestConnection() {
    if (this.#busy) return;
    if (getToken().length === 0) {
      ui.notifications.warn(L("toast.notLinked"));
    }
    await this.#setBusy(true);
    try {
      await this.#refreshDiagnostics();
      ui.notifications.info(L("toast.diagnosticsDone"));
    } catch (err) {
      console.error(`${MODULE_ID} | diagnostics failed`, err);
      ui.notifications.error(L("toast.diagnosticsFailed"));
    } finally {
      await this.#setBusy(false);
    }
  }

  static async #onSendTestRoll() {
    if (this.#busy) return;
    if (getToken().length === 0) {
      ui.notifications.warn(L("toast.notLinked"));
      return;
    }
    await this.#setBusy(true);
    try {
      const payload = {
        rollId: `test-${foundry.utils.randomID()}`,
        formula: "1d20",
        total: 20,
        dice: [{ faces: 20, results: [20] }],
        label: L("test.label"),
        roller: L("test.roller")
      };
      // A manual test must always refresh the "last successful test" line, throttle or not.
      resetSuccessThrottle();
      const res = await postRoll(payload);
      if (res.ok) {
        ui.notifications.info(L("toast.testRollSent"));
      } else if (res.status === 401 || res.status === 403) {
        ui.notifications.error(L("diag.auth.broken"));
      } else {
        ui.notifications.error(L("toast.testRollFailed"));
      }
      await this.#refreshDiagnostics();
    } catch (err) {
      console.error(`${MODULE_ID} | test roll failed`, err);
      ui.notifications.error(L("toast.testRollFailed"));
    } finally {
      await this.#setBusy(false);
    }
  }

  static async #onToggleRelay() {
    if (this.#busy) return;
    const next = !getRelayToggle();
    await game.settings.set(MODULE_ID, S.relayEnabled, next);
    ui.notifications.info(next ? L("toast.relayOn") : L("toast.relayOff"));
    await this.render();
  }

  static async #onToggleAdvanced() {
    this.#advancedOpen = !this.#advancedOpen;
    await this.render();
  }

  static async #onSaveAdvanced() {
    const root = this.element;
    const baseUrlInput = root?.querySelector('input[name="baseUrl"]');
    const tokenInput = root?.querySelector('input[name="token"]');

    if (baseUrlInput) {
      const value = String(baseUrlInput.value || "").trim();
      if (value) await game.settings.set(MODULE_ID, S.baseUrl, value);
    }
    if (tokenInput && tokenInput.value.trim()) {
      // Manual paste fallback for locked-down environments.
      await game.settings.set(MODULE_ID, S.deviceToken, tokenInput.value.trim());
      await game.settings.set(MODULE_ID, S.relayEnabled, true);
      tokenInput.value = "";
      ui.notifications.info(L("device.relayAutoEnabled"));
    }
    ui.notifications.info(L("toast.saved"));
    await this.render();
  }

  static async #onOpenSubscription() {
    const baseUrl = getBaseUrl() || "https://www.jdr.ninja";
    try { window.open(`${baseUrl}/abonnement`, "_blank", "noopener,noreferrer"); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

function registerSettings() {
  game.settings.register(MODULE_ID, S.baseUrl, {
    name: `${I18N}.settings.baseUrl.name`,
    hint: `${I18N}.settings.baseUrl.hint`,
    scope: "client",
    config: true,
    type: String,
    // MUST be the canonical www origin (same as jdr-ninja-atlas-sync's DEFAULT_API_BASE_URL). The
    // apex host redirects here, and a redirect is fatal for these calls: browsers never follow
    // redirects on a CORS preflight, and every request this module makes is preflighted (JSON body
    // plus an Authorization header). Pointing at the apex fails the pairing and the roll relay with
    // an opaque network error rather than an HTTP status.
    default: "https://www.jdr.ninja"
  });

  // Never shown in a config field; managed by the device flow / advanced paste.
  game.settings.register(MODULE_ID, S.deviceToken, {
    scope: "client",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, S.relayEnabled, {
    name: `${I18N}.settings.relay.name`,
    hint: `${I18N}.settings.relay.hint`,
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, S.forwardFilter, {
    name: `${I18N}.settings.forwardFilter.name`,
    hint: `${I18N}.settings.forwardFilter.hint`,
    scope: "client",
    config: true,
    type: String,
    default: FILTER.allPublic,
    choices: {
      [FILTER.allPublic]: `${I18N}.settings.forwardFilter.allPublic`,
      [FILTER.playersOnly]: `${I18N}.settings.forwardFilter.playersOnly`
    }
  });

  // Diagnostics timestamps / last error (never shown as config fields).
  game.settings.register(MODULE_ID, S.lastSuccessAt, { scope: "client", config: false, type: Number, default: 0 });
  game.settings.register(MODULE_ID, S.lastErrorAt, { scope: "client", config: false, type: Number, default: 0 });
  game.settings.register(MODULE_ID, S.lastError, { scope: "client", config: false, type: String, default: "" });

  // The settings menu is NOT restricted, so players can pair and stream too.
  game.settings.registerMenu(MODULE_ID, "panel", {
    name: `${I18N}.menu.name`,
    label: `${I18N}.menu.label`,
    hint: `${I18N}.menu.hint`,
    icon: "fas fa-dice-d20",
    type: JdrNinjaOverlayPanel,
    restricted: false
  });
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  registerSettings();
  console.log(`${MODULE_ID} | initialized`);
});

// Persistent DSN start hook (id-matched). Registering it unconditionally is harmless
// when DSN is absent; it only ever fires when DSN animates a roll we stashed.
Hooks.on("diceSoNiceRollStart", (messageId) => {
  const entry = pendingDsn.get(messageId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingDsn.delete(messageId);
  void postRoll(entry.payload);
});

Hooks.on("createChatMessage", (message) => {
  try {
    // Single-relay gate: token present AND relay toggle on. No GM check, no world setting.
    if (!thisClientRelays()) return;

    // Hidden rolls (gmroll / blindroll / selfroll) must NEVER reach the public overlay.
    // Use whisper/blind, NOT isContentVisible (true for a GM even on secret rolls).
    if (message.blind || (message.whisper?.length ?? 0) > 0) return;

    const rolls = message.rolls ?? [];
    if (rolls.length === 0) return;

    // Has-dice check (skip deterministic rolls with zero dice).
    if (!rolls.some((r) => (r.dice?.length ?? 0) > 0)) return;

    // Optional forward filter: "players only" drops GM-authored rolls.
    if (getForwardFilter() === FILTER.playersOnly && message.author?.isGM === true) return;

    const payload = buildPayload(message);
    if (!payload) return;

    dispatch(message.id, payload);
  } catch (err) {
    console.error(`${MODULE_ID} | createChatMessage relay failed`, err);
  }
});
