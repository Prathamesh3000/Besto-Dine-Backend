const crypto = require('crypto');
const sanitizeHtml = require('sanitize-html');

// Server-side sanitizer for blog post bodies (markdown that may embed raw
// HTML). Strips <script>/<style>/<iframe>, event-handler attributes and
// javascript:/vbscript:/data: URLs while leaving the markdown itself
// intact:
//   - fenced / inline code is set aside untouched (markdown renders it as
//     text, never as HTML);
//   - sanitize-html escapes stray `<` / `>` in text (which would break
//     `> blockquotes` and `a < b`), so those escapes are undone and the
//     pass is repeated until stable — a removed tag can't glue `&lt;` +
//     `script&gt;` back into a live tag;
//   - markdown link / image / reference-definition targets with a
//     dangerous scheme are neutralised to `#`.

const SANITIZE_OPTIONS = {
    allowedTags: [
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'div', 'span',
        'a', 'img', 'figure', 'figcaption',
        'strong', 'b', 'em', 'i', 'u', 's', 'del', 'strike', 'mark', 'small', 'sub', 'sup', 'kbd', 'abbr',
        'code', 'pre', 'blockquote',
        'ul', 'ol', 'li', 'dl', 'dt', 'dd',
        'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
        'details', 'summary',
    ],
    allowedAttributes: {
        a: ['href', 'title', 'target', 'rel', 'name', 'id'],
        img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
        th: ['align', 'colspan', 'rowspan', 'scope'],
        td: ['align', 'colspan', 'rowspan'],
        abbr: ['title'],
        ol: ['start'],
        '*': ['class', 'id'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
    allowProtocolRelative: true,
    disallowedTagsMode: 'discard',
    // Keep entities as written; only bare `&` / `<` / `>` get escaped.
    parser: { decodeEntities: false },
};

const DANGEROUS_SCHEME = /^\s*<?\s*(?:javascript|vbscript|data)\s*:/i;

function neutraliseMarkdownLinks(md) {
    // Inline links / images: [text](target "title")
    let out = md.replace(/(\]\(\s*)([^)\s]*)/g, (m, open, target) => (
        DANGEROUS_SCHEME.test(target) ? `${open}#${target.replace(DANGEROUS_SCHEME, '')}` : m
    ));
    // Reference definitions: [id]: target "title"
    out = out.replace(/^(\s{0,3}\[[^\]\n]+\]:\s*)(\S+)/gm, (m, open, target) => (
        DANGEROUS_SCHEME.test(target) ? `${open}#` : m
    ));
    return out;
}

function sanitizeBlogContent(input) {
    if (input === undefined || input === null) return input;
    let text = String(input);
    const nonce = crypto.randomBytes(8).toString('hex');
    const stash = [];
    const hold = (value) => {
        stash.push(value);
        return `BDSAN${nonce}X${stash.length - 1}X`;
    };

    // Fenced code blocks, then inline code spans — rendered as text.
    text = text.replace(/^([ \t]{0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\2[`~]*[ \t]*$/gm, (m) => hold(m));
    text = text.replace(/(`+)(?!`)[^\n]*?[^`\n]\1(?!`)/g, (m) => hold(m));
    // Entities the author wrote on purpose stay entities.
    text = text.replace(/&(lt|gt);/g, (m) => hold(m));

    text = neutraliseMarkdownLinks(text);

    let prev = null;
    for (let i = 0; i < 5 && text !== prev; i++) {
        prev = text;
        text = unescapeAngles(sanitizeHtml(text, SANITIZE_OPTIONS));
    }
    const converged = text === prev;

    // Escaped form: here every literal `<` / `>` is real tag markup, so a
    // placeholder sitting between them is inside a tag (attribute value)
    // and must be restored escaped — never raw — or code text could break
    // out of the attribute.
    const escaped = sanitizeHtml(text, SANITIZE_OPTIONS);
    // Outside tags the sanitizer's own `&amp;` / `&lt;` / `&gt;` escapes
    // are undone so the stored markdown reads as the author wrote it.
    const TEXT_UNESCAPE = { '&lt;': '<', '&gt;': '>', '&amp;': '&' };
    const token = new RegExp(`&lt;|&gt;|&amp;|BDSAN${nonce}X(\\d+)X`, 'g');
    return escaped.replace(token, (m, idx, offset) => {
        const insideTag = escaped.lastIndexOf('<', offset) > escaped.lastIndexOf('>', offset);
        if (idx === undefined) return converged && !insideTag ? TEXT_UNESCAPE[m] : m;
        const value = stash[Number(idx)] ?? '';
        return converged && !insideTag ? value : escapeAttr(value);
    });
}

function unescapeAngles(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function escapeAttr(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

module.exports = { sanitizeBlogContent };
