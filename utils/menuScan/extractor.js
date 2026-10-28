/**
 * Menu reader: sends the menu pages to Claude (vision) and gets back a list of
 * dishes through a forced tool call, so the answer is always structured.
 *
 * Nothing here touches the database. The result is a DRAFT the owner reviews.
 *
 * Tests inject a fake with `setReaderForTests(fn)`; production uses
 * ANTHROPIC_API_KEY (and optional MENU_SCAN_MODEL).
 */
'use strict';

const DEFAULT_MODEL = 'claude-sonnet-5-5';

const TOOL = {
    name: 'record_menu',
    description: 'Record every dish found on the menu pages.',
    input_schema: {
        type: 'object',
        properties: {
            items: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Dish name exactly as printed.' },
                        category: { type: 'string', description: 'Section heading the dish sits under, e.g. Starters. Empty if none visible.' },
                        description: { type: 'string', description: 'Printed description, or empty.' },
                        price: { type: ['number', 'null'], description: 'Main price as a plain number. null if missing or unreadable. NEVER guess.' },
                        price_text: { type: 'string', description: 'The price exactly as printed, e.g. "Rs 240" or "120/220".' },
                        veg_type: { type: 'string', enum: ['veg', 'non-veg', 'unknown'], description: 'From a green/red dot or wording. unknown if not shown.' },
                        sizes: {
                            type: 'array',
                            description: 'Only when the dish prints several prices (Half/Full, S/M/L).',
                            items: {
                                type: 'object',
                                properties: { name: { type: 'string' }, price: { type: 'number' } },
                                required: ['name', 'price'],
                            },
                        },
                        page: { type: 'integer', description: '1-based number of the page the dish is on.' },
                        box: {
                            type: ['object', 'null'],
                            description: 'Rough position of the dish line on its page, as fractions 0..1 of the page.',
                            properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
                        },
                        certainty: { type: 'number', description: '0..1. How sure you are that name AND price were read correctly.' },
                        issues: { type: 'array', items: { type: 'string' }, description: 'Short plain notes, e.g. "price smudged".' },
                    },
                    required: ['name', 'certainty'],
                },
            },
        },
        required: ['items'],
    },
};

const SYSTEM = [
    'You read photographs and PDFs of restaurant menu cards and list every dish on them.',
    'Rules:',
    '- Never invent a dish. Only list what is printed.',
    '- Never guess a price. If a price is blurred, cut off, or ambiguous, set price to null, lower certainty and add an issue.',
    '- Copy names as printed, fixing only obvious scanning noise.',
    '- Use the nearest section heading as the category.',
    '- If one dish shows several prices (Half/Full, Small/Medium/Large), put them in sizes and set price to the lowest.',
    '- Ignore taxes, phone numbers, addresses, slogans and ads.',
    '- Be honest in certainty: 0.9+ only when you can read it clearly, below 0.6 when you are guessing at letters or digits.',
    '- The same dish must not appear twice.',
].join('\n');

let testReader = null;
function setReaderForTests(fn) { testReader = fn; }

function isConfigured() {
    return !!(testReader || (process.env.ANTHROPIC_API_KEY || '').trim());
}

let clientCache = null;
function getClient() {
    if (clientCache) return clientCache;
    const Anthropic = require('@anthropic-ai/sdk');
    const Ctor = Anthropic.default || Anthropic;
    clientCache = new Ctor({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 150000, maxRetries: 1 });
    return clientCache;
}

/**
 * @param {Array<{ index:number, mediaType:string, data:string }>} pages  base64 pages (index is 1-based page number)
 * @returns {Promise<Array<object>>} raw items as returned by the model
 */
async function readMenu(pages) {
    if (testReader) return testReader(pages);
    const content = [];
    for (const p of pages) {
        content.push({ type: 'text', text: `Page ${p.index}:` });
        if (p.mediaType === 'application/pdf') {
            content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data } });
        } else {
            content.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } });
        }
    }
    content.push({ type: 'text', text: 'List every dish on these pages using the record_menu tool.' });
    const res = await getClient().messages.create({
        model: process.env.MENU_SCAN_MODEL || DEFAULT_MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{ role: 'user', content }],
    });
    const block = (res.content || []).find((b) => b.type === 'tool_use' && b.name === TOOL.name);
    return Array.isArray(block?.input?.items) ? block.input.items : [];
}

module.exports = { readMenu, isConfigured, setReaderForTests, TOOL, SYSTEM };
