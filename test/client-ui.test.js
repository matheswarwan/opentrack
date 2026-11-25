// Issue drawer helpers (src/ui.js): openIssue / closeIssue set and clear ?issue= and keep the rest of the query.
import { describe, it, expect } from 'vitest';
import { bindRouter, openIssue, closeIssue } from '../src/ui.js';

function fakeRouter(query) {
  const router = {
    currentRoute: { value: { query } },
    replaced: [],
    replace(to) {
      this.replaced.push(to);
      this.currentRoute.value = { query: to.query };
    },
  };
  bindRouter(router);
  return router;
}

describe('issue drawer', () => {
  it('openIssue adds the key and keeps the other query values', () => {
    const r = fakeRouter({ assignee: 'me', page: '2' });
    openIssue('WEB-7');
    expect(r.replaced).toEqual([{ query: { assignee: 'me', page: '2', issue: 'WEB-7' } }]);
  });
  it('opening another issue replaces the key; closeIssue clears it', () => {
    const r = fakeRouter({ issue: 'WEB-7', sort: 'due' });
    openIssue('WEB-8');
    expect(r.replaced[0].query).toEqual({ issue: 'WEB-8', sort: 'due' });
    closeIssue();
    expect(r.replaced[1].query).toEqual({ issue: undefined, sort: 'due' });
  });
});
