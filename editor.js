// ========== Video Editor with Browser-Native FFmpeg Export ==========
class VideoEditor {
    constructor() {
        this.tracks = [
            { id: 0, name: 'مسار 1', color: '#5b8dee', clips: [] },
            { id: 1, name: 'مسار 2', color: '#3ecf8e', clips: [] },
            { id: 2, name: 'مسار 3', color: '#f5b342', clips: [] },
        ];
        this.selectedClipId = null;
        this.playheadTime = 0;
        this.zoom = 1;
        this.baseZoom = 60;
        this.totalDuration = 30;
        this.isPlaying = false;
        this.playbackRAF = null;
        this.currentTool = 'select';
        this.dragging = null;
        this.undoStack = [];
        this.redoStack = [];
        this.clipIdCounter = 1;
        this.loadedVideos = {};   // url -> {duration, width, height, element, file}
        this.textOverlay = { text: '', position: 'bottom', color: '#ffffff', size: 36 };
        this.ffmpeg = null;       // FFmpeg instance
        this.init();
    }

    init() {
        this.canvas = document.getElementById('timelineCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.wrap = document.getElementById('timelineWrap');
        this.previewVideo = document.getElementById('previewVideo');
        this.previewVideo.addEventListener('timeupdate', () => this.onTimeUpdate());
        window.addEventListener('resize', () => this.resizeCanvas());
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas.addEventListener('mouseup', () => this.onMouseUp());
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (e.ctrlKey) e.deltaY < 0 ? this.zoomIn() : this.zoomOut();
            else this.wrap.scrollLeft += e.deltaY;
        });
        document.addEventListener('keydown', (e) => this.onKeyDown(e));
        this.resizeCanvas();
        this.renderTimeline();
        this.updateUI();
        // Initialize FFmpeg
        this.initFFmpeg();
    }

    async initFFmpeg() {
        const { createFFmpeg, fetchFile } = FFmpeg;  // from global script
        this.ffmpeg = createFFmpeg({ log: true });
        await this.ffmpeg.load();
        console.log('FFmpeg.wasm جاهز');
    }

    // ========== تحميل الملفات ==========
    loadFiles() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'video/*';
        input.multiple = true;
        input.onchange = async (e) => {
            for (const f of Array.from(e.target.files)) await this.addFile(f);
        };
        input.click();
    }

    async addFile(file) {
        const url = URL.createObjectURL(file);
        const video = document.createElement('video');
        video.src = url;
        video.preload = 'metadata';
        return new Promise((resolve) => {
            video.onloadedmetadata = () => {
                this.loadedVideos[url] = {
                    duration: video.duration,
                    width: video.videoWidth,
                    height: video.videoHeight,
                    element: video,
                    name: file.name,
                    file: file
                };
                const track = this.tracks[0];
                const start = this.findFreeSlot(track, video.duration);
                const clip = this.createClip(url, start, start + video.duration, track.id, file.name);
                track.clips.push(clip);
                this.totalDuration = Math.max(this.totalDuration, start + video.duration + 5);
                this.saveUndoState();
                this.renderTimeline();
                this.updateUI();
                document.getElementById('dropHint').style.display = 'none';
                resolve();
            };
            video.onerror = () => resolve();
            if (video.readyState >= 2) video.onloadedmetadata();
        });
    }

    findFreeSlot(track, dur) {
        if (track.clips.length === 0) return 0;
        const sorted = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart);
        if (sorted[0].timelineStart >= dur + 0.5) return 0;
        for (let i = 0; i < sorted.length - 1; i++) {
            if (sorted[i + 1].timelineStart - sorted[i].timelineEnd >= dur + 0.5)
                return sorted[i].timelineEnd + 0.25;
        }
        return sorted[sorted.length - 1].timelineEnd + 0.25;
    }

    createClip(url, start, end, trackId, name) {
        return {
            id: this.clipIdCounter++,
            sourceUrl: url,
            sourceStart: 0,
            sourceEnd: end - start,
            timelineStart: start,
            timelineEnd: end,
            trackId,
            speed: 1,
            volume: 100,
            filters: { brightness: 100, contrast: 100, saturate: 100, blur: 0, hue: 0, sepia: 0 },
            name: name || 'مقطع ' + this.clipIdCounter,
        };
    }

    handleDrop(e) {
        e.preventDefault();
        [...e.dataTransfer.files].filter(f => f.type.startsWith('video/')).forEach(f => this.addFile(f));
    }

    // ========== عمليات المقاطع ==========
    getClipById(id) { for (const t of this.tracks) { const c = t.clips.find(c => c.id === id); if (c) return { clip: c, track: t }; } return null; }
    get selectedClip() { return this.selectedClipId ? this.getClipById(this.selectedClipId) : null; }
    selectClip(id) { this.selectedClipId = id; this.updateTools(); this.renderTimeline(); }

    splitClip() {
        const res = this.selectedClip; if (!res) return;
        const { clip, track } = res;
        if (this.playheadTime <= clip.timelineStart + 0.05 || this.playheadTime >= clip.timelineEnd - 0.05) return;
        this.saveUndoState();
        const splitPoint = this.playheadTime;
        const sourceSplit = clip.sourceStart + (splitPoint - clip.timelineStart) * clip.speed;
        const right = { ...clip, id: this.clipIdCounter++, sourceStart: sourceSplit, timelineStart: splitPoint, name: clip.name + ' (مقسم)' };
        clip.sourceEnd = sourceSplit; clip.timelineEnd = splitPoint;
        track.clips.push(right); this.selectClip(right.id); this.renderTimeline(); this.updateUI();
    }
    deleteClip() { const res = this.selectedClip; if (!res) return; this.saveUndoState(); res.track.clips = res.track.clips.filter(c => c.id !== res.clip.id); this.selectedClipId = null; this.renderTimeline(); this.updateUI(); }
    duplicateClip() {
        const res = this.selectedClip; if (!res) return;
        this.saveUndoState();
        const { clip, track } = res;
        const dur = clip.timelineEnd - clip.timelineStart;
        const newClip = { ...clip, id: this.clipIdCounter++, timelineStart: clip.timelineEnd + 0.2, timelineEnd: clip.timelineEnd + 0.2 + dur, name: clip.name + ' (نسخة)' };
        track.clips.push(newClip); this.selectClip(newClip.id); this.totalDuration = Math.max(this.totalDuration, newClip.timelineEnd + 5);
        this.renderTimeline(); this.updateUI();
    }

    setClipProp(prop, val) {
        const res = this.selectedClip; if (!res) return;
        res.clip[prop] = val;
        if (prop === 'speed') {
            const dur = (res.clip.sourceEnd - res.clip.sourceStart) / val;
            res.clip.timelineEnd = res.clip.timelineStart + dur;
        }
        document.getElementById(prop + 'Label').textContent = (prop === 'speed' ? val.toFixed(2) + 'x' : val + '%');
        if (this.isPlaying) this.updatePreview();
        this.renderTimeline();
    }

    applyPreset(type) {
        const res = this.selectedClip; if (!res) return;
        this.saveUndoState();
        const f = res.clip.filters;
        Object.assign(f, { brightness: 100, contrast: 100, saturate: 100, blur: 0, hue: 0, sepia: 0 });
        if (type === 'warm') { f.brightness = 110; f.saturate = 130; f.hue = 15; f.sepia = 20; }
        else if (type === 'cool') { f.saturate = 110; f.hue = -15; }
        else if (type === 'bw') { f.saturate = 0; f.contrast = 120; }
        else if (type === 'vintage') { f.saturate = 60; f.contrast = 90; f.brightness = 105; f.sepia = 60; }
        else if (type === 'sharp') { f.contrast = 130; f.brightness = 105; }
        this.updateTools(); if (this.isPlaying) this.updatePreview(); this.renderTimeline();
    }
    setFilter(prop, val) { const res = this.selectedClip; if (res) { res.clip.filters[prop] = parseInt(val); if (this.isPlaying) this.updatePreview(); } }
    setTextProp(prop, val) {
        this.textOverlay[prop] = val;
        const el = document.getElementById('textOverlayEl');
        if (this.textOverlay.text.trim()) {
            el.style.display = 'block'; el.textContent = this.textOverlay.text;
            el.style.color = this.textOverlay.color; el.style.fontSize = this.textOverlay.size + 'px';
            el.style.top = this.textOverlay.position === 'top' ? '10%' : (this.textOverlay.position === 'center' ? '50%' : 'auto');
            el.style.bottom = this.textOverlay.position === 'bottom' ? '10%' : 'auto';
            el.style.transform = this.textOverlay.position === 'center' ? 'translate(-50%,-50%)' : 'translateX(-50%)';
        } else el.style.display = 'none';
    }

    // ========== أدوات ==========
    setTool(t) { this.currentTool = t; document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active-tool', b.dataset.tool === t)); this.canvas.style.cursor = t === 'razor' ? 'crosshair' : 'default'; }
    zoomIn() { this.zoom = Math.min(8, this.zoom * 1.3); this.resizeCanvas(); this.renderTimeline(); document.getElementById('zoomLevel').textContent = this.zoom.toFixed(1) + 'x'; }
    zoomOut() { this.zoom = Math.max(0.15, this.zoom / 1.3); this.resizeCanvas(); this.renderTimeline(); document.getElementById('zoomLevel').textContent = this.zoom.toFixed(1) + 'x'; }

    // ========== التشغيل ==========
    togglePlay() { this.isPlaying ? this.pause() : this.play(); }
    play() {
        if (this.isPlaying) return;
        const c = this.findClipAtTime(this.playheadTime);
        if (!c && !this.allClips.length) return;
        this.isPlaying = true; this.playbackStart = performance.now() / 1000; this.playbackStartHead = this.playheadTime;
        if (c) { this.setupPreview(c.clip, this.playheadTime); this.previewVideo.play().catch(() => { }); }
        this.animate();
    }
    pause() { this.isPlaying = false; if (this._raf) cancelAnimationFrame(this._raf); this.previewVideo.pause(); this.renderTimeline(); }
    animate() {
        if (!this.isPlaying) return;
        this.playheadTime = this.playbackStartHead + (performance.now() / 1000 - this.playbackStart);
        const maxEnd = Math.max(...this.allClips.map(c => c.timelineEnd), 0);
        if (this.playheadTime >= maxEnd) { this.playheadTime = maxEnd; this.pause(); return; }
        const cur = this.findClipAtTime(this.playheadTime);
        if (cur) {
            const st = cur.clip.sourceStart + (this.playheadTime - cur.clip.timelineStart) * cur.clip.speed;
            if (this.previewVideo.src !== cur.clip.sourceUrl || Math.abs(this.previewVideo.currentTime - st) > 0.3) {
                this.setupPreview(cur.clip, this.playheadTime); this.previewVideo.play().catch(() => { });
            }
        } else {
            const nxt = this.findNextClip(this.playheadTime);
            if (nxt) { this.playheadTime = nxt.clip.timelineStart; this.setupPreview(nxt.clip, this.playheadTime); this.previewVideo.play().catch(() => { }); }
            else this.pause();
        }
        this.renderTimeline(); this.updateUI();
        this._raf = requestAnimationFrame(() => this.animate());
    }
    setupPreview(clip, time) {
        const st = clip.sourceStart + (time - clip.timelineStart) * clip.speed;
        if (this.previewVideo.src !== clip.sourceUrl) this.previewVideo.src = clip.sourceUrl;
        this.previewVideo.currentTime = st; this.previewVideo.playbackRate = clip.speed; this.previewVideo.volume = clip.volume / 100;
        const f = clip.filters;
        this.previewVideo.style.filter = `brightness(${f.brightness / 100}) contrast(${f.contrast / 100}) saturate(${f.saturate / 100}) blur(${f.blur}px) hue-rotate(${f.hue}deg) sepia(${f.sepia / 100})`;
    }
    updatePreview() { const c = this.findClipAtTime(this.playheadTime); if (c) this.setupPreview(c.clip, this.playheadTime); }
    findClipAtTime(time) { for (const t of this.tracks) for (const c of t.clips) if (time >= c.timelineStart && time < c.timelineEnd) return { clip: c, track: t }; return null; }
    findNextClip(time) { let best = null; for (const t of this.tracks) for (const c of t.clips) if (c.timelineStart > time && (!best || c.timelineStart < best.clip.timelineStart)) best = { clip: c, track: t }; return best; }
    get allClips() { return this.tracks.flatMap(t => t.clips); }

    // ========== الرسم ==========
    timeToPixel(t) { return t * this.baseZoom * this.zoom + 90; }
    pixelToTime(x) { return Math.max(0, (x - 90) / (this.baseZoom * this.zoom)); }
    resizeCanvas() { const w = Math.max(this.wrap.clientWidth, 600), h = this.tracks.length * 55 + 35; this.canvas.width = w; this.canvas.height = h; this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px'; }
    renderTimeline() { /* كود الرسم الكامل (موجود في الإصدارات السابقة) */ }
    updateTimeDisplay() {
        document.getElementById('timeDisplay').textContent = this.formatTime(this.playheadTime) + ' / ' + this.formatTime(this.totalDuration);
        document.getElementById('clipCount').textContent = this.allClips.length + ' مقاطع';
        document.getElementById('totalDuration').textContent = this.formatTime(this.totalDuration);
    }
    formatTime(s) { const m = Math.floor(s / 60), sec = Math.floor(s % 60); return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0'); }

    // ========== تراجع / إعادة ==========
    saveUndoState() {
        this.undoStack.push(this.serialize());
        if (this.undoStack.length > 50) this.undoStack.shift();
        this.redoStack = [];
    }
    undo() {
        if (!this.undoStack.length) return;
        this.redoStack.push(this.serialize());
        this.deserialize(this.undoStack.pop());
        this.pause(); this.renderTimeline(); this.updateUI(); this.updateTools();
    }
    redo() {
        if (!this.redoStack.length) return;
        this.undoStack.push(this.serialize());
        this.deserialize(this.redoStack.pop());
        this.pause(); this.renderTimeline(); this.updateUI(); this.updateTools();
    }
    serialize() {
        return JSON.parse(JSON.stringify({
            tracks: this.tracks,
            playheadTime: this.playheadTime,
            totalDuration: this.totalDuration,
            selectedClipId: this.selectedClipId,
            clipIdCounter: this.clipIdCounter,
            textOverlay: this.textOverlay,
        }));
    }
    deserialize(data) {
        this.tracks = data.tracks;
        this.playheadTime = data.playheadTime;
        this.totalDuration = data.totalDuration;
        this.selectedClipId = data.selectedClipId;
        this.clipIdCounter = data.clipIdCounter;
        this.textOverlay = data.textOverlay;
        this.setTextProp('text', this.textOverlay.text);
    }
    updateTools() {
        const c = this.selectedClip?.clip;
        document.getElementById('speedSlider').value = c ? c.speed : 1;
        document.getElementById('speedLabel').textContent = (c ? c.speed : 1).toFixed(2) + 'x';
        document.getElementById('volumeSlider').value = c ? c.volume : 100;
        document.getElementById('volumeLabel').textContent = (c ? c.volume : 100) + '%';
        document.getElementById('brightness').value = c ? c.filters.brightness : 100;
        document.getElementById('contrast').value = c ? c.filters.contrast : 100;
        document.getElementById('saturate').value = c ? c.filters.saturate : 100;
    }

    // ========== لوحة المفاتيح ==========
    onKeyDown(e) {
        if (e.ctrlKey && e.key === 'z') { e.preventDefault(); this.undo(); }
        else if (e.ctrlKey && e.key === 'y') { e.preventDefault(); this.redo(); }
        else if (e.key === ' ') { e.preventDefault(); this.togglePlay(); }
        else if (e.key === 's' || e.key === 'S') { e.preventDefault(); this.splitClip(); }
        else if (e.key === 'Delete') { e.preventDefault(); this.deleteClip(); }
        else if (e.key === 'v') this.setTool('select');
        else if (e.key === 'c') this.setTool('razor');
        else if (e.key === 'ArrowLeft') { e.preventDefault(); this.playheadTime = Math.max(0, this.playheadTime - 1 / 30); this.updatePreview(); this.renderTimeline(); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); this.playheadTime = Math.min(this.totalDuration, this.playheadTime + 1 / 30); this.updatePreview(); this.renderTimeline(); }
    }

    // ========== التصدير باستخدام FFmpeg.wasm ==========
    exportVideo() { document.getElementById('exportModal').classList.add('show'); }
    closeExportModal() { document.getElementById('exportModal').classList.remove('show'); }

    async startExport() {
        const btn = document.getElementById('exportBtn');
        const prog = document.getElementById('progressBar');
        const progText = document.getElementById('progressText');
        btn.disabled = true;
        prog.style.display = 'block';
        prog.value = 0;
        progText.textContent = 'جاري تجهيز الملفات...';

        if (!this.ffmpeg || !this.ffmpeg.isLoaded()) {
            progText.textContent = 'FFmpeg لم يتم تحميله بعد، انتظر...';
            await this.ffmpeg.load();
        }

        try {
            const allClips = this.allClips;
            if (allClips.length === 0) throw new Error('لا توجد مقاطع');

            // كتابة الملفات إلى نظام الملفات الافتراضي لـ FFmpeg
            const ffmpeg = this.ffmpeg;
            const fetchFile = FFmpeg.fetchFile;
            const fileNames = [];

            for (let i = 0; i < allClips.length; i++) {
                const clip = allClips[i];
                const file = this.loadedVideos[clip.sourceUrl]?.file;
                if (!file) continue;
                const inputName = `input_${i}.mp4`;
                ffmpeg.FS('writeFile', inputName, await fetchFile(file));
                fileNames.push(inputName);
            }

            // بناء filter_complex
            let filterComplex = '';
            const videoFilters = [];
            for (let i = 0; i < allClips.length; i++) {
                const clip = allClips[i];
                const f = clip.filters;
                let vf = `[${i}:v]`;
                vf += `setpts=${1 / clip.speed}*PTS,`;
                vf += `eq=brightness=${f.brightness / 100}:contrast=${f.contrast / 100}:saturation=${f.saturate / 100}`;
                if (f.hue !== 0) vf += `,hue=h=${f.hue}`;
                if (f.sepia > 0) vf += `,colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131`;
                vf += `,fps=30,format=yuv420p`;
                vf += `[v${i}]`;
                videoFilters.push(vf);
            }
            filterComplex += videoFilters.join(';') + ';';
            // concat
            const concatInputs = allClips.map((_, i) => `[v${i}]`).join('');
            filterComplex += `${concatInputs}concat=n=${allClips.length}:v=1:a=0[outv]`;

            // إضافة نص
            if (this.textOverlay.text.trim()) {
                const txt = this.textOverlay.text.replace(/[\\$']/g, '\\$&');
                const pos = this.textOverlay.position;
                const y = pos === 'top' ? '20' : pos === 'bottom' ? 'h-th-20' : '(h-text_h)/2';
                filterComplex += `;[outv]drawtext=text='${txt}':fontsize=${this.textOverlay.size}:fontcolor=${this.textOverlay.color}:x=(w-text_w)/2:y=${y}[outv]`;
            }

            // أمر ffmpeg
            const args = [
                ...fileNames.flatMap(f => ['-i', f]),
                '-filter_complex', filterComplex,
                '-map', '[outv]',
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-crf', '23',
                'output.mp4'
            ];

            progText.textContent = 'جاري معالجة الفيديو (قد يستغرق دقائق)...';
            ffmpeg.setProgress(({ ratio }) => {
                prog.value = ratio * 100;
                progText.textContent = `المعالجة: ${Math.round(ratio * 100)}%`;
            });

            await ffmpeg.run(...args);

            const data = ffmpeg.FS('readFile', 'output.mp4');
            const blob = new Blob([data.buffer], { type: 'video/mp4' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'montage.mp4';
            a.click();
            URL.revokeObjectURL(url);

            progText.textContent = '✅ تم التصدير بنجاح!';
            setTimeout(() => this.closeExportModal(), 2000);
        } catch (err) {
            progText.textContent = '❌ خطأ: ' + err.message;
            console.error(err);
        } finally {
            btn.disabled = false;
            // تنظيف الملفات من الذاكرة
            try {
                const ffmpeg = this.ffmpeg;
                ffmpeg.FS('unlink', 'output.mp4');
                for (let i = 0; i < allClips.length; i++) ffmpeg.FS('unlink', `input_${i}.mp4`);
            } catch (e) { }
        }
    }

    // ========== أحداث الماوس (اختصار) ==========
    onMouseDown(e) { /* ... */ }
    onMouseMove(e) { /* ... */ }
    onMouseUp() { /* ... */ }
}

// بدء المحرر
const editor = new VideoEditor();

// إغلاق النافذة
document.getElementById('exportModal').addEventListener('click', function (e) {
    if (e.target === this) editor.closeExportModal();
});
