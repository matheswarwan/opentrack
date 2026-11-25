// Singular or plural wording for a count, so views do not each write `n === 1 ? '' : 's'`.

/** The word for n things: plural(1, 'issue') is 'issue', plural(2, 'reply', 'replies') is 'replies'. */
export const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);

/** The count and its word: counted(3, 'epic') is '3 epics'. */
export const counted = (n, one, many) => `${n} ${plural(n, one, many)}`;
