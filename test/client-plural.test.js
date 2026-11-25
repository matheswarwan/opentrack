// src/plural.js: singular or plural wording for a count.
import { describe, it, expect } from 'vitest';
import { plural, counted } from '../src/plural.js';

describe('plural', () => {
  it('gives the singular word only for exactly one', () => {
    expect(plural(1, 'issue')).toBe('issue');
    expect(plural(0, 'issue')).toBe('issues');
    expect(plural(2, 'issue')).toBe('issues');
    expect(plural(undefined, 'message')).toBe('messages');
  });
  it('takes an irregular plural', () => {
    expect(plural(1, 'reply', 'replies')).toBe('reply');
    expect(plural(3, 'reply', 'replies')).toBe('replies');
    expect(plural(1, 'issue is', 'issues are')).toBe('issue is');
    expect(plural(4, 'issue is', 'issues are')).toBe('issues are');
  });
});

describe('counted', () => {
  it('puts the count before the word', () => {
    expect(counted(1, 'epic')).toBe('1 epic');
    expect(counted(3, 'epic')).toBe('3 epics');
    expect(counted(2, 'story', 'stories')).toBe('2 stories');
  });
});
