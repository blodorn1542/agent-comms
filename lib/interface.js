'use strict';

/**
 * The one interface agents call. Providers are adapters behind it.
 *
 * An agent says "send this for tenant X" and never learns it was Gmail. Adding
 * Microsoft 365 or Twilio later is one new adapter and zero agent changes. That
 * indirection is the whole point of this package - without it, every agent gets
 * rewritten for every provider.
 *
 * This module knows nothing about any particular agent. It has no idea what a
 * findings log, an invoice or a collections tier is.
 *
 * HARD RULE, and the reason send() looks the way it does: nothing is
 * transmitted unless EVERY gate opens. With the defaults, send() is a drafting
 * function - it writes a queued row and returns. The pipe is built; the switch
 * is separate and stays off until a human turns it on.
 *
 * The gates, all of which must pass (see sendDecision):
 *   1. the adapter must declare outbound and actually have a transmit()
 *   2. the global send switch                 (off by default)
 *   3. the tenant's config says comms.sendEnabled   (off by default)
 *   4. an approval record naming a human       (approval gate)
 *   5. the recipient has not opted out         (stop handling)
 *   6. it is inside the tenant's send window   (quiet hours)
 */

/**
 * An adapter that does not declare outbound, or that has no transmit(), can
 * never be handed a message. This is what makes "Quo cannot send" structural
 * rather than a promise - the Quo adapter has no transmit function to call.
 */
function assertCanSend(adapter) {
  if (!adapter?.capabilities?.outbound || typeof adapter.transmit !== 'function') {
    throw new Error('Adapter "' + (adapter?.name ?? 'unknown') + '" is inbound-only and ' +
      'cannot send. This is by construction, not configuration.');
  }
}

function assertCanReceive(adapter) {
  if (!adapter?.capabilities?.inbound || typeof adapter.poll !== 'function') {
    throw new Error('Adapter "' + (adapter?.name ?? 'unknown') + '" has no inbound path.');
  }
}

/**
 * Quiet hours, evaluated in the tenant's own timezone rather than the server's.
 * A server in UTC must not decide 9am for a client in New York.
 */
function withinSendWindow(config, now = new Date()) {
  const w = config?.sendWindow;
  if (!w) return { ok: true };
  const tz = config.timezone || 'America/New_York';

  let parts;
  try {
    parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false,
      }).formatToParts(now).map((p) => [p.type, p.value])
    );
  } catch {
    return { ok: false, reason: 'unknown timezone "' + tz + '"' };
  }

  const day = String(parts.weekday || '').slice(0, 3).toLowerCase();
  // hour12:false yields '24' for midnight in some ICU builds.
  const hour = Number(parts.hour) % 24;

  const days = (w.days || []).map((d) => String(d).slice(0, 3).toLowerCase());
  if (days.length && !days.includes(day)) {
    return { ok: false, reason: 'outside send window (' + day + ' is not a send day)' };
  }
  if (Number.isFinite(w.startHour) && hour < w.startHour) {
    return { ok: false, reason: 'outside send window (' + hour + ':00 is before ' +
      w.startHour + ':00 ' + tz + ')' };
  }
  if (Number.isFinite(w.endHour) && hour >= w.endHour) {
    return { ok: false, reason: 'outside send window (' + hour + ':00 is at or after ' +
      w.endHour + ':00 ' + tz + ')' };
  }
  return { ok: true };
}

