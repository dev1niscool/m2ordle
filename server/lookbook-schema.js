// The private import is validated for builds and API startup, never copied to public assets.
export function validateLookbook(entries, roster) {
  if (!Array.isArray(entries)) throw new Error('The lookbook import must be a list of classmates.');
  const people = new Map(roster.map(person => [person.id, person.name])), seen = new Set();
  for (const entry of entries) {
    if (!entry || !people.has(entry.id) || entry.name !== people.get(entry.id) || seen.has(entry.id)) {
      throw new Error('Each lookbook entry must match a unique roster ID and name.');
    }
    if (!Number.isInteger(entry.page) || entry.page < 1 || typeof entry.sourceName !== 'string' || !entry.sourceName.trim()) {
      throw new Error('Each lookbook entry needs its written source name and PDF page.');
    }
    if (!Array.isArray(entry.facts) || entry.facts.length !== 3 || entry.facts.some(fact => typeof fact !== 'string' || !fact.trim() || fact.length > 3000)) {
      throw new Error('Each matched classmate needs three nonempty lookbook facts.');
    }
    seen.add(entry.id);
  }
  return entries;
}
