import { describe, expect, it } from 'vitest';

import { contract } from '@/lib/ownTreeOnly';

import { requestOf, requestWords, VERB } from './_request-words';

/** #1913: the Inbox, the mock and the API (change_words.py VERB, request_of) word a waiting change by one table. */
describe('request words', () => {
  it('uses the API’s own verb table', () => {
    // The API publishes its table (change_words.VERB) as docs/contracts/api-request-verbs.json.
    const table = contract('api-request-verbs');
    expect(table).toEqual(VERB);
  });

  it('words a change as asked', () => {
    expect(requestWords('Ana', 'changed the owner of F-01 Sign in')).toBe(
      'Ana asks to change the owner of F-01 Sign in',
    );
    expect(requestOf('F-01 Sign in now depends on F-02 Billing page')).toBe(
      'make F-01 Sign in depend on F-02 Billing page',
    );
    expect(requestOf('F-01 Sign in no longer depends on F-02 Billing page')).toBe(
      'make F-01 Sign in no longer depend on F-02 Billing page',
    );
  });
});
