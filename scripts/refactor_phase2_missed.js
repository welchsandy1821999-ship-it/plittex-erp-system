const fs = require('fs');

function replaceSafe(path, replacements) {
    if(!fs.existsSync(path)) return;
    let content = fs.readFileSync(path, 'utf8');
    replacements.forEach(r => {
        content = content.replace(r.from, r.to);
    });
    fs.writeFileSync(path, content);
}

const pEjs = [
    { from: /class="chart-bar"\s*style="border-color: var\(--warning-text\); color: var\(--warning-text\);"/g, to: `class="chart-bar prod-chart-bar-warning"` },
    { from: /class="print-col-hidden"\s*style="display: none; width: 12%;"/g, to: `class="print-col-hidden prod-print-col-hidden"` },
    { from: /class="chart-bar"\s*style="border-color: var\(--primary\);"/g, to: `class="chart-bar prod-chart-bar-primary"` },
    { from: /class="action-panel"\s*style="display: none;"/g, to: `class="action-panel hidden"` }
];

const pJs = [
    { from: /\.style\.display='none'/g, to: `.classList.add('hidden')` },
    { from: /\.style\.cssText = 'position:absolute;width:0;height:0;border:none;'/g, to: `.classList.add('hidden-print-frame')` }
];

const rEjs = [
    { from: /class="btn btn-outline"\s*style="align-items: flex-end;"/g, to: `class="btn btn-outline align-end"` },
    { from: /class="btn btn-primary"\s*style="font-weight: bold; border-radius: 8px; padding: 12px 24px;"/g, to: `class="btn btn-primary rec-action-btn"` },
    { from: /class="mb-15 pl-10"\s*style="border-left: 4px solid var\(--primary\); display: none;"/g, to: `class="mb-15 pl-10 rec-section-title hidden"` },
    { from: /class="form-grid mb-15"\s*style="display: none;"/g, to: `class="form-grid mb-15 hidden"` },
    { from: /id="cost-calc-panel"\s*style="display: none; background: var\(--surface\); padding: 12px; border-radius: 8px; border: 1px dashed var\(--border\); margin-top: 15px;"/g, to: `id="cost-calc-panel" class="rec-dash-box hidden"` },
    { from: /class="flex-between"\s*style="align-items: center; padding-bottom: 20px; border-bottom: 1px dashed var\(--border\);"/g, to: `class="flex-between rec-step-footer"` },
    { from: /class="fw-bold text-main"\s*style="margin-bottom: 0; font-size: 20px;"/g, to: `class="fw-bold text-main m-0 font-20"` },
    { from: /id="recipe-status-badge"\s*style="display: none; padding: 6px 12px; font-size: 13px; font-weight: bold; border-radius: 6px;"/g, to: `id="recipe-status-badge" class="rec-badge hidden"` },
    { from: /class="btn btn-outline"\s*style="height: 42px; padding: 0 25px;"/g, to: `class="btn btn-outline h-42 px-25"` },
    { from: /id="formula-guidance"\s*style="display: none; padding: 20px; font-size: 14px; border: 1px dashed var\(--border\); border-radius: 6px; margin-top: 15px;"/g, to: `id="formula-guidance" class="p-20 font-14 border-dashed border-rounded mt-15 hidden"` }
];

const rJs = [
    { from: /class="btn btn-primary w-100"\s*style="background: var\(--danger\); border-color: var\(--danger\);"/g, to: `class="btn btn-primary w-100 rec-danger-btn"` }
];

replaceSafe('views/modules/production.ejs', pEjs);
replaceSafe('public/js/production.js', pJs);
replaceSafe('views/modules/recipes.ejs', rEjs);
replaceSafe('public/js/recipes.js', rJs);

fs.appendFileSync('public/css/modules.css', `\n.hidden-print-frame { position:absolute; width:0; height:0; border:none; }\n`);
console.log('Missed styles processed.');
