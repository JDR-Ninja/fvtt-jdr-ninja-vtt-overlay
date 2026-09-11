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
 *    start (id-matched in either hook order, persistent hook + ~2s safety fallback); otherwise
 *    we POST immediately.
 *  - Dice So Nice appearance pass-through is a copyright-safe SUBSET (colors + material/font
 *    NAMES only) read from the ROLLER's flags. Never DSN textures/meshes/colorset tables.
 *  - Free to install and pair; relaying real rolls requires a paid JDR Ninja plan (server-enforced).
 */

const MODULE_ID = "jdr-ninja-vtt-overlay";
const I18N = "JDRNINJA_VTT_OVERLAY";

/** Persistent hook only needs to fire the fallback if DSN never starts this roll. */
const DSN_FALLBACK_MS = 2000;

/** Class that hides a held chat card. Deliberately ours alone, never DSN's `dsn-hide`. */
const CARD_HOLD_CLASS = "jdrn-hold";

/** Ceiling on the hold, so a value set from the console cannot freeze the chat log. */
const CARD_HOLD_MAX_MS = 10_000;

/** Minimum gap between two `lastSuccessAt` writes (see recordSuccess). */
const SUCCESS_STAMP_THROTTLE_MS = 60_000;

/** Poll cadence for the web to Foundry command channel. */
const TABLE_POLL_INTERVAL_MS = 2500;

/** Ceiling on the failure back-off, so a site outage settles into one call per minute. */
const TABLE_POLL_MAX_BACKOFF_MS = 60_000;

/**
 * Face counts JDR Ninja has a real 3D mesh for. The overlay draws dice and nothing else, so a table
 * whose formula rolls anything outside this set produces an EMPTY overlay, which reads as a broken
 * feature rather than a missing die. Note that Foundry's default table formula is `1d{results.length}`,
 * so an untouched table is usually ineligible: d7, d13, d17. So is `1d100`, the most common authored
 * shape. The site cannot warn about this when the streamer configures the command, because it has no
 * view of this world, so this client is the only thing standing between a bad table and a blank overlay.
 */
const MESH_BACKED_FACES = Object.freeze([4, 6, 8, 10, 12, 20]);

