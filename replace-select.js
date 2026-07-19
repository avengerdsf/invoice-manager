const fs = require('fs');
const buf = fs.readFileSync('src/App.tsx');
const text = new TextDecoder('gb18030').decode(buf);
let output = text;

// Step 1: Remove Select from import
output = output.replace(/,\s*Select\s*\n/, '\n');

// Step 2: Add CustomSelect import
const importLine = "import CustomSelect from './components/CustomSelect'";
if (!output.includes(importLine)) {
  output = output.replace(
    "import {",
    importLine + "\nimport {"
  );
}

// Step 3: Replace category Select in table
const catOld = '<td><Select size=\"small\" disabled={readOnly} value={expense.categoryId} onChange={(event) => onUpdate(expense.id, 'categoryId', event.target.value)}>{project.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</Select></td>';
const catNew = '<td><CustomSelect size=\"small\" disabled={readOnly} value={expense.categoryId} onChange={(value) => onUpdate(expense.id, 'categoryId', value)} options={project.categories.map(c => ({ value: c.id, label: c.name }))} /></td>';

if (output.includes(catOld)) {
  output = output.replace(catOld, catNew);
  console.log('Replaced category Select');
} else {
  console.log('Category Select not found');
}

// Step 4: Replace payer Select
const payerStart = '<Select size=\"small\" disabled={readOnly} value={expense.actualPayer}';
const payerIdx = output.indexOf(payerStart);
if (payerIdx >= 0) {
  const closeIdx = output.indexOf('</Select>', payerIdx);
  if (closeIdx > payerIdx) {
    const newPayer = '<CustomSelect size=\"small\" disabled={readOnly} value={expense.actualPayer} onChange={(value) => onUpdate(expense.id, \'actualPayer\', value)} options={[\n          { value: \'\', label: \'未设置\' },\n          ...payerNames.map(p => ({ value: p, label: p })),\n          ...(expense.actualPayer && !payerNames.includes(expense.actualPayer) ? [{ value: expense.actualPayer, label: expense.actualPayer + \'（已停用）\' }] : [])\n        ]} />';
    output = output.substring(0, payerIdx) + newPayer + output.substring(closeIdx + 9);
    console.log('Replaced payer Select');
  }
} else {
  console.log('Payer Select not found');
}

// Step 5: Replace toolbar Select
const toolbarStart = '<Select\n              className=\"project-select\"';
const toolbarIdx = output.indexOf(toolbarStart);
if (toolbarIdx >= 0) {
  const closeIdx = output.indexOf('</Select>', toolbarIdx);
  if (closeIdx > toolbarIdx) {
    const newToolbar = '<CustomSelect\n              className=\"project-select\"\n              options={[\n                { value: \'__local__\', label: \'从本地打开...\' },\n                ...appSettings.recentProjects.map(rp => ({ value: rp.rootPath, label: rp.name })),\n              ]}\n              value={session?.rootPath ?? \'\'}\n              onChange={(value) => {\n                if (value === \'__local__\') {\n                  void openSession(() => window.invoiceManager.openProject());\n                } else if (value) {\n                  void openSession(() => window.invoiceManager.openRecentProject(value));\n                }\n              }}\n            />';
    output = output.substring(0, toolbarIdx) + newToolbar + output.substring(closeIdx + 9);
    console.log('Replaced toolbar Select');
  }
} else {
  console.log('Toolbar Select not found');
}

// Write back
fs.writeFileSync('src/App.tsx', output, 'utf8');
console.log('Done!');
console.log('Contains <Select:', output.includes('<Select'));
console.log('Contains <CustomSelect:', output.includes('<CustomSelect'));
