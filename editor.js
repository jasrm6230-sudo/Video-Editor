// ========== Video Editor - Fully Fixed Version ==========
class VideoEditor {
    constructor() {
        // انتظار العناصر الأساسية
        this.canvas = document.getElementById('timelineCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.wrap = document.getElementById('timelineWrap');
        this.previewVideo = document.getElementById('previewVideo');

        // حالة المحرر
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
        this.currentTool = 'select';
        this.dragging = null;
        this.undoStack = [];
        this.redoStack = [];
        this.clipIdCounter = 1;
        this.loadedVideos = {};
        this.textOverlay = { text: '', position: 'bottom', color: '#ffffff', size: 36 };
        this.ffmpeg = null;
        this.ffmpegReady = false;

        // بدء التهيئة
        this.init();
    }

    init() {
        // التأكد من أن العناصر موجودة (تحسباً لبطء التحميل)
        if (!this.canvas || !this.previewVideo) {
            console.error('عناصر HTML الأساسية غير موجودة');
            return;
        }

        // أحداث الماوس للخط الزمني
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas.addEventListener('mouseup', () => this.onMouseUp());
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (e.ctrlKey) e.deltaY < 0 ? this.zoomIn() : this.zoomOut();
            else this.wrap.scrollLeft += e.deltaY;
        });

