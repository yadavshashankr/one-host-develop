// Legacy Formats
// Readers for older and less common file formats, used by filePreview.js on the device that
// has the file to build a read-only preview. They only pull out text, structure and pictures;
// nothing here runs code from the file. Output HTML is escaped here and cleaned again by the
// receiver before it is shown.
//
// Office 97-2003 files (.doc, .ppt, .msg) are "compound files"; SheetJS's CFB reader opens them.

const LEGACY_MAX_TEXT = 2 * 1024 * 1024; // Characters of text pulled out of one file

const LegacyFormats = {
    escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));
    },

    // Plain text to HTML paragraphs; blank lines separate paragraphs, single newlines become <br>
    textToHtml(text) {
        return String(text).slice(0, LEGACY_MAX_TEXT)
            .split(/\n{2,}|\r/)
            .map(block => block.trim())
            .filter(Boolean)
            .map(block => `<p>${this.escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
            .join('');
    },

    // ---- Compound files (Office 97-2003) ----

    openCompoundFile(bytes, XLSX) {
        if (!XLSX || !XLSX.CFB) throw new Error('Compound file reader missing');
        return XLSX.CFB.read(bytes, { type: 'array' });
    },

    stream(cfb, XLSX, name) {
        const entry = XLSX.CFB.find(cfb, name);
        if (!entry || !entry.content) return null;
        const content = entry.content;
        return content instanceof Uint8Array ? content : Uint8Array.from(content);
    },

    // Word 97-2003 (.doc, .dot): text from the document's piece table
    wordText(cfb, XLSX) {
        const doc = this.stream(cfb, XLSX, 'WordDocument');
        if (!doc || doc.length < 0x200) throw new Error('No WordDocument stream');
        const view = new DataView(doc.buffer, doc.byteOffset, doc.byteLength);
        if (view.getUint16(0, true) !== 0xA5EC) throw new Error('Not a Word 97-2003 document');
        const flags = view.getUint16(0x0A, true);
        if (flags & 0x0100) throw new Error('Encrypted');
        const table = this.stream(cfb, XLSX, (flags & 0x0200) ? '1Table' : '0Table');
        if (!table) throw new Error('No table stream');
        const tableView = new DataView(table.buffer, table.byteOffset, table.byteLength);

        // The FIB has variable-length parts before the fc/lcb pairs; fcClx is pair number 33
        let pos = 32;
        pos += 2 + view.getUint16(pos, true) * 2; // csw, fibRgW
        pos += 2 + view.getUint16(pos, true) * 4; // cslw, fibRgLw
        const pairs = view.getUint16(pos, true);
        pos += 2;
        if (pairs < 34) throw new Error('FIB too short');
        const fcClx = view.getUint32(pos + 33 * 8, true);
        const lcbClx = view.getUint32(pos + 33 * 8 + 4, true);

        // Skip formatting runs (Prc) to the piece table (Pcdt)
        let clx = fcClx;
        const clxEnd = fcClx + lcbClx;
        while (clx < clxEnd && table[clx] === 0x01) clx += 3 + tableView.getInt16(clx + 1, true);
        if (table[clx] !== 0x02) throw new Error('No piece table');
        const plcSize = tableView.getUint32(clx + 1, true);
        const plc = clx + 5;
        const pieces = Math.floor((plcSize - 4) / 12);

        const latin = new TextDecoder('windows-1252');
        const utf16 = new TextDecoder('utf-16le');
        let text = '';
        for (let i = 0; i < pieces && text.length < LEGACY_MAX_TEXT; i++) {
            const cpStart = tableView.getUint32(plc + i * 4, true);
            const cpEnd = tableView.getUint32(plc + (i + 1) * 4, true);
            const pcd = plc + (pieces + 1) * 4 + i * 8;
            const fcValue = tableView.getUint32(pcd + 2, true);
            const compressed = (fcValue & 0x40000000) !== 0;
            const fc = fcValue & 0x3FFFFFFF;
            const count = Math.max(0, cpEnd - cpStart);
            if (compressed) {
                const start = fc / 2;
                text += latin.decode(doc.subarray(start, Math.min(doc.length, start + count)));
            } else {
                text += utf16.decode(doc.subarray(fc, Math.min(doc.length, fc + count * 2)));
            }
        }
        return this.cleanWordText(text);
    },

    cleanWordText(text) {
        return text
            .replace(/\u0013[^\u0013\u0014\u0015]*\u0014/g, '') // Field codes: keep only the shown result
            .replace(/\u0013[^\u0013\u0014\u0015]*\u0015/g, '')
            .replace(/[\u0014\u0015]/g, '')
            .replace(/\u0007/g, '\t')                         // Table cell end
            .replace(/[\u000B\u000C]/g, '\n')                 // Line and page breaks
            .replace(/\r/g, '\n\n')                           // Paragraph end
            .replace(/[\u0000-\u0008\u000E-\u001F]/g, '');
    },

    // PowerPoint 97-2003 (.ppt, .pps, .pot): each slide's title and text
    powerPointSlides(cfb, XLSX) {
        const data = this.stream(cfb, XLSX, 'PowerPoint Document');
        if (!data) throw new Error('No PowerPoint Document stream');
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const latin = new TextDecoder('windows-1252');
        const utf16 = new TextDecoder('utf-16le');
        const listed = [];  // From the slide list (older files keep text here)
        const drawn = [];   // From each slide's drawing (newer files keep text here)
        let headerType = -1;

        const addText = (slides, raw) => {
            const slide = slides[slides.length - 1];
            if (!slide) return;
            const parts = raw.replace(/\u000B/g, '\n').split('\r').map(t => t.trim()).filter(Boolean);
            if (!parts.length) return;
            // Text header types 0 and 6 are the slide title and the title slide's centre title
            if ((headerType === 0 || headerType === 6) && !slide.title) slide.title = parts.shift();
            parts.forEach(part => slide.texts.length < 50 && slide.texts.push(part.slice(0, 300)));
        };

        const walk = (start, end, context) => {
            let pos = start;
            while (pos + 8 <= end) {
                const verInstance = view.getUint16(pos, true);
                const type = view.getUint16(pos + 2, true);
                const length = view.getUint32(pos + 4, true);
                const body = pos + 8;
                const next = body + length;
                if (next > end || next <= pos) break;
                if ((verInstance & 0x0F) === 0x0F) {
                    if (type === 0x0FF0 && (verInstance >> 4) === 0) {
                        walk(body, next, 'list');            // SlideListWithText for slides
                    } else if (type === 0x03EE) {
                        drawn.push({ title: '', texts: [] }); // Slide
                        walk(body, next, 'slide');
                    } else if (type !== 0x03F0 && type !== 0x03F8 && type !== 0x0FF0) {
                        walk(body, next, context);           // Not notes or masters
                    }
                } else if (type === 0x03F3 && context === 'list') {
                    listed.push({ title: '', texts: [] });  // SlidePersistAtom starts the next slide
                } else if (type === 0x0F9F) {
                    headerType = view.getUint32(body, true);
                } else if (type === 0x0FA0 || type === 0x0FA8) {
                    const bytes = data.subarray(body, next);
                    const text = type === 0x0FA0 ? utf16.decode(bytes) : latin.decode(bytes);
                    addText(context === 'list' ? listed : context === 'slide' ? drawn : [], text);
                }
                pos = next;
            }
        };
        walk(0, data.length, null);
        const count = (slides) => slides.reduce((sum, s) => sum + s.texts.length + (s.title ? 1 : 0), 0);
        const slides = count(listed) >= count(drawn) ? listed : drawn;
        if (!slides.length) throw new Error('No slides found');
        return slides;
    },

    // Outlook message (.msg): sender, recipients, subject and plain-text body
    outlookMessage(cfb, XLSX) {
        const read = (id) => {
            const unicode = this.stream(cfb, XLSX, `__substg1.0_${id}001F`);
            if (unicode) return new TextDecoder('utf-16le').decode(unicode).replace(/\u0000+$/, '');
            const ansi = this.stream(cfb, XLSX, `__substg1.0_${id}001E`);
            return ansi ? new TextDecoder('windows-1252').decode(ansi).replace(/\u0000+$/, '') : '';
        };
        const subject = read('0037');
        const fromName = read('0C1A');
        const fromEmail = read('0C1F') || read('5D01');
        const body = read('1000');
        if (!subject && !body) throw new Error('No message found');
        return {
            subject,
            from: fromName && fromEmail && fromName !== fromEmail ? `${fromName} <${fromEmail}>` : (fromName || fromEmail),
            to: read('0E04'),
            cc: read('0E03'),
            body: body.slice(0, LEGACY_MAX_TEXT)
        };
    },

    // ---- Rich Text Format ----

    rtfText(bytes) {
        const source = new TextDecoder('latin1').decode(bytes);
        const latin = new TextDecoder('windows-1252');
        const skipped = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer',
            'headerl', 'headerr', 'headerf', 'footerl', 'footerr', 'footerf', 'footnote', 'themedata',
            'colorschememapping', 'datastore', 'latentstyles', 'listtable', 'listoverridetable', 'rsidtbl',
            'generator', 'xmlnstbl', 'mmathPr', 'filetbl', 'revtbl', 'fldinst', 'bkmkstart', 'bkmkend']);
        const symbols = { par: '\n\n', line: '\n', tab: '\t', emdash: '—', endash: '–', bullet: '•',
            lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', cell: '\t', row: '\n',
            sect: '\n\n', page: '\n\n' };
        const stack = [];
        let state = { skip: false, uc: 1 };
        let out = '';
        let pendingBytes = [];
        const flushBytes = () => {
            if (pendingBytes.length) {
                if (!state.skip) out += latin.decode(new Uint8Array(pendingBytes));
                pendingBytes = [];
            }
        };
        let skipChars = 0;
        for (let i = 0; i < source.length && out.length < LEGACY_MAX_TEXT; i++) {
            const ch = source[i];
            if (ch === '{') {
                flushBytes();
                stack.push(state);
                state = { ...state };
                continue;
            }
            if (ch === '}') {
                flushBytes();
                state = stack.pop() || { skip: false, uc: 1 };
                continue;
            }
            if (ch === '\\') {
                const next = source[i + 1];
                if (next === '\\' || next === '{' || next === '}') {
                    flushBytes();
                    if (!state.skip) out += next;
                    i++;
                    continue;
                }
                if (next === '\'') {
                    const hex = source.substr(i + 2, 2);
                    i += 3;
                    if (skipChars > 0) { skipChars--; continue; }
                    pendingBytes.push(parseInt(hex, 16) || 0x3F);
                    continue;
                }
                if (next === '*') {
                    state.skip = true; // Optional destination this reader doesn't know
                    i++;
                    continue;
                }
                const match = /^([a-zA-Z]+)(-?\d+)? ?/.exec(source.slice(i + 1, i + 40));
                if (!match) {
                    i++;
                    continue;
                }
                flushBytes();
                i += match[0].length;
                const word = match[1];
                const param = match[2] !== undefined ? parseInt(match[2], 10) : null;
                if (skipped.has(word)) state.skip = true;
                else if (word === 'uc' && param !== null) state.uc = param;
                else if (word === 'u' && param !== null) {
                    if (!state.skip) out += String.fromCharCode(param < 0 ? param + 65536 : param);
                    skipChars = state.uc; // The fallback characters that follow \uN
                } else if (symbols[word] && !state.skip) out += symbols[word];
                continue;
            }
            if (ch === '\r' || ch === '\n') continue;
            if (skipChars > 0) { skipChars--; continue; }
            flushBytes();
            if (!state.skip) out += ch;
        }
        flushBytes();
        return out;
    },

    // ---- OpenDocument (.odt, .ott, .odp, .otp) ----

    xmlText(node) {
        let text = '';
        for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
            else if (child.nodeType === Node.ELEMENT_NODE) {
                if (child.localName === 's') text += ' '.repeat(Math.min(100, parseInt(child.getAttribute('text:c'), 10) || 1));
                else if (child.localName === 'tab') text += '\t';
                else if (child.localName === 'line-break') text += '\n';
                else if (child.localName !== 'note' && child.localName !== 'annotation') text += this.xmlText(child);
            }
        }
        return text;
    },

    // OpenDocument text body to HTML; imageFor(href) returns a data URL or null
    async openDocumentHtml(doc, imageFor) {
        const body = doc.getElementsByTagName('office:text')[0];
        if (!body) throw new Error('No text body');
        const escape = (t) => this.escapeHtml(t).replace(/\n/g, '<br>');
        let length = 0;
        const convert = async (node) => {
            let html = '';
            for (const child of node.childNodes) {
                if (length > LEGACY_MAX_TEXT || child.nodeType !== Node.ELEMENT_NODE) continue;
                const name = child.localName;
                let part = '';
                if (name === 'h') {
                    const level = Math.min(6, Math.max(1, parseInt(child.getAttribute('text:outline-level'), 10) || 1));
                    part = `<h${level}>${escape(this.xmlText(child))}</h${level}>`;
                } else if (name === 'p') {
                    const images = [];
                    for (const image of child.getElementsByTagName('draw:image')) {
                        const src = await imageFor(image.getAttribute('xlink:href'));
                        if (src) images.push(`<img src="${src}">`);
                    }
                    part = `<p>${escape(this.xmlText(child))}${images.join('')}</p>`;
                } else if (name === 'list') {
                    const items = [];
                    for (const item of child.childNodes) {
                        if (item.localName === 'list-item') items.push(`<li>${await convert(item)}</li>`);
                    }
                    part = `<ul>${items.join('')}</ul>`;
                } else if (name === 'table') {
                    const rows = [];
                    for (const row of child.getElementsByTagName('table:table-row')) {
                        const cells = [...row.childNodes].filter(c => c.localName === 'table-cell')
                            .map(cell => `<td>${escape(this.xmlText(cell))}</td>`);
                        rows.push(`<tr>${cells.join('')}</tr>`);
                        if (rows.length >= 1000) break;
                    }
                    part = `<table>${rows.join('')}</table>`;
                } else if (name === 'section' || name === 'list-item' || name === 'index-body' ||
                    name === 'table-of-content' || name === 'list-header') {
                    part = await convert(child);
                }
                length += part.length;
                html += part;
            }
            return html;
        };
        return convert(body);
    },

    // OpenDocument presentation: title, text and first picture href of each page
    openDocumentSlides(doc) {
        const slides = [];
        for (const page of doc.getElementsByTagName('draw:page')) {
            let title = '';
            const texts = [];
            for (const frame of page.getElementsByTagName('draw:frame')) {
                const isTitle = /title/.test(frame.getAttribute('presentation:class') || '');
                for (const paragraph of frame.getElementsByTagName('text:p')) {
                    const text = this.xmlText(paragraph).trim().slice(0, 300);
                    if (!text) continue;
                    if (isTitle && !title) title = text;
                    else if (texts.length < 50) texts.push(text);
                }
            }
            const image = page.getElementsByTagName('draw:image')[0];
            slides.push({ title, texts, imageHref: image ? image.getAttribute('xlink:href') : null });
        }
        return slides;
    },

    // ---- tar and tar.gz ----

    async tarEntries(blob, gzipped, maxEntries) {
        let bytes;
        if (gzipped) {
            if (typeof DecompressionStream === 'undefined') throw new Error('No gzip support');
            const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
            bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        } else {
            bytes = new Uint8Array(await blob.arrayBuffer());
        }
        const ascii = (start, length) => {
            let end = start;
            while (end < start + length && bytes[end] !== 0) end++;
            return new TextDecoder('utf-8').decode(bytes.subarray(start, end));
        };
        const entries = [];
        let total = 0;
        let count = 0;
        let longName = null;
        for (let pos = 0; pos + 512 <= bytes.length;) {
            if (bytes[pos] === 0) break; // Two empty blocks end the archive
            const size = parseInt(ascii(pos + 124, 12).trim(), 8) || 0;
            const type = String.fromCharCode(bytes[pos + 156] || 48);
            const body = pos + 512;
            if (type === 'L') {
                longName = ascii(body, size); // GNU long name for the next entry
            } else if (type === '0' || type === '\0' || type === '7') {
                const prefix = ascii(pos + 345, 155);
                const name = longName || (prefix ? `${prefix}/${ascii(pos, 100)}` : ascii(pos, 100));
                longName = null;
                count++;
                total += size;
                if (entries.length < maxEntries) entries.push({ name, size });
            } else if (type !== 'x' && type !== 'g') {
                longName = null; // Folders, links and others aren't listed
            }
            pos = body + Math.ceil(size / 512) * 512;
        }
        if (!count && bytes.length > 0 && !/ustar/.test(ascii(257, 6))) throw new Error('Not a tar archive');
        return { entries, count, total };
    },

    // ---- Photoshop (.psd) ----

    // The flattened image that Photoshop saves alongside the layers ("maximize compatibility"),
    // or, failing that, its small embedded JPEG thumbnail
    photoshop(bytes, maxPixels) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(0) !== 0x38425053) throw new Error('Not a PSD'); // '8BPS'
        if (view.getUint16(4) !== 1) throw new Error('Large document format (PSB) not supported');
        const channels = view.getUint16(12);
        const height = view.getUint32(14);
        const width = view.getUint32(18);
        const depth = view.getUint16(22);
        const mode = view.getUint16(24);
        let pos = 26;
        pos += 4 + view.getUint32(pos); // Colour mode data

        // Image resources: look for the thumbnail (1036, or 1033 in old files)
        const resourcesEnd = pos + 4 + view.getUint32(pos);
        let thumbnail = null;
        for (let r = pos + 4; r + 12 <= resourcesEnd;) {
            if (view.getUint32(r) !== 0x3842494D) break; // '8BIM'
            const id = view.getUint16(r + 4);
            const nameLength = bytes[r + 6];
            let dataStart = r + 6 + 1 + nameLength;
            if ((1 + nameLength) % 2) dataStart++;
            const size = view.getUint32(dataStart);
            const data = dataStart + 4;
            if ((id === 1036 || id === 1033) && view.getUint32(data) === 1) {
                thumbnail = bytes.slice(data + 28, data + size); // JPEG after a 28-byte header
            }
            r = data + size + (size % 2);
        }
        pos = resourcesEnd;
        pos += 4 + view.getUint32(pos); // Layer and mask information

        const supported = depth === 8 && (mode === 3 || mode === 1 || mode === 4) && width * height <= maxPixels;
        const compression = pos + 2 <= bytes.length ? view.getUint16(pos) : -1;
        if (!supported || (compression !== 0 && compression !== 1)) {
            if (thumbnail) return { thumbnail };
            throw new Error('This Photoshop file can\'t be previewed');
        }
        pos += 2;

        const planeSize = width * height;
        const planes = [];
        const used = mode === 1 ? 1 : mode === 4 ? 4 : Math.min(channels, 4);
        if (compression === 1) {
            // PackBits: a table of compressed row lengths comes first, for every channel
            let data = pos + channels * height * 2;
            for (let c = 0; c < channels; c++) {
                const plane = c < used ? new Uint8Array(planeSize) : null;
                for (let y = 0; y < height; y++) {
                    const rowLength = view.getUint16(pos + (c * height + y) * 2);
                    if (plane) {
                        let out = y * width;
                        const rowEnd = out + width;
                        for (let i = data; i < data + rowLength && out < rowEnd;) {
                            const n = (bytes[i] << 24) >> 24; // Signed byte
                            if (n >= 0) {
                                const run = Math.min(n + 1, rowEnd - out);
                                plane.set(bytes.subarray(i + 1, i + 1 + run), out);
                                out += run;
                                i += n + 2;
                            } else if (n !== -128) {
                                const run = Math.min(1 - n, rowEnd - out);
                                plane.fill(bytes[i + 1], out, out + run);
                                out += run;
                                i += 2;
                            } else {
                                i++;
                            }
                        }
                    }
                    data += rowLength;
                }
                if (plane) planes.push(plane);
            }
        } else {
            for (let c = 0; c < used; c++) planes.push(bytes.subarray(pos + c * planeSize, pos + (c + 1) * planeSize));
        }

        const rgba = new Uint8ClampedArray(planeSize * 4);
        for (let i = 0; i < planeSize; i++) {
            let r, g, b;
            if (mode === 1) {
                r = g = b = planes[0][i];
            } else if (mode === 4) {
                // Photoshop stores CMYK inverted; a simple conversion is enough for a preview
                const k = planes[3][i] / 255;
                r = planes[0][i] * k; g = planes[1][i] * k; b = planes[2][i] * k;
            } else {
                r = planes[0][i]; g = planes[1][i]; b = planes[2][i];
            }
            rgba[i * 4] = r;
            rgba[i * 4 + 1] = g;
            rgba[i * 4 + 2] = b;
            rgba[i * 4 + 3] = mode === 3 && planes[3] ? planes[3][i] : 255;
        }
        return { width, height, rgba };
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = LegacyFormats;
} else {
    window.LegacyFormats = LegacyFormats;
}
