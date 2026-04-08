const fs = require('fs');

const css = `
/* ==========================================================================
   DASHBOARD REFACTORING (AUDIT-011) 
   ========================================================================== */

/* Utility: Layout */
.w-full { width: 100%; }
.m-0 { margin: 0; }
.mr-10 { margin-right: 10px; }
.p-0 { padding: 0; }
.p-10 { padding: 10px; }
.p-20 { padding: 20px; }
.h-26 { height: 26px; }
.font-600 { font-weight: 600; }
.block { display: block; }
.mb-10 { margin-bottom: 10px; }

/* Grid Components */
.dash-form-grid-2 {
    grid-template-columns: 1fr 1fr;
}

/* Accordion States */
.dash-acc-icon {
    user-select: none;
}
.dash-acc-body {
    padding: 0 15px 15px 15px;
    border-top: 1px dashed var(--border);
}
.dash-widget-list {
    font-size: 13px;
    color: var(--text-muted);
}
.dash-widget-list-tall {
    min-height: 50px;
}

/* Drilldown Specific */
.dash-drill-container-wrap {
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
.dash-tab-panel {
    width: 33.333%;
    box-sizing: border-box;
}
.dash-tab-panel-1 { padding-right: 20px; }
.dash-tab-panel-2 { padding-right: 10px; padding-left: 10px; }
.dash-tab-panel-3 { padding-left: 20px; }

/* Dashboard Typography & Decorations */
.dash-financial-header {
    text-transform: uppercase;
}
.dash-info-badge {
    background: var(--info-bg);
    border-radius: 4px;
}
.dash-heavy-amount {
    font-weight: 900;
    line-height: 1;
}

/* Inputs */
.dash-period-input { padding: 4px 6px; font-size: 13px; border-radius: 6px; height: 32px; }
.dash-period-input-date { width: 130px; }

`;
fs.appendFileSync('public/css/modules.css', css);