        // أحداث اللمس للأجهزة اللوحية
        this.canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            const mouseEvent = new MouseEvent('mousedown', {
                clientX: touch.clientX,
                clientY: touch.clientY,
                button: 0
            });
            this.canvas.dispatchEvent(mouseEvent);
        });
        this.canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            const mouseEvent = new MouseEvent('mousemove', {
                clientX: touch.clientX,
                clientY: touch.clientY
            });
            this.canvas.dispatchEvent(mouseEvent);
        });
        this.canvas.addEventListener('touchend', (e) => {
            e.preventDefault();
            this.onMouseUp();
        });

        // لوحة المفاتيح
        document.addEventListener('keydown', (e) => this.onKeyDown(e));

        // تحديث وقت الفيديو
        this.previewVideo.addEventListener('timeupdate', () => this.onTimeUpdate());

        // تغيير حجم النافذة
        window.addEventListener('resize', () => this.resizeCanvas());

        // السحب والإفلات على نافذة المعاينة
        const previewContainer = document.getElementById('previewContainer');
        if (previewContainer) {
            previewContainer.addEventListener('dragover', (e) => e.preventDefault());
            previewContainer.addEventListener('drop', (e) => this.handleDrop(e));
        }

        // تهيئة الرسم
        this.resizeCanvas();
        this.renderTimeline();
        this.updateUI();

        // تحميل FFmpeg اختياري (لن يمنع المحرر من العمل)
        this.initFFmpeg();
    }

    async initFFmpeg() {
        try {
            if (typeof FFmpeg === 'undefined') {
                console.warn('FFmpeg غير متوفر، التصدير معطل');
                return;
            }
            const { createFFmpeg } = FFmpeg;
            this.ffmpeg = createFFmpeg({ log: false });
            await this.ffmpeg.load();
            this.ffmpegReady = true;
            console.log('FFmpeg جاهز');
        } catch (e) {
            console.warn('فشل تحميل FFmpeg:', e.message);
        }
    }

    // ========== تحميل الملفات ==========
    loadFiles() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'video/*';
        input.multiple = true;
        input.style.display = 'none';
        document.body.appendChild(input);

        // معالجة اختيار الملفات
        input.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files || []);
            for (const file of files) {
                await this.addFile(file);
            }
            document.body.removeChild(input);
        });

        // مستمع للإلغاء
        input.addEventListener('cancel', () => {
            document.body.removeChild(input);
        });

        // النقر على input
        input.click();
    }

    async addFile(file) {
        if (!file || !file.type.startsWith('video/')) return;

        // إنشاء blob URL
        const url = URL.createObjectURL(file);
        
        // إنشاء عنصر فيديو مؤقت لاستخراج البيانات
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.muted = true;

        return new Promise((resolve) => {
            video.onloadedmetadata = () => {
                this.loadedVideos[url] = {
                    duration: video.duration || 0,
                    width: video.videoWidth || 640,
                    height: video.videoHeight || 360,
                    file: file,
                    name: file.name
                };

                // إضافة مقطع إلى المسار الأول
                const track = this.tracks[0];
                const start = this.findFreeSlot(track, video.duration);
                const clip = this.createClip(url, start, start + video.duration, track.id, file.name);
                track.clips.push(clip);
                this.totalDuration = Math.max(this.totalDuration, start + video.duration + 5);

                this.saveUndoState();
                this.renderTimeline();
                this.updateUI();
                document.getElementById('dropHint').style.display = 'none';
                
                URL.revokeObjectURL(video.src); // تنظيف
                resolve();
            };

            video.onerror = () => {
                console.error('فشل تحميل الفيديو:', file.name);
                URL.revokeObjectURL(url);
                resolve(); // تجنب التعليق
            };

            video.src = url;

            // في حال كانت البيانات جاهزة بالفعل
            if (video.readyState >= 2) {
                video.onloadedmetadata();
            }
        });
    }

    findFreeSlot(track, duration) {
        if (track.clips.length === 0) return 0;
        const sorted = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart);
        if (sorted[0].timelineStart >= duration + 0.5) return 0;
        for (let i = 0; i < sorted.length - 1; i++) {
            if (sorted[i + 1].timelineStart - sorted[i].timelineEnd >= duration + 0.5)
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
        const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('video/'));
        if (files.length > 0) {
            files.forEach(f => this.addFile(f));
        }
    }

    // ========== عمليات المقاطع ==========
    getClipById(id) {
        for (const t of this.tracks) {
            const c = t.clips.find(c => c.id === id);
            if (c) return { clip: c, track: t };
        }
        return null;
    }

    get selectedClip() {
        return this.selectedClipId ? this.getClipById(this.selectedClipId) : null;
    }

    selectClip(id) {
        this.selectedClipId = id;
        this.updateTools();
        this.renderTimeline();
    }

    splitClip() {
        const res = this.selectedClip;
        if (!res) return;
        const { clip, track } = res;
        if (this.playheadTime <= clip.timelineStart + 0.05 || this.playheadTime >= clip.timelineEnd - 0.05) return;
        this.saveUndoState();
        const splitPoint = this.playheadTime;
        const sourceSplit = clip.sourceStart + (splitPoint - clip.timelineStart) * clip.speed;
        const right = { ...clip, id: this.clipIdCounter++, sourceStart: sourceSplit, timelineStart: splitPoint, name: clip.name + ' (مقسم)' };
        clip.sourceEnd = sourceSplit;
        clip.timelineEnd = splitPoint;
        track.clips.push(right);
        this.selectClip(right.id);
        this.renderTimeline();
        this.updateUI();
    }

    deleteClip() {
        const res = this.selectedClip;
        if (!res) return;
        this.saveUndoState();
        res.track.clips = res.track.clips.filter(c => c.id !== res.clip.id);
        this.selectedClipId = null;
        this.renderTimeline();
        this.updateUI();
    }

    duplicateClip() {
        const res = this.selectedClip;
        if (!res) return;
        this.saveUndoState();
        const { clip, track } = res;
        const dur = clip.timelineEnd - clip.timelineStart;
        const newClip = { ...clip, id: this.clipIdCounter++, timelineStart: clip.timelineEnd + 0.2, timelineEnd: clip.timelineEnd + 0.2 + dur, name: clip.name + ' (نسخة)' };
        track.clips.push(newClip);
        this.selectClip(newClip.id);
        this.totalDuration = Math.max(this.totalDuration, newClip.timelineEnd + 5);
        this.renderTimeline();
        this.updateUI();
    }

    setClipProp(prop, val) {
        const res = this.selectedClip;
        if (!res) return;
        res.clip[prop] = val;
        if (prop === 'speed') {
            const dur = (res.clip.sourceEnd - res.clip.sourceStart) / val;
            res.clip.timelineEnd = res.clip.timelineStart + dur;
        }
        const label = document.getElementById(prop + 'Label');
        if (label) label.textContent = (prop === 'speed' ? val.toFixed(2) + 'x' : val + '%');
        if (this.isPlaying) this.updatePreview();
        this.renderTimeline();
    }

    applyPreset(type) {
        const res = this.selectedClip;
        if (!res) return;
        this.saveUndoState();
        const f = res.clip.filters;
        Object.assign(f, { brightness: 100, contrast: 100, saturate: 100, blur: 0, hue: 0, sepia: 0 });
        switch (type) {
            case 'warm': f.brightness = 110; f.saturate = 130; f.hue = 15; f.sepia = 20; break;
            case 'cool': f.saturate = 110; f.hue = -15; break;
            case 'bw': f.saturate = 0; f.contrast = 120; break;
            case 'vintage': f.saturate = 60; f.contrast = 90; f.brightness = 105; f.sepia = 60; break;
            case 'sharp': f.contrast = 130; f.brightness = 105; break;
        }
        this.updateTools();
        if (this.isPlaying) this.updatePreview();
        this.renderTimeline();
    }

    setFilter(prop, val) {
        const res = this.selectedClip;
        if (res) {
            res.clip.filters[prop] = parseInt(val);
            if (this.isPlaying) this.updatePreview();
        }
    }

    setTextProp(prop, val) {
        this.textOverlay[prop] = val;
        const el = document.getElementById('textOverlayEl');
        if (!el) return;
        if (this.textOverlay.text.trim()) {
            el.style.display = 'block';
            el.textContent = this.textOverlay.text;
            el.style.color = this.textOverlay.color;
            el.style.fontSize = this.textOverlay.size + 'px';
            const pos = this.textOverlay.position;
            el.style.top = pos === 'top' ? '10%' : (pos === 'center' ? '50%' : 'auto');
            el.style.bottom = pos === 'bottom' ? '10%' : 'auto';
            el.style.transform = pos === 'center' ? 'translate(-50%,-50%)' : 'translateX(-50%)';
        } else {
            el.style.display = 'none';
        }
    }

    // ========== الأدوات ==========
    setTool(t) {
        this.currentTool = t;
        document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active-tool', b.dataset.tool === t));
        this.canvas.style.cursor = t === 'razor' ? 'crosshair' : 'default';
    }

    zoomIn() {
        this.zoom = Math.min(8, this.zoom * 1.3);
        this.resizeCanvas();
        this.renderTimeline();
        document.getElementById('zoomLevel').textContent = this.zoom.toFixed(1) + 'x';
    }

    zoomOut() {
        this.zoom = Math.max(0.15, this.zoom / 1.3);
        this.resizeCanvas();
        this.renderTimeline();
        document.getElementById('zoomLevel').textContent = this.zoom.toFixed(1) + 'x';
    }

    // ========== التشغيل (تم إصلاحها) ==========
    togglePlay() {
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play();
        }
    }

    play() {
        if (this.isPlaying || this.allClips.length === 0) return;
        const clipInfo = this.findClipAtTime(this.playheadTime);
        if (!clipInfo) {
            // حاول البحث عن أقرب مقطع تالٍ
            const next = this.findNextClip(this.playheadTime);
            if (next) {
                this.playheadTime = next.clip.timelineStart;
                this.play();
                return;
            }
            return; // لا مقاطع
        }
        this.isPlaying = true;
        this.playbackStart = performance.now() / 1000;
        this.playbackStartHead = this.playheadTime;
        this.setupPreviewForPlay(clipInfo.clip, this.playheadTime);
        this.animate();
    }

    pause() {
        this.isPlaying = false;
        if (this._raf) cancelAnimationFrame(this._raf);
        this.previewVideo.pause();
        this.renderTimeline();
    }

    animate() {
        if (!this.isPlaying) return;
        const now = performance.now() / 1000;
        this.playheadTime = this.playbackStartHead + (now - this.playbackStart);
        const maxEnd = Math.max(...this.allClips.map(c => c.timelineEnd), 0);
        if (this.playheadTime >= maxEnd) {
            this.playheadTime = maxEnd;
            this.pause();
            this.renderTimeline();
            this.updateUI();
            return;
        }
        const cur = this.findClipAtTime(this.playheadTime);
        if (cur) {
            const expectedSrcTime = cur.clip.sourceStart + (this.playheadTime - cur.clip.timelineStart) * cur.clip.speed;
            // التحقق مما إذا كان الفيديو الحالي متوافقًا أم لا
            if (this.previewVideo.src !== cur.clip.sourceUrl || Math.abs(this.previewVideo.currentTime - expectedSrcTime) > 0.3) {
                this.setupPreviewForPlay(cur.clip, this.playheadTime);
            }
            // استمرار التشغيل (قد يكون الفيديو قيد التشغيل بالفعل)
            if (this.previewVideo.paused) {
                this.previewVideo.play().catch(() => {});
            }
        } else {
            const next = this.findNextClip(this.playheadTime);
            if (next) {
                this.playheadTime = next.clip.timelineStart;
                this.setupPreviewForPlay(next.clip, this.playheadTime);
            } else {
                this.pause();
            }
        }
        this.renderTimeline();
        this.updateUI();
        this._raf = requestAnimationFrame(() => this.animate());
    }

    // إعداد المعاينة للتشغيل مع انتظار التحميل
    setupPreviewForPlay(clip, time) {
        const srcTime = clip.sourceStart + (time - clip.timelineStart) * clip.speed;
        const needsNewSource = (this.previewVideo.src !== clip.sourceUrl);
        
        const applySettings = () => {
            this.previewVideo.currentTime = srcTime;
            this.previewVideo.playbackRate = clip.speed;
            this.previewVideo.volume = clip.volume / 100;
            const f = clip.filters;
            this.previewVideo.style.filter = `brightness(${f.brightness/100}) contrast(${f.contrast/100}) saturate(${f.saturate/100}) blur(${f.blur}px) hue-rotate(${f.hue}deg) sepia(${f.sepia/100})`;
            this.previewVideo.play().catch(() => {});
        };

        if (needsNewSource) {
            this.previewVideo.src = clip.sourceUrl;
            // انتظر حتى يصبح الفيديو جاهزًا
            const onCanPlay = () => {
                this.previewVideo.removeEventListener('canplay', onCanPlay);
                applySettings();
            };
            this.previewVideo.addEventListener('canplay', onCanPlay);
            // في بعض الحالات قد يتم التحميل بسرعة ولا يستدعى canplay، لذا جرب بعد تأخير صغير
            setTimeout(() => {
                if (this.previewVideo.readyState >= 3) {
                    this.previewVideo.removeEventListener('canplay', onCanPlay);
                    applySettings();
                }
            }, 200);
        } else {
            // المصدر نفسه
            if (this.previewVideo.readyState >= 2) {
                applySettings();
            } else {
                this.previewVideo.addEventListener('canplay', () => applySettings(), { once: true });
            }
        }
    }

    updatePreview() {
        const c = this.findClipAtTime(this.playheadTime);
        if (c) this.setupPreviewForPlay(c.clip, this.playheadTime);
    }

    findClipAtTime(time) {
        for (const t of this.tracks) {
            for (const c of t.clips) {
                if (time >= c.timelineStart && time < c.timelineEnd) return { clip: c, track: t };
            }
        }
        return null;
    }

    findNextClip(time) {
        let best = null;
        for (const t of this.tracks) {
            for (const c of t.clips) {
                if (c.timelineStart > time && (!best || c.timelineStart < best.clip.timelineStart)) {
                    best = { clip: c, track: t };
                }
            }
        }
        return best;
    }

    get allClips() {
        return this.tracks.flatMap(t => t.clips);
    }

    onTimeUpdate() {
        // مزامنة إضافية إذا أردنا
    }

    // ========== الرسم (لم تتغير) ==========
    timeToPixel(t) { return t * this.baseZoom * this.zoom + 90; }
    pixelToTime(x) { return Math.max(0, (x - 90) / (this.baseZoom * this.zoom)); }

    resizeCanvas() {
        if (!this.wrap || !this.canvas) return;
        const w = Math.max(this.wrap.clientWidth, 600);
        const h = this.tracks.length * 55 + 35;
        this.canvas.width = w;
        this.canvas.height = h;
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';
        this.renderTimeline();
    }

    renderTimeline() {
        if (!this.ctx) return;
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        ctx.clearRect(0, 0, w, h);

        // خلفية
        ctx.fillStyle = '#1a1a20';
        ctx.fillRect(0, 0, w, h);

        // مسطرة
        ctx.fillStyle = '#2a2a32';
        ctx.fillRect(0, 0, w, 30);
        ctx.fillStyle = '#888';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        const step = this.zoom < 0.8 ? 5 : 1;
        for (let t = 0; t <= this.totalDuration; t += step) {
            const x = this.timeToPixel(t);
            if (x > 90 && x < w) {
                ctx.fillText(this.formatTime(t), x, 20);
            }
        }

        // مسارات
        for (let i = 0; i < this.tracks.length; i++) {
            const y = 30 + i * 55;
            ctx.fillStyle = i % 2 === 0 ? '#222228' : '#252530';
            ctx.fillRect(0, y, w, 55);

            // ملصق المسار
            ctx.fillStyle = '#3a3a45';
            ctx.fillRect(0, y, 88, 55);
            ctx.fillStyle = '#aaa';
            ctx.font = '11px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(this.tracks[i].name, 82, y + 32);

            // المقاطع
            for (const clip of this.tracks[i].clips) {
                const x1 = this.timeToPixel(clip.timelineStart);
                const x2 = this.timeToPixel(clip.timelineEnd);
                const clipW = Math.max(x2 - x1, 4);
                ctx.fillStyle = clip.id === this.selectedClipId ? '#fff' : this.tracks[i].color;
                ctx.fillRect(x1, y + 4, clipW, 47);
                if (clipW > 30) {
                    ctx.fillStyle = '#fff';
                    ctx.font = '10px sans-serif';
                    ctx.textAlign = 'left';
                    ctx.fillText(clip.name.substring(0, 15), x1 + 4, y + 18);
                }
                if (clip.speed !== 1) {
                    ctx.fillStyle = '#000';
                    ctx.fillText(clip.speed + 'x', x1 + 4, y + 40);
                }
            }
        }

        // مؤشر التشغيل
        const px = this.timeToPixel(this.playheadTime);
        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, 30);
        ctx.lineTo(px, h);
        ctx.stroke();

        this.updateTimeDisplay();
    }

    updateTimeDisplay() {
        document.getElementById('timeDisplay').textContent =
            this.formatTime(this.playheadTime) + ' / ' + this.formatTime(this.totalDuration);
        document.getElementById('clipCount').textContent = this.allClips.length + ' مقاطع';
        document.getElementById('totalDuration').textContent = this.formatTime(this.totalDuration);
    }

    formatTime(s) {
        const secs = Math.max(0, s);
        const m = Math.floor(secs / 60);
        const sec = Math.floor(secs % 60);
        return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    }

    // ========== أحداث الماوس واللمس ==========
    getMousePos(e) {
        if (!this.canvas) return { x: 0, y: 0 };
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: e.clientX - rect.left + this.wrap.scrollLeft,
            y: e.clientY - rect.top
        };
    }

    onMouseDown(e) {
        if (e.button !== 0) return;
        const pos = this.getMousePos(e);

        // سحب مؤشر التشغيل
        const phX = this.timeToPixel(this.playheadTime);
        if (Math.abs(pos.x - phX) < 10 && pos.y > 30) {
            this.dragging = { type: 'playhead' };
            this.pause();
            return;
        }

        // أداة القص
        if (this.currentTool === 'razor') {
            const t = this.pixelToTime(pos.x);
            this.playheadTime = t;
            this.splitClip();
            return;
        }

        // تحديد مقطع
        const hit = this.hitTest(pos);
        if (hit) {
            this.selectClip(hit.clip.id);
            this.dragging = {
                type: 'move',
                clipId: hit.clip.id,
                trackId: hit.track.id,
                startX: pos.x,
                origStart: hit.clip.timelineStart,
                origTrack: hit.track.id
            };
            this.saveUndoState();
            return;
        }

        // تحريك المؤشر
        this.pause();
        this.playheadTime = Math.max(0, this.pixelToTime(pos.x));
        this.selectedClipId = null;
        this.updateTools();
        this.renderTimeline();
    }

    onMouseMove(e) {
        if (!this.dragging) return;
        const pos = this.getMousePos(e);

        if (this.dragging.type === 'playhead') {
            this.playheadTime = Math.max(0, this.pixelToTime(pos.x));
            this.updatePreview();
            this.renderTimeline();
            this.updateUI();
            return;
        }

        if (this.dragging.type === 'move') {
            const res = this.getClipById(this.dragging.clipId);
            if (!res) return;
            const dx = pos.x - this.dragging.startX;
            const dt = dx / (this.baseZoom * this.zoom);
            const dur = res.clip.timelineEnd - res.clip.timelineStart;
            res.clip.timelineStart = Math.max(0, this.dragging.origStart + dt);
            res.clip.timelineEnd = res.clip.timelineStart + dur;

            // تغيير المسار
            const newTrackId = Math.floor((pos.y - 30) / 55);
            if (newTrackId >= 0 && newTrackId < this.tracks.length && newTrackId !== res.track.id) {
                const oldTrack = this.tracks.find(t => t.id === this.dragging.origTrack);
                const newTrack = this.tracks[newTrackId];
                if (oldTrack && newTrack) {
                    oldTrack.clips = oldTrack.clips.filter(c => c.id !== res.clip.id);
                    res.clip.trackId = newTrack.id;
                    newTrack.clips.push(res.clip);
                    this.dragging.trackId = newTrack.id;
                    this.dragging.origTrack = newTrack.id;
                }
            }
            this.renderTimeline();
        }
    }

    onMouseUp() {
        if (this.dragging) {
            this.dragging = null;
            this.renderTimeline();
            this.updateUI();
            this.updatePreview();
        }
    }

    hitTest(pos) {
        for (let i = 0; i < this.tracks.length; i++) {
            if (pos.y >= 30 + i * 55 && pos.y < 30 + (i + 1) * 55) {
                for (const clip of this.tracks[i].clips) {
                    const x1 = this.timeToPixel(clip.timelineStart);
                    const x2 = this.timeToPixel(clip.timelineEnd);
                    if (pos.x >= x1 && pos.x <= x2) {
                        return { clip, track: this.tracks[i] };
                    }
                }
            }
        }
        return null;
    }

    // ========== التراجع والإعادة ==========
    saveUndoState() {
        this.undoStack.push(this.serialize());
        if (this.undoStack.length > 50) this.undoStack.shift();
        this.redoStack = [];
    }

    undo() {
        if (!this.undoStack.length) return;
        this.redoStack.push(this.serialize());
        this.deserialize(this.undoStack.pop());
        this.pause();
        this.renderTimeline();
        this.updateUI();
        this.updateTools();
    }

    redo() {
        if (!this.redoStack.length) return;
        this.undoStack.push(this.serialize());
        this.deserialize(this.redoStack.pop());
        this.pause();
        this.renderTimeline();
        this.updateUI();
        this.updateTools();
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
        const els = {
            speedSlider: document.getElementById('speedSlider'),
            speedLabel: document.getElementById('speedLabel'),
            volumeSlider: document.getElementById('volumeSlider'),
            volumeLabel: document.getElementById('volumeLabel'),
            brightness: document.getElementById('brightness'),
            contrast: document.getElementById('contrast'),
            saturate: document.getElementById('saturate')
        };
        if (els.speedSlider) els.speedSlider.value = c ? c.speed : 1;
        if (els.speedLabel) els.speedLabel.textContent = (c ? c.speed : 1).toFixed(2) + 'x';
        if (els.volumeSlider) els.volumeSlider.value = c ? c.volume : 100;
        if (els.volumeLabel) els.volumeLabel.textContent = (c ? c.volume : 100) + '%';
        if (els.brightness) els.brightness.value = c ? c.filters.brightness : 100;
        if (els.contrast) els.contrast.value = c ? c.filters.contrast : 100;
        if (els.saturate) els.saturate.value = c ? c.filters.saturate : 100;
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
        else if (e.key === 'ArrowLeft') { e.preventDefault(); this.playheadTime = Math.max(0, this.playheadTime - 1/30); this.updatePreview(); this.renderTimeline(); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); this.playheadTime = Math.min(this.totalDuration, this.playheadTime + 1/30); this.updatePreview(); this.renderTimeline(); }
    }

    // ========== تصدير FFmpeg (اختياري) ==========
    exportVideo() {
        const modal = document.getElementById('exportModal');
        if (modal) modal.classList.add('show');
    }

    closeExportModal() {
        const modal = document.getElementById('exportModal');
        if (modal) modal.classList.remove('show');
    }

    async startExport() {
        const btn = document.getElementById('exportBtn');
        const prog = document.getElementById('progressBar');
        const progText = document.getElementById('progressText');
        
        if (!this.ffmpeg || !this.ffmpegReady) {
            progText.textContent = 'FFmpeg غير جاهز. حاول مجدداً أو استخدم تسجيل الشاشة.';
            return;
        }

        btn.disabled = true;
        prog.style.display = 'block';
        prog.value = 0;
        progText.textContent = 'جاري تجهيز الملفات...';

        const allClips = this.allClips;
        if (allClips.length === 0) {
            progText.textContent = 'لا توجد مقاطع';
            btn.disabled = false;
            return;
        }

        try {
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

            const filterParts = [];
            for (let i = 0; i < allClips.length; i++) {
                const clip = allClips[i];
                const f = clip.filters;
                let vf = `[${i}:v]`;
                vf += `setpts=${1/clip.speed}*PTS,`;
                vf += `eq=brightness=${f.brightness/100}:contrast=${f.contrast/100}:saturation=${f.saturate/100}`;
                if (f.hue !== 0) vf += `,hue=h=${f.hue}`;
                if (f.sepia > 0) vf += `,colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131`;
                vf += `,fps=30,format=yuv420p[v${i}]`;
                filterParts.push(vf);
            }

            const concatInputs = allClips.map((_, i) => `[v${i}]`).join('');
            filterParts.push(`${concatInputs}concat=n=${allClips.length}:v=1:a=0[outv]`);

            if (this.textOverlay.text.trim()) {
                const txt = this.textOverlay.text.replace(/[\\$']/g, '\\$&');
                const pos = this.textOverlay.position;
                const y = pos === 'top' ? '20' : (pos === 'bottom' ? 'h-th-20' : '(h-text_h)/2');
                filterParts.push(`[outv]drawtext=text='${txt}':fontsize=${this.textOverlay.size}:fontcolor=${this.textOverlay.color}:x=(w-text_w)/2:y=${y}[outv]`);
            }

            const args = [
                ...fileNames.flatMap(f => ['-i', f]),
                '-filter_complex', filterParts.join(';'),
                '-map', '[outv]',
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-crf', '23',
                'output.mp4'
            ];

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
        } finally {
            btn.disabled = false;
            try {
                const ffmpeg = this.ffmpeg;
                for (let i = 0; i < allClips.length; i++) ffmpeg.FS('unlink', `input_${i}.mp4`);
                ffmpeg.FS('unlink', 'output.mp4');
            } catch (e) {}
        }
    }
}

// بدء التطبيق بعد تحميل الصفحة
window.addEventListener('DOMContentLoaded', () => {
    window.editor = new VideoEditor();
    
    // إغلاق النافذة المنبثقة
    const modal = document.getElementById('exportModal');
    if (modal) {
        modal.addEventListener('click', function(e) {
            if (e.target === modal) window.editor.closeExportModal();
        });
    }
});
