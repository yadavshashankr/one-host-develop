// File Preview Service
// Read-only preview of sent and received files in an overlay on the same page,
// so peer connections and transfers are never interrupted (no new tab, no navigation).
//
// Received files are never transferred to preview them. The receiver asks the sender for a
// preview and the sender builds a small one from its own copy (createPreview): a reduced image,
// a slice of text, or a zip's file list. If the sender can't (older version, file too big,
// unreadable), the overlay shows "Preview unavailable". Received videos and audio will stream;
// until then they show "Preview unavailable" too.
//
// Images, text/code and zip listings zoom by pinch, Ctrl/Cmd + scroll, the +/- keys or the
// on-screen controls. Video and audio use the browser's own player.

const PREVIEW_EXTENSIONS = {
    image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'heic', 'heif'],
    video: ['mp4', 'm4v', 'webm', 'mov', 'ogv'],
    audio: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac'],
    text: ['txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf',
        'env', 'html', 'htm', 'css', 'scss', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'php', 'java', 'kt',
        'swift', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'bash', 'zsh', 'bat', 'ps1', 'sql', 'srt', 'vtt'],
    zip: ['zip']
};

// MIME types for files sent without one; images, video and audio need a real type to render
const PREVIEW_MIME_TYPES = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', heic: 'image/heic',
    heif: 'image/heif', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    ogv: 'video/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac'
};

const PREVIEW_IMAGE_MAX_SIDE = 2048;              // Long side of a reduced image
const PREVIEW_IMAGE_SEND_ORIGINAL = 1.5 * 1024 * 1024; // Smaller images are sent as they are
const PREVIEW_GIF_SEND_ORIGINAL = 8 * 1024 * 1024;     // GIFs keep their animation up to this size
const PREVIEW_TEXT_PART = 256 * 1024;             // Bytes of text per part ("Load more" fetches the next)
const PREVIEW_ZIP_MAX_ENTRIES = 5000;
// Largest file the sender will open to build a preview (a phone sender has less memory)
const PREVIEW_SENDER_MAX_BYTES = {
    image: { mobile: 100 * 1024 * 1024, desktop: 300 * 1024 * 1024 },
    zip: { mobile: 300 * 1024 * 1024, desktop: 1024 * 1024 * 1024 }
};

const ZOOM_LIMITS = {
    image: { min: 0.5, max: 8 },
    text: { min: 0.5, max: 4 },
    zip: { min: 0.5, max: 4 }
};
const ZOOM_STEP = 1.25;

// An error whose message is meant for the person looking at the preview
class PreviewUnavailableError extends Error {}

class FilePreview {
    constructor() {
        this.overlay = null;
        this.session = null; // State of the preview that is open, null when closed
        this.previewCache = new WeakMap(); // blob -> Promise of its image or zip preview (sender side)
        this.onPopState = this.onPopState.bind(this);
        this.onKeyDown = this.onKeyDown.bind(this);
    }

    // 'image', 'video', 'audio', 'text', 'zip' or null when the type can't be previewed
    getPreviewKind(name, mimeType = '') {
        const ext = this.getExtension(name);
        const type = (mimeType || '').toLowerCase();
        for (const [kind, extensions] of Object.entries(PREVIEW_EXTENSIONS)) {
            if (extensions.includes(ext)) return kind;
        }
        if (type.startsWith('image/')) return 'image';
        if (type.startsWith('video/')) return 'video';
        if (type.startsWith('audio/')) return 'audio';
        if (type.includes('zip')) return 'zip';
        if (type.startsWith('text/') || /json|xml|javascript|yaml/.test(type)) return 'text';
        return null;
    }

    canPreview(name, mimeType) {
        return this.getPreviewKind(name, mimeType) !== null;
    }

    getExtension(name) {
        const dot = (name || '').lastIndexOf('.');
        return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
    }

    getMimeType(name, mimeType) {
        if (mimeType && mimeType !== 'application/octet-stream') return mimeType;
        return PREVIEW_MIME_TYPES[this.getExtension(name)] || mimeType || '';
    }

