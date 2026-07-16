// OccViewer — interactive 4D occupancy: Three.js voxels (one InstancedMesh per class),
// OrbitControls to move the scene, a time slider to scrub frames, and a legend.
// Adapted from LatentProOOD/vis/static/js/main.js (color-group -> InstancedMesh recipe).
(function () {
  const BOX = new THREE.BoxGeometry(1, 1, 1);

  class OccViewer {
    constructor(container, occUrl, opts = {}) {
      this.container = container;
      this.embedded = !!(opts && opts.embedded);  // embedded: no own play/scrub controls — driven via goto()
      this.opts = opts || {};
      this.staticMeshes = [];
      this.dynMeshes = [];
      this.frame = 0;
      this.playing = false;
      this._alive = true;
      this._pending = null;
      this._build();
      fetch(occUrl).then((r) => r.json()).then((d) => this._init(d)).catch((e) => {
        this.container.innerHTML = '<div class="occ-err">occupancy failed to load</div>';
        console.error(e);
      });
    }

    _build() {
      this.container.innerHTML = "";
      this.container.classList.add("occ-wrap");
      this.canvasHolder = document.createElement("div"); this.canvasHolder.className = "occ-canvas";
      this.hint = document.createElement("div"); this.hint.className = "occ-hint";
      this.hint.textContent = "drag: rotate · scroll: zoom · right-drag: pan";
      this.legend = document.createElement("div"); this.legend.className = "occ-legend";
      if (this.embedded) {
        this.container.append(this.canvasHolder, this.hint, this.legend);
      } else {
        const ctrls = document.createElement("div"); ctrls.className = "occ-ctrls";
        this.btn = document.createElement("button"); this.btn.className = "player-btn"; this.btn.textContent = "▶";
        this.slider = document.createElement("input"); this.slider.type = "range"; this.slider.min = 0; this.slider.value = 0;
        this.slider.className = "player-slider";
        this.count = document.createElement("span"); this.count.className = "player-count";
        ctrls.append(this.btn, this.slider, this.count);
        this.container.append(this.canvasHolder, this.hint, ctrls, this.legend);
        this.btn.onclick = () => (this.playing ? this._pause() : this._play());
        this.slider.oninput = () => { this._pause(); this._setFrame(+this.slider.value); };
      }
    }

    // external drive: jump to a frame (queues if occ.json not loaded yet)
    goto(i) { if (this.data) this._setFrame(i); else this._pending = i; }
    get nFrames() { return (this.data && this.data.frames && this.data.frames.length) || 0; }

    _init(d) {
      this.data = d;
      const [X, Y, Z] = d.spatial_size;
      this.center = [X / 2, Y / 2, Z / 2];

      const w = this.canvasHolder.clientWidth || 480;
      const h = this.canvasHolder.clientHeight || 340;
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0xeef1f5);
      this.camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 5000);
      const M = Math.max(X, Y);
      this.camera.position.set(M * 0.75, M * 0.62, M * 1.02);
      this.renderer = new THREE.WebGLRenderer({ antialias: true });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      this.renderer.setSize(w, h);
      this.canvasHolder.append(this.renderer.domElement);

      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
      this.controls.target.set(0, 0, 0); this.controls.update();

      this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
      const dl = new THREE.DirectionalLight(0xffffff, 0.7); dl.position.set(0.5, 1, 0.4); this.scene.add(dl);
      const dl2 = new THREE.DirectionalLight(0xffffff, 0.3); dl2.position.set(-0.6, 0.5, -0.5); this.scene.add(dl2);

      this._addVoxels(d.static, this.staticMeshes);
      // ego-centric occ has NO fixed static (the whole world moves per-frame) -> frame the camera to
      // frame 0 instead so the view is centred.
      this._fit((d.static && d.static.length) ? d.static : ((d.frames && d.frames[0]) || []));

      const nFrames = (d.frames && d.frames.length) || 1;
      if (this.slider) this.slider.max = Math.max(0, nFrames - 1);
      this._setFrame(this._pending != null ? Math.min(this._pending, nFrames - 1) : 0);
      this._pending = null;
      this._buildLegend();

      this._onResize = () => this._resize();
      window.addEventListener("resize", this._onResize);
      this._loop = this._loop.bind(this);
      this._last = performance.now();
      requestAnimationFrame(this._loop);
    }

    // grid (x=lateral, y=forward/BEV-up, z=height) -> Three.js y-up centered at origin.
    // Camera sits on +Z looking back, so +X projects screen-right and (cy-y) puts BEV-up at top.
    _gridToThree(gx, gy, gz) {
      const [cx, cy, cz] = this.center;
      return [gx - cx, gz - cz, cy - gy];
    }

    // flat [x,y,z,c, ...] -> one InstancedMesh per class c, positions centered at origin
    _addVoxels(flat, sink) {
      const byClass = new Map();
      for (let i = 0; i < flat.length; i += 4) {
        const c = flat[i + 3];
        if (!byClass.has(c)) byClass.set(c, []);
        byClass.get(c).push(flat[i], flat[i + 1], flat[i + 2]);
      }
      const mtx = new THREE.Matrix4();
      byClass.forEach((pos, c) => {
        const col = this.data.colors[c] || [180, 180, 180];
        const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(col[0] / 255, col[1] / 255, col[2] / 255) });
        const n = pos.length / 3;
        const mesh = new THREE.InstancedMesh(BOX, mat, n);
        for (let k = 0; k < n; k++) {
          const [tx, ty, tz] = this._gridToThree(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
          mtx.setPosition(tx, ty, tz);
          mesh.setMatrixAt(k, mtx);
        }
        mesh.instanceMatrix.needsUpdate = true;
        this.scene.add(mesh); sink.push(mesh);
      });
    }

    // frame the camera to the occupied voxels in centered three-space
    _fit(flat) {
      let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
      for (let i = 0; i < flat.length; i += 4) {
        const p = this._gridToThree(flat[i], flat[i + 1], flat[i + 2]);
        for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
      }
      if (lo[0] > hi[0]) return;
      const mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      const r = 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      const dist = (r / Math.sin((this.camera.fov * Math.PI / 180) / 2)) * 1.15;
      this.controls.target.set(mid[0], mid[1], mid[2]);
      if (this.opts && this.opts.topdown) {
        // from +Z (south of BEV-up): screen-right = +X, screen-up = BEV-forward
        this.camera.position.set(mid[0], mid[1] + dist * 0.82, mid[2] + dist * 0.57);
      } else {
        const dir = new THREE.Vector3(0.72, 0.6, 1.0).normalize();
        this.camera.position.set(mid[0] + dir.x * dist, mid[1] + dir.y * dist, mid[2] + dir.z * dist);
      }
      this.camera.updateProjectionMatrix();
      this.controls.update();
    }

    _setFrame(i) {
      this.frame = i;
      this.dynMeshes.forEach((m) => { this.scene.remove(m); m.geometry.dispose?.(); m.material.dispose?.(); });
      this.dynMeshes = [];
      const fr = (this.data.frames && this.data.frames[i]) || [];
      if (fr.length) this._addVoxels(fr, this.dynMeshes);
      if (this.slider) this.slider.value = i;
      if (this.count) this.count.textContent = `t ${i + 1} / ${(this.data.frames || [0]).length}`;
    }

    _buildLegend() {
      const used = new Set();
      const scan = (flat) => { for (let i = 3; i < flat.length; i += 4) used.add(flat[i]); };
      scan(this.data.static); (this.data.frames || []).forEach(scan);
      this.legend.innerHTML = "";
      [...used].sort((a, b) => a - b).forEach((c) => {
        const col = this.data.colors[c] || [180, 180, 180];
        const el = document.createElement("span"); el.className = "occ-leg-item";
        const sw = document.createElement("i"); sw.style.background = `rgb(${col[0]},${col[1]},${col[2]})`;
        el.append(sw, document.createTextNode(this.data.names[c] || `class ${c}`));
        this.legend.append(el);
      });
    }

    _play() { this.playing = true; this.btn.textContent = "❚❚"; this._facc = 0; }
    _pause() { this.playing = false; this.btn.textContent = "▶"; }

    _resize() {
      if (!this.renderer) return;
      const w = this.canvasHolder.clientWidth, h = this.canvasHolder.clientHeight;
      if (!w || !h) return;
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.renderer.setSize(w, h);
    }

    _loop(now) {
      if (!this._alive) return;
      const dt = (now - this._last) / 1000; this._last = now;
      if (this.playing) {
        this._facc = (this._facc || 0) + dt;
        if (this._facc > 0.4) { this._facc = 0; const n = (this.data.frames || [0]).length; this._setFrame((this.frame + 1) % n); }
      }
      this.controls && this.controls.update();
      this.renderer && this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(this._loop);
    }

    dispose() {
      this._alive = false;
      window.removeEventListener("resize", this._onResize);
      try {
        [...this.staticMeshes, ...this.dynMeshes].forEach((m) => { m.geometry.dispose?.(); m.material.dispose?.(); });
        this.renderer && this.renderer.dispose();
        if (this.renderer && this.renderer.domElement) this.renderer.domElement.remove();
      } catch (e) {}
    }
  }
  window.OccViewer = OccViewer;
})();
