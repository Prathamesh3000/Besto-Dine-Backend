/**
 * rawOpScan — pure scanner for tenant-unsafe raw operations (task 4.6).
 *
 * Flags, in source text, calls the Mongoose tenantScopePlugin cannot scope
 * by query middleware and that must therefore go through utils/tenantSafe:
 *
 *   X.bulkWrite(          -> tenantBulkWrite(Model, ops, restaurantId)
 *   X.insertMany(         -> tenantInsertMany(Model, docs, restaurantId)
 *   { $lookup: ... }      -> tenantLookup(spec, restaurantId)
 *   { $unionWith: ... }   -> tenantUnionWith(spec, restaurantId)
 *   { $graphLookup: ... } -> (no wrapper) tenant-match the foreign side by hand + exempt
 *   X.estimatedDocumentCount( -> tenantEstimatedCount(Model, restaurantId)
 *
 * A finding is suppressed by `// AUDIT-EXEMPT: <reason>` on the same line or
 * on the line directly above (or, for multi-line pipelines, within the 2
 * lines above). Comment-only lines are never findings.
 */
'use strict';

const RULES = [
    { kind: 'bulkWrite', re: /\.\s*bulkWrite\s*\(/, hint: 'use tenantBulkWrite(Model, ops, restaurantId) from utils/tenantSafe' },
    { kind: 'insertMany', re: /\.\s*insertMany\s*\(/, hint: 'use tenantInsertMany(Model, docs, restaurantId) from utils/tenantSafe' },
    { kind: '$lookup', re: /\$lookup\b/, hint: 'build the stage with tenantLookup(spec, restaurantId), or scope the sub-pipeline and add // AUDIT-EXEMPT: <reason>' },
    { kind: '$unionWith', re: /\$unionWith\b/, hint: 'build the stage with tenantUnionWith(spec, restaurantId), or add // AUDIT-EXEMPT: <reason>' },
    { kind: '$graphLookup', re: /\$graphLookup\b/, hint: 'tenant-match restrictSearchWithMatch and add // AUDIT-EXEMPT: <reason>' },
    { kind: 'estimatedDocumentCount', re: /\.\s*estimatedDocumentCount\s*\(/, hint: 'use tenantEstimatedCount(Model, restaurantId) (countDocuments with restaurant)' },
];

const EXEMPT = /AUDIT-EXEMPT/;
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

/**
 * @param {string} src      file contents
 * @param {string} relName  name used in the report
 * @returns {Array<{file,line,kind,snippet,hint}>}
 */
function scanRawOps(src, relName) {
    const lines = String(src).split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (COMMENT_LINE.test(line)) continue;
        // drop a trailing // comment before matching, but keep it for the exemption test
        const code = line.replace(/\s\/\/.*$/, '');
        for (const rule of RULES) {
            if (!rule.re.test(code)) continue;
            const ctx = [lines[i - 2], lines[i - 1], line].filter(Boolean).join('\n');
            if (EXEMPT.test(ctx)) continue;
            out.push({ file: relName, line: i + 1, kind: rule.kind, snippet: line.trim().slice(0, 140), hint: rule.hint });
        }
    }
    return out;
}

module.exports = { scanRawOps, RULES };