/** Setting keys (all client scope). */
const S = Object.freeze({
  baseUrl: "baseUrl",
  deviceToken: "deviceToken",
  relayEnabled: "relayEnabled",
  forwardFilter: "forwardFilter",
  cardHoldSeconds: "cardHoldSeconds",
  tableCommandsEnabled: "tableCommandsEnabled",
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

/** Chat-card hold in ms, 0 when off. Stored in whole seconds, like every Foundry select. */
function getCardHoldMs() {
  const seconds = Number.parseInt(String(game.settings.get(MODULE_ID, S.cardHoldSeconds) ?? "0"), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds * 1000, CARD_HOLD_MAX_MS);
}

/**
 * Does DSN withhold roll cards on its own right now? Its `immediatelyDisplayChatMessages` is a
 * WORLD setting defaulting to false, so out of the box DSN already holds every animated roll's
 * card until its 3D animation ends. Read defensively: `get` throws on an unregistered key, which
 * is exactly what happens when DSN is absent.
 */
function dsnHoldsCards() {
  if (!game.dice3d) return false;
  try {
    return game.settings.get("dice-so-nice", "immediatelyDisplayChatMessages") !== true;
  } catch {
    return false;
  }
}

/** This browser relays iff it holds a device token AND the local relay toggle is on. */
function thisClientRelays() {
  return getToken().length > 0 && getRelayToggle();
}

function getTableCommandsToggle() {
  return game.settings.get(MODULE_ID, S.tableCommandsEnabled) === true;
}

/**
 * This browser answers Twitch table commands iff it relays, its own table switch is on, and the user
 * is a GM. The GM check is not a convenience: `table.draw()` writes a chat message into the world, so
 * a player client could not perform the draw even if it polled. Requiring it here also keeps the poll
 * to one browser at a table, which is what makes the per-IP rate limit arithmetic work out.
 */
function tableCommandsActive() {
  return thisClientRelays() && getTableCommandsToggle() && game.user?.isGM === true;
}

/**
 * Where a die term can start: an optional count, then `d`. The leading boundary is what stops a
 * modifier suffix from reading as a second term (the `d1` of `4d6d1`, drop-lowest, is preceded by a
 * digit) and a word from reading as one (the `d` of `mod` is preceded by a letter). `.` and `@` are
 * excluded from the boundary on purpose: they introduce a roll-data path (`@abilities.dex.mod`),
 * where a `d` is never a die.
 */
const DIE_TERM_START_RE = /(?:^|[^a-z0-9.@_])\d*d/gi;

/** What follows that `d`: a face count, Fate (`dF`), percentile (`d%`), or explicit faces (`d{1,3,5}`). */
const FACE_SPEC_RE = /^(\d+|f|%|\{[^}]*\})/i;

/**
 * Will a draw on this table put a die on the overlay? Every die term in the formula has to be
 * mesh-backed, because a term we cannot render leaves the overlay blank with no explanation. This is
 * the ONLY place that check can happen: the streamer configures commands on jdr.ninja, which cannot
 * read a formula out of a world it has no access to.
 *
 * Two steps rather than one regex, because the shapes that must be REFUSED are exactly the ones a
 * `d(\d+)` pattern cannot see. `1d6 + 1dF` used to yield a single face of 6 and pass, relaying a
 * FateDie the overlay has no mesh for, which is the blank overlay this guard exists to prevent. So
 * find every place a die term starts, then classify what follows: anything that is not a plain
 * mesh-backed face count refuses the draw, including a face spec we cannot even name.
 */
function tableFormulaIsMeshBacked(formula) {
  if (typeof formula !== "string") return false;

  let terms = 0;
  let meshBacked = 0;
  for (const start of formula.matchAll(DIE_TERM_START_RE)) {
    terms++;
    const spec = FACE_SPEC_RE.exec(formula.slice(start.index + start[0].length));
    if (!spec) continue;
    if (/^\d+$/.test(spec[1]) && MESH_BACKED_FACES.includes(Number(spec[1]))) meshBacked++;
  }

  if (terms === 0) return false; // a formula with no die term draws nothing to animate
  return meshBacked === terms;
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
 * Poll the one downstream endpoint: what does web want this client to do? The server dequeues on
 * read, so a command is delivered to exactly one browser and never redelivered.
 * Returns an array of commands, or null when the call failed (the caller backs off).
 */
async function fetchCommands() {
  const baseUrl = getBaseUrl();
  const token = getToken();
  if (!baseUrl || !token) return null;
  try {
    const res = await fetch(`${baseUrl}/api/vtt-overlay/foundry/commands`, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.commands) ? data.commands : [];
  } catch {
    return null;
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

/**
 * messageId -> expiry timer for rolls DSN had ALREADY started when dispatch() ran.
 *
 * That is the usual order, not a corner case: Foundry registers hooks in module load order,
 * `dice-so-nice` sorts before this module, and DSN fires `diceSoNiceRollStart` synchronously from
 * inside its own `createChatMessage` handler. So by the time our handler reaches dispatch() the
 * start signal has already gone by, and matching on it alone left every DSN roll waiting out the
 * fallback timer, two seconds behind the table. Measured, not guessed (2026-09-11, DSN 6.2.9).
 *
 * A start we never match (hidden roll, filtered author, no dice) expires on its own after the
 * same window the fallback uses; nothing here needs a cleanup pass.
 */
const startedDsn = new Map();

function dispatch(messageId, payload) {
  if (!game.dice3d) {
    // No DSN: post immediately.
    void postRoll(payload);
    return;
  }

  const started = startedDsn.get(messageId);
  if (started !== undefined) {
    // DSN is already animating THIS roll: post now, in step with it.
    clearTimeout(started);
    startedDsn.delete(messageId);
    void postRoll(payload);
    return;
  }

  // DSN present but not started yet: POST when it starts THIS roll, with a safety fallback.
  const timer = setTimeout(() => {
    if (pendingDsn.has(messageId)) {
      pendingDsn.delete(messageId);
      void postRoll(payload);
    }
  }, DSN_FALLBACK_MS);
  pendingDsn.set(messageId, { payload, timer });
}

/* ------------------------------------------------------------------ */
/* Chat-card hold                                                      */
/* ------------------------------------------------------------------ */

/**
 * messageId -> epoch ms before which this message's card stays hidden.
 *
 * A DEADLINE, deliberately not a duration, and anchored at message creation:
 *
 *  - No double delay. Two independent "hide until my own condition" gates compose as max(), not
 *    as a sum: DSN removes only `dsn-hide`, we remove only CARD_HOLD_CLASS, so the card appears
 *    when the later of the two lets go. Chaining on `diceSoNiceRollComplete` instead would both
 *    add the delays AND flash the card, since that hook fires AFTER DSN has revealed it.
 *  - The configured value keeps meaning one thing. DSN's own hold varies with the dice count
 *    (its settle is `iterations / 60` s), so a value tuned as a "top up on top of DSN" would be
 *    wrong on the next roll, and absurd if DSN were later disabled.
 */
const cardHoldUntil = new Map();

/**
 * Register a hold for a message this browser just relayed.
 *
 * The reveal timer is armed here rather than at render time, which makes release unconditional:
 * it fires whether or not the POST succeeded, whether or not the plan is paid, and whether or not
 * an overlay is even connected. That is why no separate cap or cleanup pass is needed.
 */
function holdCard(messageId, holdMs) {
  if (holdMs <= 0 || cardHoldUntil.has(messageId)) return;
  cardHoldUntil.set(messageId, Date.now() + holdMs);
  setTimeout(() => {
    cardHoldUntil.delete(messageId);
    revealCard(messageId);
  }, holdMs);
}

/**
 * Drop our hide class from every rendered instance of a message: the sidebar card, the popout
 * chat card and the chat notification pip. Same three surfaces DSN reveals, found the same way.
 */
function revealCard(messageId) {
  try {
    const held = document.querySelectorAll(
      `.${CARD_HOLD_CLASS}[data-message-id="${CSS.escape(messageId)}"]`
    );
    for (const el of held) {
      el.classList.remove(CARD_HOLD_CLASS);
      // A pip that spent its whole lifespan hidden would expire the instant it is revealed.
      if (el.closest("#chat-notifications")) {
        try { el._lifeSpan = 0; } catch { /* private and cosmetic; never worth throwing over */ }
      }
    }
  } catch (err) {
    console.error(`${MODULE_ID} | revealing a held chat card failed`, err);
  }
}

/* ------------------------------------------------------------------ */
/* Twitch table commands: poll loop and draw                           */
/* ------------------------------------------------------------------ */

let pollTimer = null;
let pollBackoffMs = 0;
let pollInFlight = false;

/**
 * Act on one dequeued command. The UUID comes from the streamer's own configuration on jdr.ninja, so
 * this client is executing a reference it did not choose. It therefore verifies what it resolved before
 * touching it: the document must exist and must actually be a RollTable.
 *
 * Every rejection is SILENT to the chat by design, because the viewer who triggered it is a stranger
 * and there is no reply channel anyway. The console line is what a GM finds when they go looking, and
 * it is the only diagnosis this feature offers.
 */
async function handleDrawCommand(uuid) {
  const reference = String(uuid ?? "").trim();
  if (!reference) return;

  let table;
  try {
    const resolve = globalThis.fromUuid ?? foundry?.utils?.fromUuid;
    table = await resolve(reference);
  } catch (err) {
    console.warn(`${MODULE_ID} | could not resolve table uuid "${reference}"`, err);
    return;
  }

  if (!table) {
    console.warn(`${MODULE_ID} | table uuid "${reference}" resolves to nothing in this world`);
    return;
  }
  if (table.documentName !== "RollTable") {
    console.warn(`${MODULE_ID} | uuid "${reference}" is a ${table.documentName}, not a RollTable; draw skipped`);
    return;
  }

  // Draw-time eligibility guard, and the only one there is: the site cannot read a formula it has no
  // access to, and a table's formula can be rewritten long after the command was configured.
  if (!tableFormulaIsMeshBacked(table.formula)) {
    console.warn(`${MODULE_ID} | table "${table.name}" has no mesh-backed die (${table.formula}); draw skipped`);
    return;
  }

  // Public on purpose, twice over: the module drops hidden rolls before they ever leave this client,
  // and the GM has to see the result to read it out loud.
  //
  // v14 renamed the option: `messageMode`, a key of CONFIG.ChatMessage.modes, replaces `rollMode`
  // and its `publicroll` value, and v14 logs a deprecation for both the old option and for merely
  // reading CONST.DICE_ROLL_MODES (removal in v16). v13 has neither the option nor the config, so
  // the config's presence is the version test; the v13 literal stays a literal for the same reason.
  const drawOptions = CONFIG.ChatMessage?.modes?.public
    ? { messageMode: "public" }
    : { rollMode: "publicroll" };
  try {
    // Nothing is posted to the overlay from here. The draw lands in chat, `createChatMessage` picks
    // it up, and it relays through the ordinary path. One relay path, and the return trip is free.
    await table.draw(drawOptions);
  } catch (err) {
    console.error(`${MODULE_ID} | table draw failed`, err);
  }
}

async function pollCommandsOnce() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const commands = await fetchCommands();
    if (commands === null) {
      // Failure: back off so a site outage does not turn into a request every 2.5 s per table.
      pollBackoffMs = Math.min(
        TABLE_POLL_MAX_BACKOFF_MS,
        pollBackoffMs === 0 ? TABLE_POLL_INTERVAL_MS * 2 : pollBackoffMs * 2);
      return;
    }
    pollBackoffMs = 0;
    for (const command of commands) {
      if (command?.kind === "drawTable") await handleDrawCommand(command.uuid);
    }
  } finally {
    pollInFlight = false;
  }
}

function scheduleNextPoll() {
  clearTimeout(pollTimer);
  if (!tableCommandsActive()) {
    pollTimer = null;
    return;
  }
  // At 2.5 s this client makes 24 polls a minute against a 120/min per-IP limit, leaving room for the
  // roll relay on the same address. It only holds because a single GM browser polls (see
  // `tableCommandsActive`); several table members behind one household IP would not fit.
  pollTimer = setTimeout(async () => {
    await pollCommandsOnce();
    scheduleNextPoll();
  }, pollBackoffMs || TABLE_POLL_INTERVAL_MS);
}

/** Start, stop, or leave the loop alone so it matches the current settings. Safe to call repeatedly. */
function syncCommandPolling() {
  if (!tableCommandsActive()) {
    clearTimeout(pollTimer);
    pollTimer = null;
    pollBackoffMs = 0;
    return;
  }
  if (pollTimer === null) scheduleNextPoll();
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
      toggleTableCommands: JdrNinjaOverlayPanel.#onToggleTableCommands,
      openCommands: JdrNinjaOverlayPanel.#onOpenCommands,
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
      busy: this.#busy,
      ...this.#tableCommandContext()
    };
  }

  /**
   * The Twitch table-command section. GM only: only a GM can draw, so a player toggling this would
   * change nothing, and showing them a switch that does nothing is worse than showing them none.
   *
   * <p>The commands themselves are NOT edited here. They live on jdr.ninja, keyed by a Foundry UUID,
   * because that is where the streamer already manages their channel and because a UUID also addresses
   * compendium tables that a world-local picker never could. This panel owns exactly one decision:
   * whether this browser answers them.</p>
   */
  #tableCommandContext() {
    const isGm = game.user?.isGM === true;
    if (!isGm) return { isGm: false, tableCommandsOn: false, commandsUrl: "" };

    return {
      isGm: true,
      tableCommandsOn: getTableCommandsToggle(),
      commandsUrl: `${getBaseUrl() || "https://www.jdr.ninja"}/vtt-overlay/commandes`
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

    // 3. Chat-card hold, client-side like the two above: a local display choice, not a server fact.
    // Stated here because the hold is invisible when it is shorter than DSN's own (max(), not sum),
    // which otherwise reads as a broken setting.
    const holdMs = getCardHoldMs();
    if (holdMs <= 0) {
      push("cardHold", "ok", L("diag.cardHold.off"));
    } else if (!thisClientRelays()) {
      push("cardHold", "warn", L("diag.cardHold.inactive"));
    } else {
      const seconds = Math.round(holdMs / 1000);
      push("cardHold", "ok", dsnHoldsCards()
        ? Fmt("diag.cardHold.onWithDsn", { seconds })
        : Fmt("diag.cardHold.on", { seconds }));
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

  static async #onToggleTableCommands() {
    if (this.#busy) return;
    const next = !getTableCommandsToggle();
    await game.settings.set(MODULE_ID, S.tableCommandsEnabled, next);
    // The setting's own onChange already syncs the loop; this is here so the toast never lies about
    // a poll that failed to start because the relay is off or the user is not a GM.
    syncCommandPolling();
    ui.notifications.info(next ? L("toast.tableCommandsOn") : L("toast.tableCommandsOff"));
    if (next && !tableCommandsActive()) ui.notifications.warn(L("toast.tableCommandsInactive"));
    await this.render();
  }

  static async #onOpenCommands() {
    const baseUrl = getBaseUrl() || "https://www.jdr.ninja";
    try { window.open(`${baseUrl}/vtt-overlay/commandes`, "_blank", "noopener,noreferrer"); } catch { /* ignore */ }
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
    default: false,
    // Table commands ride on the relay being on, so stopping the relay must stop the poll too.
    onChange: () => syncCommandPolling()
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

  // Off by default: the right value depends on this streamer's OBS composite and on what DSN is
  // already doing, so it is tuned by hand rather than guessed. Client scope like everything else
  // here, and correctly so: only the browser OBS captures gains anything from a hold, and a world
  // setting would delay every player's card for nothing.
  game.settings.register(MODULE_ID, S.cardHoldSeconds, {
    name: `${I18N}.settings.cardHold.name`,
    hint: `${I18N}.settings.cardHold.hint`,
    scope: "client",
    config: true,
    type: String,
    default: "0",
    choices: {
      "0": `${I18N}.settings.cardHold.off`,
      "1": `${I18N}.settings.cardHold.s1`,
      "2": `${I18N}.settings.cardHold.s2`,
      "3": `${I18N}.settings.cardHold.s3`,
      "5": `${I18N}.settings.cardHold.s5`
    }
  });

  // Deliberately NOT the same switch as relay: a streamer who wants viewers to roll dice must not
  // get viewers drawing from their tables as a side effect. Off by default, and client scope because
  // it decides which browser answers, not what the world exposes. Only a GM client can act on it
  // (see tableCommandsActive), so a player turning it on changes nothing.
  game.settings.register(MODULE_ID, S.tableCommandsEnabled, {
    name: `${I18N}.settings.tableCommands.name`,
    hint: `${I18N}.settings.tableCommands.hint`,
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => syncCommandPolling()
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

// Polling starts at "ready", never at "init": it needs game.user for the GM check, which does not exist
// yet when settings are registered.
Hooks.once("ready", () => {
  syncCommandPolling();
});

// Persistent DSN start hook (id-matched, either order). Registering it unconditionally is
// harmless when DSN is absent; it only ever fires when DSN animates a roll.
Hooks.on("diceSoNiceRollStart", (messageId) => {
  const entry = pendingDsn.get(messageId);
  if (entry) {
    // dispatch() got there first (DSN loaded after us, or started this roll asynchronously).
    clearTimeout(entry.timer);
    pendingDsn.delete(messageId);
    void postRoll(entry.payload);
    return;
  }
  // DSN got there first, the common order (see startedDsn): remember the id so that dispatch()
  // posts on arrival instead of waiting for a start signal that has already passed.
  if (startedDsn.has(messageId)) return;
  startedDsn.set(messageId, setTimeout(() => startedDsn.delete(messageId), DSN_FALLBACK_MS));
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

    // Only rolls that got this far are held: a card the overlay never received must never wait.
    holdCard(message.id, getCardHoldMs());

    dispatch(message.id, payload);
  } catch (err) {
    console.error(`${MODULE_ID} | createChatMessage relay failed`, err);
  }
});

// The same hook DSN hides through, chosen for the same reason: by the time it fires every
// `createChatMessage` handler has already run, so the hold deadline is known. Re-applied on EVERY
// render, because the chat log re-renders on scroll, on popout and on sidebar tab switches, and a
// one-shot hide would let any of those reveal the card early.
Hooks.on("renderChatMessageHTML", (message, html) => {
  const revealAt = cardHoldUntil.get(message.id);
  if (!revealAt || Date.now() >= revealAt) return;
  html.classList.add(CARD_HOLD_CLASS);
});
