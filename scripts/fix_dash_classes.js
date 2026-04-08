const fs = require('fs');

function fixDuplicateClasses(content) {
    return content.replace(/<([a-zA-Z][^>]*?)class\s*=\s*"([^"]*)"([^>]*?)class\s*=\s*"([^"]*)"([^>]*?)>/g, 
        (match, before, class1, middle, class2, after) => {
            const combined = `${class1} ${class2}`.replace(/\s+/g, ' ').trim();
            return `<${before}class="${combined}"${middle}${after}>`;
        }
    );
}

const file = 'public/js/dashboard.js';
let content = fs.readFileSync(file, 'utf8');
let prev;
do {
    prev = content;
    content = fixDuplicateClasses(content);
} while (content !== prev);
fs.writeFileSync(file, content);
console.log('Dashboard class dups fixed');
