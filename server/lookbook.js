import {validateLookbook} from './lookbook-schema.js';

export function lookbookById(entries, roster) {
  return new Map(validateLookbook(entries, roster).map(entry => [entry.id, {facts: validateFacts(entry.facts), page: entry.page}]));
}

export function validateFacts(facts, allowEmpty = false) {
  if (!Array.isArray(facts) || (facts.length !== 3 && !(allowEmpty && facts.length === 0)) || facts.some(fact => typeof fact !== 'string' || !fact.trim() || fact.length > 3000)) throw new Error('Choose a classmate with three complete lookbook facts.');
  return facts.map(fact => fact.trim());
}
