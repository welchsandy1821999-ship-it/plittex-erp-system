const fs = require('fs');

const cssPath = 'public/css/modules.css';
let cssContent = fs.readFileSync(cssPath, 'utf8');

const newCSS = `

/* ==========================================================================
   DASHBOARD UTILS & STRUCTURAL (AUDIT-011)
   ========================================================================== */
.min-h-50 { min-height: 50px; }
.text-uppercase { text-transform: uppercase; }
.bg-info-light { background: var(--info-bg); border-radius: 4px; }
.font-black { font-weight: 900; }
.lh-1 { line-height: 1; }

.dash-drill-container {
    overflow: hidden; 
    width: 100%; 
    margin-bottom: 20px; 
    border-radius: 12px; 
    transition: all 0.3s ease;
}

.dashboard-tabs-content {
    display: flex; 
    width: 300%; 
    transition: transform 0.4s ease-in-out, max-height 0.4s ease-in-out, opacity 0.4s ease-in-out; 
    align-items: flex-start; 
    overflow: hidden;
}

.tab-panel-left { width: 33.333%; padding-right: 20px; box-sizing: border-box; }
.tab-panel-center { width: 33.333%; padding-right: 10px; padding-left: 10px; box-sizing: border-box; }
.tab-panel-right { width: 33.333%; padding-left: 20px; box-sizing: border-box; }
`;

fs.appendFileSync(cssPath, newCSS);
console.log('modules.css updated with dashboard structural UI classes.');
