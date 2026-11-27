const collator = new Intl.Collator("it", { numeric: true, sensitivity: "base" });

/** Agents as people see them in lists: by name, ignoring case and accents, with "Agent 2" before "Agent 10". */
export function byAgentName(agents) {
  return [...agents].sort((a, b) => collator.compare(String(a.name || ""), String(b.name || "")) || String(a.id).localeCompare(String(b.id)));
}
