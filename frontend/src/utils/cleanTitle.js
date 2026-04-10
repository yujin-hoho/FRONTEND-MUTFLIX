export const cleanTitleOutsideParentheses = (input) => {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const cleaned = raw
    // Remove normal + full-width parentheses content.
    .replace(/\([^()]*\)/g, ' ')
    .replace(/（[^（）]*）/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || raw;
};
