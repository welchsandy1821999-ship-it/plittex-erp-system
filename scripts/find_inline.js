const fs = require('fs');

function findStyles(file) {
    if (!fs.existsSync(file)) return;
    const content = fs.readFileSync(file, 'utf-8');
    
    // Find style="..."
    const matchesHtml = content.match(/style="([^"]*)"/g);
    if (matchesHtml) {
        console.log(`\n--- HTML INLINE STYLES in ${file} ---`);
        const unique = [...new Set(matchesHtml)];
        unique.forEach(m => console.log(m));
    }

    // Find style.property = ...
    const matchesJs = content.match(/\.style\.[a-zA-Z]+\s*=\s*['"][^'"]*['"]/g);
    if (matchesJs) {
        console.log(`\n--- JS INLINE STYLES in ${file} ---`);
        const uniqueJs = [...new Set(matchesJs)];
        uniqueJs.forEach(m => console.log(m));
    }
}

findStyles('views/modules/production.ejs');
findStyles('public/js/production.js');
findStyles('views/modules/recipes.ejs');
findStyles('public/js/recipes.js');
