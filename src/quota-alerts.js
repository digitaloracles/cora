const THRESHOLDS = [25, 5];
const NAMES = { claude: "Claude", codex: "ChatGPT", grok: "Grok", muse: "Meta", gemini: "Gemini", kimi: "Kimi", ollama: "Ollama", deepseek: "DeepSeek" };
const KINDS = {
  it: { session: "finestra di 5 ore", weekly: "limite settimanale", monthly: "limite mensile", custom: "limite" },
  en: { session: "5-hour window", weekly: "weekly limit", monthly: "monthly limit", custom: "limit" },
};

/**
 * Tells the owner of a subscription when one of its account-wide quotas falls to 25% and then 5% left:
 * once per threshold and per period of the window (its reset), remembered across restarts.
 */
export class QuotaAlerts {
  constructor({ store, subscriptions, notify, ownerOf = () => "", thresholds = THRESHOLDS, timezone = "Europe/Rome", now = Date.now }) {
    Object.assign(this, { store, subscriptions, notify, ownerOf, thresholds: [...thresholds].sort((a, b) => b - a), timezone, now });
  }

  sent() { return this.store.value("quotaAlertsSent", {}); }

  /**
   * What was already said, by `subscription|window`: the lowest threshold sent and the reset it belongs to.
   * An alert re-arms only when the quota climbs back above the thresholds or its reset passes: a failed reading,
   * a subscription reconnecting or a reset time that drifts by a few seconds never repeat it.
   */
  remembered() {
    const now = this.now(), kept = {};
    for (const [key, entry] of Object.entries(this.sent())) {
      // Earlier versions keyed each period by the hour of its reset: `subscription|window|2026-11-24T13` → threshold.
      const legacy = typeof entry === "number" && key.match(/^(.+\|[^|]+)\|(\d{4}-\d{2}-\d{2}T\d{2})$/);
      const value = legacy ? { threshold: entry, resetsAt: `${legacy[2]}:59:59.999Z` } : entry;
      const id = legacy ? legacy[1] : key;
      if (value && typeof value === "object" && Number.isFinite(value.threshold) && Date.parse(value.resetsAt) > now && !(kept[id]?.threshold <= value.threshold)) kept[id] = value;
    }
    return kept;
  }

  check() {
    const kept = this.remembered(), due = [];
    for (const record of this.subscriptions.list().filter((item) => item.status === "ready")) {
      const usage = this.subscriptions.usage?.get(record.id);
      if (!usage || usage.state !== "ready" || usage.stale) continue;
      for (const window of usage.windows || []) {
        if (window.group || !window.resetsAt || Date.parse(window.resetsAt) <= this.now()) continue;
        const key = `${record.id}|${window.id}`, left = 100 - window.usedPercent;
        const lowest = this.thresholds.filter((threshold) => left <= threshold).at(-1);
        if (lowest === undefined) { delete kept[key]; continue; }
        const previous = kept[key]?.threshold ?? 101;
        if (lowest >= previous) continue;
        kept[key] = { threshold: lowest, resetsAt: kept[key]?.resetsAt || window.resetsAt };
        due.push({ record, window, left, threshold: lowest });
      }
    }
    this.store.setValue("quotaAlertsSent", kept);
    for (const alert of due) this.send(alert);
    return due.length;
  }

  send({ record, window, left, threshold }) {
    const english = this.store.settings.language === "en";
    const words = KINDS[english ? "en" : "it"];
    const name = record.label || NAMES[record.provider] || record.provider;
    const reset = new Date(window.resetsAt);
    const sameDay = reset.toDateString() === new Date(this.now()).toDateString();
    const when = new Intl.DateTimeFormat(english ? "en-GB" : "it-IT", { timeZone: this.timezone, ...(sameDay ? {} : { weekday: "short", day: "numeric" }), hour: "2-digit", minute: "2-digit" }).format(reset);
    const percent = Math.max(0, Math.round(left));
    this.notify({
      userId: this.ownerOf(record),
      title: english ? `${name}: ${percent}% left` : `${name}: resta il ${percent}%`,
      body: english ? `${words[window.kind] || words.custom} · resets ${when}` : `${words[window.kind] || words.custom} · si azzera ${sameDay ? "alle" : ""} ${when}`.replace(/\s+/g, " "),
      url: "/",
      tag: `quota-${record.id}-${window.id}`.slice(0, 64),
      data: { kind: "quota", subscriptionId: record.id, window: window.id, threshold },
    })?.catch?.(() => {});
  }
}
