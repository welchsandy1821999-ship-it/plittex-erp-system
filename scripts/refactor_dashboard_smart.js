const fs = require('fs');

// --- EJS ---
const ejsPath = 'views/modules/dashboard.ejs';
let ejs = fs.readFileSync(ejsPath, 'utf8');

// Rules
const ejsReplacements = [
    { from: `style="margin-right: 10px; display: none;"`, to: `class="btn btn-outline mr-10 hidden"` },
    { from: `onclick="const body = document.getElementById('stock-val-body'); body.style.display = body.style.display === 'none' ? 'block' : 'none';"`, to: `onclick="document.getElementById('stock-val-body').classList.toggle('hidden');"` },
    { from: `class="dash-accordion-body" style="display: none;"`, to: `class="dash-accordion-body hidden"` },
    { from: `class="form-grid mb-20 gap-20 align-start" style="grid-template-columns: 1fr 1fr;"`, to: `class="form-grid mb-20 gap-20 align-start dash-form-grid-2"` },
    { from: `onclick="var b=this.nextElementSibling; var i=this.querySelector('.acc-icon'); if(b.style.display==='none'){b.style.display='block';i.innerText='▲';}else{b.style.display='none';i.innerText='▼';}"`, to: `onclick="var b=this.nextElementSibling; b.classList.toggle('hidden'); var i=this.querySelector('.acc-icon'); i.innerText = b.classList.contains('hidden') ? '▼' : '▲';"` },
    { from: `class="text-muted font-12 acc-icon" style="user-select: none;"`, to: `class="text-muted font-12 acc-icon dash-acc-icon"` },
    { from: `style="display: none; padding: 0 15px 15px 15px; border-top: 1px dashed var(--border);"`, to: `class="dash-acc-body hidden"` },
    { from: `style="font-size: 13px; color: var(--text-muted);"`, to: `class="dash-widget-list"` },
    { from: `style="font-size: 13px; color: var(--text-muted); min-height: 50px;"`, to: `class="dash-widget-list dash-widget-list-tall"` },
    { from: `style="padding: 10px;"`, to: `class="p-10"` },
    { from: `id="cc-global-search-container" class="card mt-15 dash-search-container" style="display: none;"`, to: `id="cc-global-search-container" class="card mt-15 dash-search-container hidden"` },
    { from: `style="overflow: hidden; width: 100%; margin-bottom: 20px; border-radius: 12px; transition: all 0.3s ease;"`, to: `class="dash-drill-container-wrap"` },
    { from: `style="display: flex; width: 300%; transition: transform 0.4s ease-in-out, max-height 0.4s ease-in-out, opacity 0.4s ease-in-out; align-items: flex-start; transform: translateX(0%); overflow: hidden;"`, to: `class="dashboard-tabs-content collapsed-panel" style="transform: translateX(0%);"` },
    { from: `style="width: 33.333%; padding-right: 20px; box-sizing: border-box;"`, to: `class="dash-tab-panel dash-tab-panel-1"` },
    { from: `style="width: 33.333%; padding-right: 10px; padding-left: 10px; box-sizing: border-box;"`, to: `class="dash-tab-panel dash-tab-panel-2"` },
    { from: `style="width: 33.333%; padding-left: 20px; box-sizing: border-box;"`, to: `class="dash-tab-panel dash-tab-panel-3"` },
    { from: `style="text-transform: uppercase;"`, to: `class="dash-financial-header"` },
    { from: `style="background: var(--info-bg); border-radius: 4px;"`, to: `class="dash-info-badge"` },
    { from: `style="font-weight: 900; line-height: 1;"`, to: `class="dash-heavy-amount"` },
];

ejsReplacements.forEach(r => {
    ejs = ejs.split(r.from).join(r.to);
});

fs.writeFileSync(ejsPath, ejs);

// --- JS ---
const jsPath = 'public/js/dashboard.js';
let js = fs.readFileSync(jsPath, 'utf8');

const jsReplacements = [
    { from: `.style.display = 'none'`, to: `.classList.add('hidden')` },
    { from: `.style.display = 'block'`, to: `.classList.remove('hidden')` },
    { from: `searchContainer.style.display = 'none'`, to: `searchContainer.classList.add('hidden')` },
    { from: `searchContainer.style.display = 'block'`, to: `searchContainer.classList.remove('hidden')` },
    { from: `warnEl.style.display = 'block'`, to: `warnEl.classList.remove('hidden')` },
    { from: `warnEl.style.display = 'none'`, to: `warnEl.classList.add('hidden')` },
    { from: `bar.style.display = 'flex'`, to: `bar.classList.remove('hidden')` },
    { from: `bar.style.display = 'none'`, to: `bar.classList.add('hidden')` },
    { from: `container.style.display = 'flex'`, to: `container.classList.remove('hidden')` }, // in renderDashPeriodUI
    { from: `style="padding: 20px; text-align: center;"`, to: `class="p-20 text-center"` },
    { from: `style="height: 26px;"`, to: `class="h-26"` },
    // dynamic bg keep bg and bottom border inline, move the rest
    { 
        from: `style="background: \$\{colors[grp]\}15; padding: 10px 15px; font-weight: bold; color: \$\{colors[grp]\}; border-bottom: 2px solid \$\{colors[grp]\}; text-transform: uppercase;"`, 
        to: `class="p-10 font-bold dash-financial-header" style="background: \$\{colors[grp]\}15; color: \$\{colors[grp]\}; border-bottom: 2px solid \$\{colors[grp]\};"`
    },
    { from: `style="padding: 4px 6px; font-size: 13px; border-radius: 6px; height: 32px; width: 130px;"`, to: `class="dash-period-input dash-period-input-date"` },
    { from: `style="padding: 4px 6px; font-size: 13px; border-radius: 6px; height: 32px;"`, to: `class="dash-period-input"` },
    { from: `container.style.gap = '8px';`, to: `container.classList.add('gap-10');` },
    { from: `style="display: flex; flex-direction: column; gap: 15px;"`, to: `class="flex-col gap-15"` },
    { from: `style="font-weight: bold; font-size: 13px;"`, to: `class="font-bold font-13"` },
    { from: `style="color: var(--primary);"`, to: `class="text-primary"` },
    { from: `style="margin: 0;"`, to: `class="m-0"` },
    { from: `style="font-weight: 600; margin-bottom: 4px; display: block;"`, to: `class="font-600 mb-5 block"` },
    { from: `style="font-size: 14px; padding: 10px;"`, to: `class="font-13 p-10"` }, // normalized size
    { from: `style="font-size: 14px; padding: 10px; font-weight: 600;"`, to: `class="font-13 p-10 font-600"` },
    { from: `style="font-size: 13px; padding: 8px;"`, to: `class="font-13 p-10"` },
    { from: `style="font-weight: bold; margin-bottom: 8px; display: block;"`, to: `class="font-bold mb-10 block"` }
];

jsReplacements.forEach(r => {
    js = js.split(r.from).join(r.to);
});

fs.writeFileSync(jsPath, js);
console.log('Smart replacement finished.');
