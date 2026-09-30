// Tiny RFC-4180-ish CSV parser. Handles the cases real users hit when
// they export a menu from Excel / Google Sheets:
//   - quoted fields containing commas or newlines
//   - doubled double-quotes ("") as the literal quote escape
//   - CRLF or LF line endings
//   - a leading UTF-8 BOM (Excel adds this on Windows)
//   - blank lines (skipped)
//
// Returns an array of arrays. Callers pull off the first row as the
// header and zip the remaining rows into objects. We avoid pulling in a
// CSV dep for a 40-line problem.

function parseCsv(input) {
    if (typeof input !== 'string') input = String(input || '');
    // Strip UTF-8 BOM
    if (input.charCodeAt(0) === 0xFEFF) input = input.slice(1);

    const rows = [];
    let field = '';
    let row = [];
    let inQuotes = false;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];

        if (inQuotes) {
            if (ch === '"') {
                // Escaped quote ("") inside a quoted field — emit one " and stay in quotes.
                if (input[i + 1] === '"') { field += '"'; i++; }
                else { inQuotes = false; }
            } else {
                field += ch;
            }
            continue;
        }

        if (ch === '"') { inQuotes = true; continue; }
        if (ch === ',') { row.push(field); field = ''; continue; }
        if (ch === '\r') {
            // swallow — the \n in CRLF handles the row break
            continue;
        }
        if (ch === '\n') {
            row.push(field); field = '';
            // Skip blank rows entirely (a CSV with a trailing newline shouldn't add a row).
            if (row.length > 1 || (row.length === 1 && row[0] !== '')) rows.push(row);
            row = [];
            continue;
        }
        field += ch;
    }
    // Trailing record without a final newline
    if (field !== '' || row.length > 0) {
        row.push(field);
        if (row.length > 1 || (row.length === 1 && row[0] !== '')) rows.push(row);
    }

    return rows;
}

module.exports = { parseCsv };
