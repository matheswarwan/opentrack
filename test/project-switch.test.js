import { describe, it, expect } from 'vitest';
import { orderProjects, boardProjectKey, switchPath, filterProjects, issuesDefaultProject } from '../src/projectSwitch.js';

const P = [
  { id: 1, key: 'WEB', name: 'Website' },
  { id: 2, key: 'BC', name: 'Brand Campaign' },
  { id: 3, key: 'APP', name: 'App' },
];

describe('project switcher', () => {
  it('lists recent projects first, then the rest by name', () => {
    expect(orderProjects(P, ['WEB', 'GONE']).map((p) => p.key)).toEqual(['WEB', 'APP', 'BC']);
  });
  it('Board opens the current project, else the last opened, else the first', () => {
    expect(boardProjectKey('BC', P, ['WEB'])).toBe('BC');
    expect(boardProjectKey(null, P, ['GONE', 'WEB'])).toBe('WEB');
    expect(boardProjectKey(null, P, [])).toBe('APP');
    expect(boardProjectKey(null, [], [])).toBe(null);
  });
  it('switching keeps the project page, issue pages fall back to the board', () => {
    expect(switchPath('/projects/BC/backlog', 'WEB')).toBe('/projects/WEB/backlog');
    expect(switchPath('/projects/BC/raid', 'WEB')).toBe('/projects/WEB/raid');
    expect(switchPath('/projects/BC/status/12/print', 'WEB')).toBe('/projects/WEB/board');
    expect(switchPath('/issues', 'WEB')).toBe('/projects/WEB/board');
  });
  it('filters by key or name', () => {
    expect(filterProjects(P, 'brand').map((p) => p.key)).toEqual(['BC']);
    expect(filterProjects(P, 'ap').map((p) => p.key)).toEqual(['APP']);
    expect(filterProjects(P, ' ').length).toBe(3);
  });
  it('bare Issues opens on the last project unless All projects was picked', () => {
    expect(issuesDefaultProject({}, ['BC', 'WEB'], 'project')).toBe('BC');
    expect(issuesDefaultProject({}, ['BC'], 'all')).toBe(null);
    expect(issuesDefaultProject({ assignee: 'me' }, ['BC'], 'project')).toBe(null); // links keep their own filters
    expect(issuesDefaultProject({}, [], 'project')).toBe(null);
  });
});
