const fs = require('fs');

const css = fs.readFileSync('src/styles.css', 'utf8');

// Remove all dark mode media queries
let cleaned = css;
// Remove dark mode blocks
const darkStart = cleaned.indexOf('@media (prefers-color-scheme: dark) {');
if (darkStart >= 0) {
  let depth = 0;
  let end = darkStart;
  for (let i = darkStart; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    if (cleaned[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  cleaned = cleaned.slice(0, darkStart) + cleaned.slice(end);
}

fs.writeFileSync('src/styles.css', cleaned, 'utf8');
console.log('Dark mode removed. CSS length:', cleaned.length);