    isMobile() {
        return /mobile|android|iphone|ipad|tablet/i.test(navigator.userAgent);
    }

    // ---- Building previews (runs on the device that has the file) ----

    /**
     * Small, read-only preview of a file this device has.
     * image: { kind, data, mime, reduced }   text: { kind, data, offset, nextOffset, size }
     * zip:   { kind, entries: [{ name, size }], count, total }
     * data is an ArrayBuffer so it can be sent to a peer (a Blob when local is true).
     * @param {object} part - { offset } for the next slice of a text file
     * @param {boolean} local - Preview on this same device: images are shown at full quality
     */
    async createPreview(blob, name, mimeType, { offset = 0, local = false } = {}) {
        const kind = this.getPreviewKind(name, mimeType);
        const device = this.isMobile() ? 'mobile' : 'desktop';
        if (kind === 'text') {
            const start = Math.max(0, Math.min(blob.size, Number(offset) || 0));
            const end = Math.min(blob.size, start + PREVIEW_TEXT_PART);
            const slice = blob.slice(start, end);
            return { kind, data: local ? slice : await slice.arrayBuffer(), offset: start, nextOffset: end, size: blob.size };
        }
        if (kind === 'image') {
            const mime = this.getMimeType(name, mimeType || blob.type);
            if (local) return { kind, data: blob, mime, reduced: false };
            const keepOriginal = blob.size <= PREVIEW_IMAGE_SEND_ORIGINAL ||
                (mime === 'image/gif' && blob.size <= PREVIEW_GIF_SEND_ORIGINAL);
            if (keepOriginal) return { kind, data: await blob.arrayBuffer(), mime, reduced: false };
            if (blob.size > PREVIEW_SENDER_MAX_BYTES.image[device]) {
                throw new PreviewUnavailableError('This image is too large to preview.');
            }
            return this.cached(blob, () => this.reduceImage(blob, mime));
        }
        if (kind === 'zip') {
            if (blob.size > PREVIEW_SENDER_MAX_BYTES.zip[device]) {
                throw new PreviewUnavailableError('This zip is too large to preview.');
            }
            return this.cached(blob, () => this.listZip(blob));
        }
        throw new PreviewUnavailableError('This file type can\'t be previewed.');
    }

    cached(blob, build) {
        if (!this.previewCache.has(blob)) {
            const promise = build();
            this.previewCache.set(blob, promise);
            promise.catch(() => this.previewCache.delete(blob)); // Let a later request try again
        }
        return this.previewCache.get(blob);
    }

