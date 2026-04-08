const fs = require('fs');

const path = 'views/modules/dashboard.ejs';
let content = fs.readFileSync(path, 'utf8');

// 1. hide matrix btn
content = content.replace(
    `style="margin-right: 10px; display: none;"`,
    `class="btn btn-outline mr-10 hidden"`
).replace(
    `<button class="btn btn-outline" class="btn btn-outline mr-10 hidden"`,
    `<button class="btn btn-outline mr-10 hidden"`
);

// 2. dash-stock-card onclick JS
content = content.replace(
    `onclick="const body = document.getElementById('stock-val-body'); body.style.display = body.style.display === 'none' ? 'block' : 'none';"`,
    `onclick="document.getElementById('stock-val-body').classList.toggle('hidden');"`
);

// 3. dash-accordion-body
content = content.replace(
    `class="dash-accordion-body" style="display: none;"`,
    `class="dash-accordion-body hidden"`
);

// 4. form-grid grid-template-columns
content = content.replace(
    `style="grid-template-columns: 1fr 1fr;"`,
    `class="form-grid mb-20 gap-20 align-start grid-cols-2"`
).replace(
    `<div class="form-grid mb-20 gap-20 align-start class="form-grid mb-20 gap-20 align-start grid-cols-2"">`,
    `<div class="form-grid mb-20 gap-20 align-start grid-cols-2">` // Quick fix for over-replacement
).replace(
    `<div class="form-grid mb-20 gap-20 align-start" class="form-grid mb-20 gap-20 align-start grid-cols-2">`,
    `<div class="form-grid mb-20 gap-20 align-start grid-cols-2">` 
);

// 5. widget acc-icon onclick (x2)
content = content.replace(
    /onclick="var b=this.nextElementSibling; var i=this.querySelector\('.acc-icon'\); if\(b\.style\.display==='none'\)\{b\.style\.display='block';i\.innerText='▲';\}else\{b\.style\.display='none';i\.innerText='▼';\}"/g,
    `onclick="var b=this.nextElementSibling; b.classList.toggle('hidden'); var i=this.querySelector('.acc-icon'); i.innerText = b.classList.contains('hidden') ? '▼' : '▲';"`
);

// 6. acc-icon no-select
content = content.replace(
    /style="user-select: none;"/g,
    `class="text-muted font-12 acc-icon no-select"`
).replace(
    /class="text-muted font-12 acc-icon" class="text-muted font-12 acc-icon no-select"/g,
    `class="text-muted font-12 acc-icon no-select"`
);

// 7. widget body display none
content = content.replace(
    /style="display: none; padding: 0 15px 15px 15px; border-top: 1px dashed var\(--border\);"/g,
    `class="hidden px-15 pb-15 border-top-dashed"`
);

// 8. list fonts
content = content.replace(
    /style="font-size: 13px; color: var\(--text-muted\);"/g,
    `class="font-13 text-muted"`
);

content = content.replace(
    /style="font-size: 13px; color: var\(--text-muted\); min-height: 50px;"/g,
    `class="font-13 text-muted min-h-50"`
);

// 9. padding 10
content = content.replace(
    /style="padding: 10px;"/g,
    `class="p-10"`
);

// 10. search container
content = content.replace(
    `id="cc-global-search-container" class="card mt-15 dash-search-container" style="display: none;"`,
    `id="cc-global-search-container" class="card mt-15 dash-search-container hidden"`
);

// 11. dash-drill-container
content = content.replace(
    `style="overflow: hidden; width: 100%; margin-bottom: 20px; border-radius: 12px; transition: all 0.3s ease;"`,
    `class="dash-drill-container"`
);

// 12. dashboard-tabs-content
content = content.replace(
    `style="display: flex; width: 300%; transition: transform 0.4s ease-in-out, max-height 0.4s ease-in-out, opacity 0.4s ease-in-out; align-items: flex-start; transform: translateX(0%); overflow: hidden;"`,
    `class="dashboard-tabs-content collapsed-panel" style="transform: translateX(0%);"`
).replace(
    `class="dashboard-tabs-content collapsed-panel" class="dashboard-tabs-content collapsed-panel"`,
    `class="dashboard-tabs-content collapsed-panel"`
);

// 13. tab panels
content = content.replace(
    `style="width: 33.333%; padding-right: 20px; box-sizing: border-box;"`,
    `class="tab-panel tab-panel-left"`
);
content = content.replace(
    `style="width: 33.333%; padding-right: 10px; padding-left: 10px; box-sizing: border-box;"`,
    `class="tab-panel tab-panel-center"`
);
content = content.replace(
    `style="width: 33.333%; padding-left: 20px; box-sizing: border-box;"`,
    `class="tab-panel tab-panel-right"`
);
content = content.replace(/class="tab-panel" class="tab-panel/g, `class="tab-panel`);

// 14. text-transform uppercase
content = content.replace(
    `style="text-transform: uppercase;"`,
    `class="font-11 text-muted font-bold text-uppercase"`
).replace(
    `class="font-11 text-muted font-bold" class="font-11 text-muted font-bold text-uppercase"`,
    `class="font-11 text-muted font-bold text-uppercase"`
);

// 15. info bg
content = content.replace(
    `style="background: var(--info-bg); border-radius: 4px;"`,
    `class="font-11 text-info p-5 bg-info-light"`
).replace(
    `class="font-11 text-info p-5" class="font-11 text-info p-5 bg-info-light"`,
    `class="font-11 text-info p-5 bg-info-light"`
);

// 16. font-black lh-1
content = content.replace(
    `style="font-weight: 900; line-height: 1;"`,
    `class="font-24 text-warning font-black lh-1"`
).replace(
    `class="font-24 text-warning" class="font-24 text-warning font-black lh-1"`,
    `class="font-24 text-warning font-black lh-1"`
);

fs.writeFileSync(path, content);
console.log('dashboard.ejs inline styles replaced.');
