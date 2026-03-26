#!/usr/bin/env node

/**
 * Converts a markdown file into a complete Google Apps Script payload
 * ready to send to google_workspace_run_script.
 *
 * Usage: node bin/md-to-gdoc-payload.js <file-path>
 *
 * Outputs the complete Apps Script code to stdout. Claude reads it and
 * sends it directly as the `code` parameter — zero thinking required.
 *
 * The script includes:
 * - A `var blocks = [...]` array of parsed markdown blocks
 * - The fixed renderer that writes blocks to a Google Doc body
 */

const fs = require('fs');
const path = require('path');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node bin/md-to-gdoc-payload.js <file-path>');
  process.exit(1);
}

const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
let content;
try {
  content = fs.readFileSync(resolved, 'utf-8');
} catch (err) {
  console.error(`Error reading file: ${err.message}`);
  process.exit(1);
}

// --- Preprocess ---
// Strip horizontal rules
content = content.replace(/^-{3,}\s*$/gm, '');
// Strip NOTE: lines
content = content.replace(/^NOTE:.*$/gm, '');
// Replace em dashes
content = content.replace(/\u2014/g, ' - ');
// Collapse excess blank lines
content = content.replace(/\n{4,}/g, '\n\n\n');
content = content.trim();

// --- Parse markdown into blocks ---
const lines = content.split('\n');
const blocks = [];
let tableRows = null;
let lastSpacer = false;

function addSpacer() {
  if (!lastSpacer) { blocks.push({ type: 'spacer' }); lastSpacer = true; }
}

function addBlock(b) {
  blocks.push(b);
  lastSpacer = false;
}

function parseInlineRuns(text) {
  const runs = [];
  let i = 0;
  while (i < text.length) {
    // Bold **...**
    if (text.substr(i, 2) === '**') {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        const boldContent = text.substring(i + 2, end);
        // Check for link inside bold
        const linkMatch = boldContent.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (linkMatch) {
          runs.push({ t: linkMatch[1], b: true, link: linkMatch[2] });
        } else {
          runs.push({ t: boldContent, b: true });
        }
        i = end + 2;
        continue;
      }
    }
    // Italic *...*
    if (text[i] === '*' && (i + 1 >= text.length || text[i + 1] !== '*')) {
      const end = text.indexOf('*', i + 1);
      if (end !== -1 && text[end - 1] !== '*') {
        runs.push({ t: text.substring(i + 1, end), i: true });
        i = end + 1;
        continue;
      }
    }
    // Link [text](url)
    if (text[i] === '[') {
      const cb = text.indexOf(']', i);
      if (cb !== -1 && text[cb + 1] === '(') {
        const cp = text.indexOf(')', cb + 2);
        if (cp !== -1) {
          runs.push({ t: text.substring(i + 1, cb), link: text.substring(cb + 2, cp) });
          i = cp + 1;
          continue;
        }
      }
    }
    // Plain text until next special char
    let nextSpecial = text.length;
    const checks = [
      text.indexOf('**', i + 1),
      text.indexOf('*', i + 1),
      text.indexOf('[', i + 1)
    ];
    for (const c of checks) {
      if (c !== -1 && c < nextSpecial) nextSpecial = c;
    }
    runs.push({ t: text.substring(i, nextSpecial) });
    i = nextSpecial;
  }
  return runs.filter(r => r.t.length > 0);
}

for (let i = 0; i < lines.length; i++) {
  const trimmed = lines[i].trim();

  // Flush table if we're leaving table context
  if (tableRows !== null && !trimmed.match(/^\|/)) {
    addBlock({ type: 'table', rows: tableRows });
    tableRows = null;
    addSpacer();
  }

  // Blank line
  if (trimmed === '') { addSpacer(); continue; }

  // Heading
  const hm = trimmed.match(/^(#{1,4})\s+(.+)$/);
  if (hm) { addBlock({ type: 'h' + hm[1].length, text: hm[2] }); continue; }

  // Table row
  if (trimmed.match(/^\|/)) {
    if (trimmed.match(/^\|[\s\-:|]+\|$/)) continue; // separator row
    const cells = trimmed.split('|').map(c => c.trim()).filter(c => c.length > 0);
    if (tableRows === null) tableRows = [];
    tableRows.push(cells);
    continue;
  }

  // Blockquote
  if (trimmed.match(/^>\s/)) {
    const qt = trimmed.replace(/^>\s+/, '');
    const runs = parseInlineRuns(qt);
    runs.forEach(r => { r.i = true; });
    addBlock({ type: 'p', runs });
    continue;
  }

  // Bullet
  if (trimmed.match(/^[-*]\s/)) {
    addBlock({ type: 'bullet', runs: parseInlineRuns(trimmed.replace(/^[-*]\s+/, '')) });
    continue;
  }

  // Numbered list
  if (trimmed.match(/^\d+\.\s/)) {
    addBlock({ type: 'number', runs: parseInlineRuns(trimmed.replace(/^\d+\.\s+/, '')) });
    continue;
  }

  // Paragraph
  addBlock({ type: 'p', runs: parseInlineRuns(trimmed) });
}

// Flush trailing table
if (tableRows !== null) {
  addBlock({ type: 'table', rows: tableRows });
}

// --- Generate the complete Apps Script ---
// Compact JSON - strip unnecessary whitespace but keep readable enough
const blocksJson = JSON.stringify(blocks);

const script = `var blocks = ${blocksJson};

var body = doc.getBody();
body.clear();

for (var i = 0; i < blocks.length; i++) {
  var b = blocks[i];

  if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3' || b.type === 'h4') {
    var headingMap = {
      'h1': DocumentApp.ParagraphHeading.HEADING1,
      'h2': DocumentApp.ParagraphHeading.HEADING2,
      'h3': DocumentApp.ParagraphHeading.HEADING3,
      'h4': DocumentApp.ParagraphHeading.HEADING4
    };
    body.appendParagraph(b.text).setHeading(headingMap[b.type]);

  } else if (b.type === 'spacer') {
    body.appendParagraph('');

  } else if (b.type === 'p') {
    var p = body.appendParagraph('');
    applyRuns(p, b.runs);

  } else if (b.type === 'bullet' || b.type === 'number') {
    var li = body.appendListItem('');
    li.setGlyphType(b.type === 'bullet' ? DocumentApp.GlyphType.BULLET : DocumentApp.GlyphType.NUMBER);
    applyRuns(li, b.runs);

  } else if (b.type === 'table') {
    var table = body.appendTable(b.rows);
    var headerRow = table.getRow(0);
    for (var c = 0; c < headerRow.getNumCells(); c++) {
      headerRow.getCell(c).editAsText().setBold(true);
    }
  }
}

if (body.getNumChildren() > 1) {
  var first = body.getChild(0);
  if (first.getType() === DocumentApp.ElementType.PARAGRAPH && first.asParagraph().getText() === '') {
    body.removeChild(first);
  }
}

function applyRuns(element, runs) {
  for (var r = 0; r < runs.length; r++) {
    var run = runs[r];
    var text = element.appendText(run.t);
    if (run.b) text.setBold(true);
    if (run.i) text.setItalic(true);
    if (run.link) text.setLinkUrl(run.link);
  }
}

return doc.getUrl();`;

process.stdout.write(script);