function createInterface({ store, adapters, sendEnabled }) {
  /**
   * The global kill switch. An explicit boolean from the host wins; otherwise
   * the environment decides, and anything but the exact string 'true' is off.
   */
  function globalSendEnabled() {
    if (typeof sendEnabled === 'boolean') return sendEnabled;
    return process.env.COMMS_SEND_ENABLED === 'true';
  }

  function adapterFor(name) {
    const a = adapters[name];
    if (!a) {
      throw new Error('No comms adapter named "' + name + '" (have: ' +
        Object.keys(adapters).join(', ') + ')');
    }
    return a;
  }

  /**
   * Every reason this message may not go, not just the first. The status view
   * shows the whole list, so "why didn't this send" is never a guess.
   *
   * @returns {{ allowed: boolean, reasons: string[] }}
   */
  function sendDecision({ config, tenantId, recipient, channel, approval, now = new Date() }) {
    const reasons = [];

    if (!globalSendEnabled()) {
      reasons.push('global send switch is off (COMMS_SEND_ENABLED is not "true")');
    }
    if (config?.comms?.sendEnabled !== true) {
      reasons.push('tenant "' + tenantId + '" has comms.sendEnabled false');
    }
    if (!approval || !approval.approvedBy) {
      reasons.push('no approval record naming a human approver');
    }
    if (recipient && store.isOptedOut(tenantId, recipient, channel)) {
      reasons.push('recipient has opted out on this channel');
    }
    const win = withinSendWindow(config, now);
    if (!win.ok) reasons.push(win.reason);

    return { allowed: reasons.length === 0, reasons };
  }

  /**
   * Queue a message, and transmit it only if every gate opens.
   *
   * Called by an approval flow, never by an agent wanting to fire a live send.
   * Always returns a record; it does not throw when a gate is shut, because a
   * blocked send is a normal, expected outcome.
   */
  async function send({ tenant, config, channel = 'email', to, subject, body,
                        meta = null, approval = null, now = new Date() }) {
    const tenantId = tenant;
    const providerName = config?.comms?.[channel]?.provider ||
      (channel === 'email' ? 'gmail' : null);
    const adapter = adapterFor(providerName);
    assertCanSend(adapter);

    if (!to) throw new Error('send() needs a recipient');
    if (!body) throw new Error('send() needs a body');

    const decision = sendDecision({ config, tenantId, recipient: to, channel, approval, now });

    const outboxId = store.queue({
      tenantId, channel, provider: adapter.name, recipient: to, subject, body,
      status: 'queued',
      blockedReason: decision.allowed ? null : decision.reasons.join('; '),
      approvedBy: approval?.approvedBy ?? null,
      meta,
    });
    store.audit({
      tenantId, outboxId, event: 'queued', channel, provider: adapter.name,
      recipient: to, actor: approval?.approvedBy ?? 'system',
      detail: decision.allowed ? 'all gates open' : decision.reasons.join('; '),
    });

    if (!decision.allowed) {
      return { outboxId, status: 'queued', transmitted: false, reasons: decision.reasons };
    }

    try {
      const res = await adapter.transmit({ tenantId, config, to, subject, body, meta });
      store.markSent(outboxId, res?.id);
      store.audit({
        tenantId, outboxId, event: 'transmitted', channel, provider: adapter.name,
        recipient: to, actor: approval.approvedBy,
        detail: 'provider id ' + (res?.id ?? 'none'),
      });
      return { outboxId, status: 'sent', transmitted: true, reasons: [],
               providerMessageId: res?.id };
    } catch (err) {
      store.markFailed(outboxId, err.message);
      store.audit({
        tenantId, outboxId, event: 'failed', channel, provider: adapter.name,
        recipient: to, actor: approval.approvedBy, detail: err.message,
      });
      return { outboxId, status: 'failed', transmitted: false, reasons: [err.message] };
    }
  }

  /**
   * Draft without any pretence of sending. Identical to send() minus the gate
   * evaluation, for agents that only ever want a queued draft.
   */
  function draft({ tenant, channel = 'email', provider = 'gmail', to, subject, body,
                   meta = null }) {
    const outboxId = store.queue({
      tenantId: tenant, channel, provider, recipient: to, subject, body,
      status: 'queued', blockedReason: 'draft only - not submitted for sending',
      meta,
    });
    store.audit({
      tenantId: tenant, outboxId, event: 'drafted', channel, provider,
      recipient: to, actor: 'system', detail: 'draft-and-queue',
    });
    return { outboxId, status: 'queued', transmitted: false };
  }

  /* -------------------------------------------------------------- inbound -- */

  async function poll({ tenant, config, provider = 'quo', now = new Date() }) {
    const adapter = adapterFor(provider);
    assertCanReceive(adapter);
    return adapter.poll({ tenantId: tenant, config, now });
  }

  /** Every inbound-capable provider a tenant has switched on. */
  function inboundProvidersFor(config) {
    const wanted = config?.comms?.inbound || {};
    return Object.entries(wanted)
      .filter(([name, c]) => c?.enabled && adapters[name]?.capabilities?.inbound)
      .map(([name]) => name);
  }

  async function pollAll({ tenant, config, now = new Date() }) {
    const out = [];
    for (const provider of inboundProvidersFor(config)) {
      try {
        out.push({ provider, ...(await poll({ tenant, config, provider, now })) });
      } catch (err) {
        out.push({ provider, ok: false, error: err.message });
      }
    }
    return out;
  }

  /** What the guardrails are actually doing right now, for a status page. */
  function guardrailState(tenantId, config) {
    return {
      globalSendEnabled: globalSendEnabled(),
      tenantSendEnabled: config?.comms?.sendEnabled === true,
      sendWindow: withinSendWindow(config),
      adapters: Object.values(adapters).map((a) => ({
        name: a.name,
        channel: a.channel,
        outbound: !!a.capabilities?.outbound,
        inbound: !!a.capabilities?.inbound,
        hasTransmit: typeof a.transmit === 'function',
      })),
      messagesActuallySent: tenantId ? store.sentCount(tenantId) : null,
      optOuts: tenantId ? store.listOptOuts(tenantId).length : null,
    };
  }

  return {
    send, draft, poll, pollAll,
    sendDecision, inboundProvidersFor, guardrailState,
    globalSendEnabled, adapterFor,
  };
}

module.exports = { createInterface, assertCanSend, assertCanReceive, withinSendWindow };