    async reduceImage(blob, mime) {
        const url = URL.createObjectURL(mime && blob.type !== mime ? new Blob([blob], { type: mime }) : blob);
        try {
            const img = await new Promise((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = () => reject(new PreviewUnavailableError('This image format can\'t be previewed.'));
                image.src = url;
            });
            const width = img.naturalWidth || PREVIEW_IMAGE_MAX_SIDE;
            const height = img.naturalHeight || PREVIEW_IMAGE_MAX_SIDE;
            const scale = Math.min(1, PREVIEW_IMAGE_MAX_SIDE / Math.max(width, height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            // WebP keeps transparency and is small; browsers that can't encode it (Safari) fall back
            const encode = (type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));
            let out = await encode('image/webp', 0.85);
            if (!out || out.type !== 'image/webp') {
                out = await encode(mime === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.85);
            }
            if (!out) throw new PreviewUnavailableError('This image couldn\'t be previewed.');
            return { kind: 'image', data: await out.arrayBuffer(), mime: out.type, reduced: true };
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    async listZip(blob) {
        if (typeof JSZip === 'undefined') throw new PreviewUnavailableError('Zip preview isn\'t available.');
        let zip;
        try {
            zip = await JSZip.loadAsync(blob);
        } catch (error) {
            throw new PreviewUnavailableError('This zip couldn\'t be read.');
        }
        const files = Object.values(zip.files)
            .filter(entry => !entry.dir && !entry.name.startsWith('__MACOSX/'))
            .sort((a, b) => a.name.localeCompare(b.name));
        const sizeOf = entry => entry._data?.uncompressedSize || 0;
        return {
            kind: 'zip',
            entries: files.slice(0, PREVIEW_ZIP_MAX_ENTRIES).map(entry => ({ name: entry.name, size: sizeOf(entry) })),
            count: files.length,
            total: files.reduce((sum, entry) => sum + sizeOf(entry), 0)
        };
    }

    // ---- Overlay ----

    /**
     * Open the preview.
     * @param {{id, name, type, size}} fileInfo
     * @param {object} options
     * @param {Blob} [options.blob] - The file itself, for files this device sent
     * @param {(part, signal) => Promise<object>} [options.requestPreview] - Asks the sender of a
     *     received file for a preview (see createPreview); part is { offset } for more text
     * @param {() => void} [options.save] - Downloads the file
     */
    open(fileInfo, { blob = null, requestPreview = null, save = null } = {}) {
        // Opening over another preview reuses its history entry
        this.close({ keepHistory: true });
        this.build();

        const kind = this.getPreviewKind(fileInfo.name, fileInfo.type);
        const controller = new AbortController();
        const loadPart = blob
            ? (part) => this.createPreview(blob, fileInfo.name, fileInfo.type || blob.type, { ...part, local: true })
            : requestPreview;
        this.session = {
            fileInfo, kind, save, controller, loadPart,
            urls: [], zoom: 1, zoomKind: null, pointers: new Map(), pinch: null
        };

        this.title.textContent = fileInfo.name;
        this.subtitle.textContent = this.formatSize(fileInfo.size);
        this.saveButton.hidden = !save;
        this.setZoomControls(false);
        this.stage.className = 'preview-stage';
        this.stage.replaceChildren();

        this.overlay.hidden = false;
        document.body.classList.add('preview-open');
        // The phone's back button closes the preview instead of leaving the page (and its connections)
        if (history.state && history.state.filePreview) {
            history.replaceState({ filePreview: true }, '');
        } else {
            history.pushState({ filePreview: true }, '');
        }
        window.addEventListener('popstate', this.onPopState);
        document.addEventListener('keydown', this.onKeyDown);
        this.closeButton.focus();

        if (typeof Analytics !== 'undefined') {
            Analytics.track('file_preview_opened', {
                preview_kind: kind || 'none',
                file_type: this.getExtension(fileInfo.name),
                source: blob ? 'sent' : 'received'
            });
        }

        if (!kind) {
            this.showUnavailable('This file type can\'t be previewed.');
            return;
        }
        if (kind === 'video' || kind === 'audio') {
            // Sent: play this device's own copy. Received: streaming will come; nothing is transferred
            if (blob) this.renderMedia(blob, kind);
            else this.showUnavailable(`This ${kind} can't be played here yet.`);
            return;
        }
        if (!loadPart) {
            this.showUnavailable('The file isn\'t available.');
            return;
        }

        this.showLoading();
        const session = this.session;
        loadPart({}, controller.signal).then(preview => {
            if (this.session === session) return this.renderPreview(preview);
        }).catch(error => {
            if (this.session !== session || error.name === 'AbortError') return;
            console.warn('Preview unavailable:', error);
            this.showUnavailable(error instanceof PreviewUnavailableError ? error.message : '');
        });
    }

    close({ fromHistory = false, keepHistory = false } = {}) {
        if (!this.session) return;
        const session = this.session;
        this.session = null;
        session.controller.abort();
        session.urls.forEach(url => URL.revokeObjectURL(url));

        if (document.fullscreenElement && this.overlay.contains(document.fullscreenElement)) {
            document.exitFullscreen().catch(() => {});
        }
        this.stage.querySelectorAll('video, audio').forEach(media => media.pause());
        this.stage.replaceChildren();
        this.overlay.hidden = true;
        document.body.classList.remove('preview-open');
        window.removeEventListener('popstate', this.onPopState);
        document.removeEventListener('keydown', this.onKeyDown);
        // Drop the history entry added on open, unless the back button already did
        if (!fromHistory && !keepHistory && history.state && history.state.filePreview) {
            history.back();
        }
    }

    onPopState() {
        // A late popstate from closing an earlier preview can land on this preview's entry
        if (history.state && history.state.filePreview) return;
        this.close({ fromHistory: true });
    }

    onKeyDown(e) {
        if (!this.session) return;
        if (e.key === 'Escape') {
            // Leaving fullscreen with Escape shouldn't also close the preview
            if (!document.fullscreenElement) this.close();
            return;
        }
        if (!this.session.zoomKind || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.target instanceof HTMLInputElement) return;
        if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomBy(ZOOM_STEP); }
        else if (e.key === '-' || e.key === '_') { e.preventDefault(); this.zoomBy(1 / ZOOM_STEP); }
        else if (e.key === '0') { e.preventDefault(); this.setZoom(1); }
    }

    build() {
        if (this.overlay) return;
        const overlay = document.createElement('div');
        overlay.className = 'file-preview-overlay';
        overlay.hidden = true;
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'file-preview-title');
        overlay.innerHTML = `
            <div class="preview-header">
                <div class="preview-heading">
                    <span class="preview-title" id="file-preview-title" translate="no"></span>
                    <span class="preview-subtitle" translate="no"></span>
                </div>
                <button type="button" class="preview-action preview-save" title="Download file" aria-label="Download file">
                    <span class="material-icons" translate="no">download</span>
                </button>
                <button type="button" class="preview-action preview-close" title="Close preview" aria-label="Close preview">
                    <span class="material-icons" translate="no">close</span>
                </button>
            </div>
            <div class="preview-stage"></div>
            <div class="preview-zoom" hidden>
                <button type="button" class="preview-action" data-zoom="out" title="Zoom out" aria-label="Zoom out">
                    <span class="material-icons" translate="no">zoom_out</span>
                </button>
                <button type="button" class="preview-zoom-level" data-zoom="reset" title="Fit to screen" aria-label="Fit to screen">100%</button>
                <button type="button" class="preview-action" data-zoom="in" title="Zoom in" aria-label="Zoom in">
                    <span class="material-icons" translate="no">zoom_in</span>
                </button>
            </div>`;
        document.body.appendChild(overlay);

        this.overlay = overlay;
        this.title = overlay.querySelector('.preview-title');
        this.subtitle = overlay.querySelector('.preview-subtitle');
        this.stage = overlay.querySelector('.preview-stage');
        this.saveButton = overlay.querySelector('.preview-save');
        this.closeButton = overlay.querySelector('.preview-close');
        this.zoomBar = overlay.querySelector('.preview-zoom');
        this.zoomLevel = overlay.querySelector('.preview-zoom-level');

        this.closeButton.addEventListener('click', () => this.close());
        this.saveButton.addEventListener('click', () => {
            const session = this.session;
            if (session && session.save) session.save();
        });
        this.zoomBar.addEventListener('click', (e) => {
            const action = e.target.closest('[data-zoom]')?.dataset.zoom;
            if (action === 'in') this.zoomBy(ZOOM_STEP);
            else if (action === 'out') this.zoomBy(1 / ZOOM_STEP);
            else if (action === 'reset') this.setZoom(1);
        });
        // Clicking the dark area around a picture or player closes the preview
        this.stage.addEventListener('click', (e) => {
            const backdrop = e.target === this.stage || e.target.classList.contains('preview-media');
            if (backdrop && !this.session?.zoomKind) this.close();
        });
        this.setUpGestures();
    }

    showLoading() {
        const box = document.createElement('div');
        box.className = 'preview-message preview-loading';
        box.innerHTML = `
            <div class="preview-spinner" aria-hidden="true"></div>
            <span class="preview-message-title">Loading preview…</span>`;
        this.stage.className = 'preview-stage';
        this.stage.replaceChildren(box);
    }

    showUnavailable(reason) {
        this.setZoomControls(false);
        if (this.session) this.session.zoomKind = null;
        const box = document.createElement('div');
        box.className = 'preview-message';
        box.innerHTML = `
            <span class="material-icons preview-message-icon" translate="no">visibility_off</span>
            <span class="preview-message-title">Preview unavailable</span>
            <span class="preview-message-text"></span>`;
        box.querySelector('.preview-message-text').textContent = reason || '';
        this.stage.className = 'preview-stage';
        this.stage.replaceChildren(box);
    }

    // ---- Renderers ----

    // Shows a preview from createPreview. A received one came from another device, so only the
    // fields each kind needs are used, and only as an image, plain text or text labels.
    async renderPreview(preview) {
        const session = this.session;
        try {
            if (!preview || preview.kind !== session.kind) throw new Error('Unexpected preview');
            switch (preview.kind) {
                case 'image': await this.renderImage(preview); break;
                case 'text': this.renderText(preview); break;
                case 'zip': this.renderZip(preview); break;
            }
        } catch (error) {
            if (this.session !== session) return;
            console.warn('Preview render failed:', error);
            this.showUnavailable('This browser can\'t display this file.');
        }
    }

    trackUrl(blob) {
        const url = URL.createObjectURL(blob);
        this.session.urls.push(url);
        return url;
    }

    renderImage(preview) {
        const session = this.session;
        const mime = String(preview.mime || '');
        if (!mime.startsWith('image/')) throw new Error('Not an image');
        const blob = preview.data instanceof Blob && preview.data.type === mime
            ? preview.data
            : new Blob([preview.data], { type: mime });
        if (preview.reduced) this.subtitle.textContent = `${this.formatSize(session.fileInfo.size)} · reduced preview`;

        return new Promise((resolve, reject) => {
            const img = new Image();
            img.className = 'preview-image';
            img.alt = session.fileInfo.name;
            img.draggable = false;
            img.onload = () => {
                if (this.session !== session) return resolve();
                const content = document.createElement('div');
                content.className = 'preview-content';
                content.appendChild(img);
                this.stage.className = 'preview-stage preview-stage-zoomable';
                this.stage.replaceChildren(content);
                session.zoomKind = 'image';
                session.natural = { width: img.naturalWidth || 800, height: img.naturalHeight || 600 };
                this.setZoomControls(true);
                this.setZoom(1);
                resolve();
            };
            img.onerror = () => reject(new Error('Image could not be decoded'));
            img.src = this.trackUrl(blob); // SVG shown as an image never runs scripts
        });
    }

    renderMedia(blob, tag) {
        const mime = this.getMimeType(this.session.fileInfo.name, blob.type);
        const media = document.createElement(tag);
        media.className = `preview-${tag}`;
        media.controls = true;
        media.preload = 'metadata';
        if (tag === 'video') {
            media.playsInline = true; // iPhone: play inline, fullscreen only when asked
            media.setAttribute('webkit-playsinline', '');
        }
        media.addEventListener('error', () => {
            if (this.session && this.stage.contains(media)) {
                this.showUnavailable(`This browser can't play this ${tag} format.`);
            }
        });
        media.src = this.trackUrl(mime && blob.type !== mime ? new Blob([blob], { type: mime }) : blob);

        const wrapper = document.createElement('div');
        wrapper.className = `preview-media preview-media-${tag}`;
        if (tag === 'audio') {
            const icon = document.createElement('span');
            icon.className = 'material-icons preview-audio-icon';
            icon.setAttribute('translate', 'no');
            icon.textContent = 'audiotrack';
            wrapper.appendChild(icon);
        }
        wrapper.appendChild(media);
        this.stage.className = 'preview-stage';
        this.stage.replaceChildren(wrapper);
    }

    // First part of a text file; "Load more" asks for the next part and adds it below
    async renderText(preview) {
        const session = this.session;
        session.textDecoder = new TextDecoder('utf-8');
        const text = await this.decodeTextPart(preview);
        if (this.session !== session) return;
        // Binary data mislabelled as text would show as garbage
        if (text.slice(0, 4096).includes('\u0000')) {
            this.showUnavailable('This file doesn\'t contain readable text.');
            return;
        }

        const card = document.createElement('div');
        card.className = 'preview-text-card';
        const pre = document.createElement('pre');
        pre.className = 'preview-text';
        pre.setAttribute('translate', 'no');
        pre.textContent = text; // Never parsed as HTML
        card.appendChild(pre);
        this.showDocument(card, 'text');
        this.updateLoadMore(card, preview);
    }

    async decodeTextPart(preview) {
        const bytes = preview.data instanceof Blob ? await preview.data.arrayBuffer() : preview.data;
        const last = !(preview.nextOffset < preview.size);
        // stream: a character split between two parts is decoded once the next part arrives
        return this.session.textDecoder.decode(new Uint8Array(bytes), { stream: !last });
    }

    updateLoadMore(card, preview) {
        card.querySelector('.preview-load-more')?.remove();
        const nextOffset = Number(preview.nextOffset);
        const size = Number(preview.size);
        if (!(nextOffset < size)) return;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'preview-load-more';
        button.textContent = `Load more (${this.formatSize(nextOffset)} of ${this.formatSize(size)} shown)`;
        button.addEventListener('click', async () => {
            const session = this.session;
            button.disabled = true;
            button.textContent = 'Loading…';
            try {
                const next = await session.loadPart({ offset: nextOffset }, session.controller.signal);
                if (this.session !== session) return;
                if (!next || next.kind !== 'text' || Number(next.offset) !== nextOffset) throw new Error('Unexpected preview');
                card.querySelector('.preview-text').append(await this.decodeTextPart(next));
                this.updateLoadMore(card, next);
            } catch (error) {
                if (this.session !== session || error.name === 'AbortError') return;
                console.warn('Loading more text failed:', error);
                button.disabled = false;
                button.textContent = 'Couldn\'t load more. Tap to try again.';
            }
        });
        card.appendChild(button);
    }

    renderZip(preview) {
        const entries = Array.isArray(preview.entries) ? preview.entries : [];
        const count = Number(preview.count) || entries.length;

        const panel = document.createElement('div');
        panel.className = 'preview-zip';
        const summary = document.createElement('div');
        summary.className = 'preview-zip-summary';
        summary.textContent = `${count} file${count === 1 ? '' : 's'} · ${this.formatSize(Number(preview.total) || 0)} unpacked`;
        const list = document.createElement('ul');
        list.className = 'preview-zip-list';
        entries.slice(0, PREVIEW_ZIP_MAX_ENTRIES).forEach(entry => {
            const li = document.createElement('li');
            const icon = document.createElement('span');
            icon.className = 'material-icons';
            icon.setAttribute('translate', 'no');
            icon.textContent = 'insert_drive_file';
            const name = document.createElement('span');
            name.className = 'preview-zip-name';
            name.setAttribute('translate', 'no');
            name.textContent = String(entry && entry.name);
            const size = document.createElement('span');
            size.className = 'preview-zip-size';
            size.textContent = this.formatSize(Number(entry && entry.size) || 0);
            li.append(icon, name, size);
            list.appendChild(li);
        });
        panel.append(summary, list);
        if (count > entries.length) {
            const more = document.createElement('div');
            more.className = 'preview-zip-summary';
            more.textContent = `… and ${count - entries.length} more`;
            panel.appendChild(more);
        }
        this.showDocument(panel, 'zip');
    }

    // Text and zip listings: a readable card that zooms by scaling its text size
    showDocument(element, zoomKind) {
        const content = document.createElement('div');
        content.className = 'preview-content preview-document';
        content.appendChild(element);
        this.stage.className = 'preview-stage preview-stage-zoomable preview-stage-document';
        this.stage.replaceChildren(content);
        this.session.zoomKind = zoomKind;
        this.setZoomControls(true);
        this.setZoom(1);
    }

    // ---- Zoom ----

    setZoomControls(visible) {
        this.zoomBar.hidden = !visible;
    }

    zoomBy(factor, focusX, focusY) {
        if (this.session) this.setZoom(this.session.zoom * factor, focusX, focusY);
    }

    // zoom is relative to "fit": 1 means the picture fits the screen, or text at its normal size.
    // focusX/focusY (relative to the stage) stay under the finger or cursor while zooming.
    setZoom(zoom, focusX, focusY) {
        const session = this.session;
        if (!session || !session.zoomKind) return;
        const limits = ZOOM_LIMITS[session.zoomKind];
        const next = Math.min(limits.max, Math.max(limits.min, zoom));
        const stage = this.stage;
        const content = stage.firstElementChild;
        if (!content) return;

        const fx = focusX ?? stage.clientWidth / 2;
        const fy = focusY ?? stage.clientHeight / 2;
        const ratioX = (stage.scrollLeft + fx) / Math.max(1, stage.scrollWidth);
        const ratioY = (stage.scrollTop + fy) / Math.max(1, stage.scrollHeight);

        session.zoom = next;
        if (session.zoomKind === 'image') {
            const img = content.querySelector('img');
            const pad = 32;
            const fit = Math.min(
                (stage.clientWidth - pad) / session.natural.width,
                (stage.clientHeight - pad) / session.natural.height,
                1 // Small pictures aren't blown up to fit
            );
            img.style.width = `${Math.max(1, session.natural.width * fit * next)}px`;
            img.style.height = `${Math.max(1, session.natural.height * fit * next)}px`;
        } else {
            content.style.fontSize = `${next * 100}%`;
        }

        stage.scrollLeft = ratioX * stage.scrollWidth - fx;
        stage.scrollTop = ratioY * stage.scrollHeight - fy;
        this.zoomLevel.textContent = `${Math.round(next * 100)}%`;
    }

    setUpGestures() {
        const stage = this.stage;

        // Two-finger pinch (touch-action in CSS keeps one-finger scrolling native)
        stage.addEventListener('pointerdown', (e) => {
            const session = this.session;
            if (!session || !session.zoomKind || e.pointerType !== 'touch') return;
            session.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (session.pointers.size === 2) {
                const [a, b] = [...session.pointers.values()];
                session.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: session.zoom };
            }
        });
        stage.addEventListener('pointermove', (e) => {
            const session = this.session;
            if (!session || !session.pointers.has(e.pointerId)) return;
            session.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (session.pinch && session.pointers.size === 2) {
                const [a, b] = [...session.pointers.values()];
                const rect = stage.getBoundingClientRect();
                const distance = Math.hypot(a.x - b.x, a.y - b.y);
                this.setZoom(session.pinch.zoom * distance / session.pinch.distance,
                    (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top);
            }
        });
        const endPointer = (e) => {
            const session = this.session;
            if (!session) return;
            session.pointers.delete(e.pointerId);
            if (session.pointers.size < 2) session.pinch = null;
        };
        stage.addEventListener('pointerup', endPointer);
        stage.addEventListener('pointercancel', endPointer);

        // Safari's own pinch gestures would zoom the whole page instead
        ['gesturestart', 'gesturechange'].forEach(type => {
            stage.addEventListener(type, (e) => { if (this.session?.zoomKind) e.preventDefault(); });
        });

        // Ctrl/Cmd + scroll, and trackpad pinch (which browsers report as Ctrl + scroll)
        stage.addEventListener('wheel', (e) => {
            if (!this.session?.zoomKind || !(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            const rect = stage.getBoundingClientRect();
            // A mouse wheel notch is about 100, a trackpad pinch step a few units; cap a notch at ~1.6x
            const delta = Math.max(-50, Math.min(50, e.deltaY));
            this.zoomBy(Math.exp(-delta * 0.01), e.clientX - rect.left, e.clientY - rect.top);
        }, { passive: false });

        // Double-click / double-tap toggles between fit and 2x at that spot
        stage.addEventListener('dblclick', (e) => {
            if (this.session?.zoomKind !== 'image') return;
            const rect = stage.getBoundingClientRect();
            this.setZoom(this.session.zoom > 1.01 ? 1 : 2, e.clientX - rect.left, e.clientY - rect.top);
        });

        // Keep a fitted picture fitted when the screen rotates or the window resizes
        window.addEventListener('resize', () => {
            if (this.session?.zoomKind === 'image') this.setZoom(this.session.zoom);
        });
    }

    formatSize(bytes) {
        if (!bytes) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
        return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
    }
}

// Export for use in other modules or attach to window
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FilePreview;
} else {
    window.FilePreview = FilePreview;
    window.PreviewUnavailableError = PreviewUnavailableError;
    window.filePreview = new FilePreview();
}
