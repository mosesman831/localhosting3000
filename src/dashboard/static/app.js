(function () {
  const statusUrl = "/api/status";
  const snapsUrl = "/api/snapshots";
  let statusTimer = null;
  let snapsTimer = null;
  let pendingId = null;

  function shouldPoll(hidden) {
    return hidden !== true;
  }

  function schedulePoll(hidden, delayMs, fn) {
    if (!shouldPoll(hidden)) return null;
    return setTimeout(fn, delayMs);
  }

  function $(id) {
    return document.getElementById(id);
  }

  function fmtAge(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + "s ago";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  function fmtLocal(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return (
      d.getFullYear() +
      "-" +
      p(d.getMonth() + 1) +
      "-" +
      p(d.getDate()) +
      " " +
      p(d.getHours()) +
      ":" +
      p(d.getMinutes()) +
      ":" +
      p(d.getSeconds())
    );
  }

  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  function fmtDelta(d) {
    if (!d) return "-";
    return "+" + d.added + " ~" + d.changed + " -" + d.removed;
  }

  function truncatedId(id) {
    if (id.length <= 18) return id;
    return id.slice(0, 10) + "..." + id.slice(-4);
  }

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(res.status + " " + res.statusText);
    return res.json();
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(function () {
      return {};
    });
    if (!res.ok) throw new Error(data.message || data.error || res.statusText);
    return data;
  }

  function renderStatus(st) {
    const badge = $("detector-badge");
    badge.textContent = st.detector;
    badge.dataset.state = st.detector;
    const last = st.probe.last_status == null ? "fail" : st.probe.last_status;
    const overlay =
      st.probe.last_overlay === true ? "overlay" : st.probe.last_overlay === false ? "clean" : "unknown";
    const err = st.probe.last_error ? " " + st.probe.last_error : "";
    $("probe-line").textContent = "probe: " + last + " / " + overlay + err;
    const running = !!(st.lock && st.lock.pid);
    $("chk-watch").textContent = "Watch process: " + (running ? "running" : "not running");
    $("chk-probe").textContent = "Probe URL + last status: " + st.probe.url + " " + last;
    $("chk-overlay").textContent =
      "Overlay: " + (st.probe.last_overlay === true ? "yes" : st.probe.last_overlay === false ? "no" : "unknown");
    $("chk-detector").textContent = "Detector state: " + st.detector;

    const banners = $("banners");
    banners.replaceChildren();
    if (st.restore_journal_present) {
      const b = document.createElement("div");
      b.className = "banner";
      b.textContent =
        "A restore was interrupted. Restore the latest SAFETY snapshot or run restore again.";
      banners.appendChild(b);
    }
    const cap = 1500 * 1024 * 1024;
    if (st.store && st.store.bytes_on_disk > cap) {
      const b = document.createElement("div");
      b.className = "banner";
      b.textContent =
        "Store is over the size cap. Oldest unpinned snapshots will be pruned. Pin anything you need.";
      banners.appendChild(b);
    }
  }

  function renderSnaps(env) {
    const rows = env.snapshots || [];
    const empty = $("empty");
    const table = $("snap-table");
    const body = $("snap-body");
    $("loading").hidden = true;
    $("error").hidden = true;
    $("btn-retry").hidden = true;
    if (rows.length === 0) {
      empty.hidden = false;
      table.hidden = true;
      body.replaceChildren();
      return;
    }
    empty.hidden = true;
    table.hidden = false;
    body.replaceChildren();
    rows.forEach(function (s, i) {
      const tr = document.createElement("tr");
      tr.dataset.id = s.id;
      tr.dataset.trigger = s.trigger;
      tr.dataset.confidence = s.confidence;
      tr.dataset.fileCount = String(s.file_count);
      tr.dataset.totalSize = String(s.total_size);
      tr.dataset.createdAt = s.created_at;

      const pinTd = document.createElement("td");
      const pinBtn = document.createElement("button");
      pinBtn.type = "button";
      pinBtn.className = "btn";
      pinBtn.style.minHeight = "44px";
      pinBtn.textContent = s.pinned ? "PIN" : "PIN";
      pinBtn.setAttribute("aria-pressed", s.pinned ? "true" : "false");
      pinBtn.addEventListener("click", function () {
        void postJson("/api/pin", { id: s.id, pinned: !s.pinned }).then(loadSnaps);
      });
      pinTd.appendChild(pinBtn);

      const ageTd = document.createElement("td");
      ageTd.textContent = fmtAge(s.age_ms);

      const whenTd = document.createElement("td");
      whenTd.textContent = fmtLocal(s.created_at);

      const idTd = document.createElement("td");
      idTd.className = "id";
      const idSpan = document.createElement("span");
      idSpan.textContent = truncatedId(s.id);
      idSpan.title = s.id;
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "btn copy";
      copy.textContent = "copy";
      copy.addEventListener("click", function () {
        void navigator.clipboard.writeText(s.id);
      });
      idTd.appendChild(idSpan);
      idTd.appendChild(copy);
      const badges = document.createElement("div");
      badges.className = "row-badges";
      if (i === 0) {
        const latest = document.createElement("span");
        latest.className = "pill";
        latest.textContent = "LATEST";
        badges.appendChild(latest);
      }
      if (s.trigger === "pre_restore") {
        const safety = document.createElement("span");
        safety.className = "pill";
        safety.textContent = "SAFETY";
        badges.appendChild(safety);
      }
      if (badges.childNodes.length) idTd.appendChild(badges);

      const trigTd = document.createElement("td");
      trigTd.textContent = s.trigger === "pre_restore" ? "safety" : s.trigger;

      const confTd = document.createElement("td");
      confTd.textContent = s.confidence;

      const filesTd = document.createElement("td");
      filesTd.textContent = String(s.file_count);

      const sizeTd = document.createElement("td");
      sizeTd.textContent = fmtBytes(s.total_size);

      const deltaTd = document.createElement("td");
      deltaTd.textContent = fmtDelta(s.delta);

      const restTd = document.createElement("td");
      const restBtn = document.createElement("button");
      restBtn.type = "button";
      restBtn.className = "btn primary";
      restBtn.style.minHeight = "44px";
      restBtn.textContent = "Restore";
      restBtn.addEventListener("click", function () {
        void openConfirm(s);
      });
      restTd.appendChild(restBtn);

      tr.appendChild(pinTd);
      tr.appendChild(ageTd);
      tr.appendChild(whenTd);
      tr.appendChild(idTd);
      tr.appendChild(trigTd);
      tr.appendChild(confTd);
      tr.appendChild(filesTd);
      tr.appendChild(sizeTd);
      tr.appendChild(deltaTd);
      tr.appendChild(restTd);
      body.appendChild(tr);
    });
  }

  async function openConfirm(s) {
    pendingId = s.id;
    $("restore-progress").hidden = true;
    $("restore-result").hidden = true;
    $("btn-restore").disabled = false;
    $("btn-cancel").disabled = false;
    let extra = 0;
    let overwrite = 0;
    let create = 0;
    const age = fmtAge(s.age_ms);
    const lines = [
      "Id: " + s.id,
      "Taken: " + fmtLocal(s.created_at) + " (" + age + ")",
      "Trigger: " + s.trigger + "  Confidence: " + s.confidence,
      "This will overwrite " + overwrite + " files and create " + create + " files.",
      "Files on disk not in this snapshot: " + extra + " (they will be kept).",
      "A safety snapshot of the current tree is taken first. If this restore is a mistake, restore the new SAFETY row.",
      "Restart your dev server after restore. localhosting does not stop processes.",
    ];
    try {
      const plan = await getJson("/api/restore-plan/" + encodeURIComponent(s.id));
      overwrite = plan.overwrite;
      create = plan.create;
      extra = plan.extra;
      lines[3] = "This will overwrite " + overwrite + " files and create " + create + " files.";
      lines[4] = "Files on disk not in this snapshot: " + extra + " (they will be kept).";
    } catch {
      /* keep zeros */
    }
    $("confirm-body").textContent = lines.join("\n");
    const dlg = $("confirm");
    if (typeof dlg.showModal === "function") dlg.showModal();
    $("btn-cancel").focus();
  }

  async function doRestore() {
    if (!pendingId) return;
    $("btn-restore").disabled = true;
    $("btn-cancel").disabled = true;
    $("restore-progress").hidden = false;
    $("restore-progress").textContent = "Restoring…";
    try {
      const r = await postJson("/api/restore", { id: pendingId, confirm: true });
      $("restore-progress").hidden = true;
      const box = $("restore-result");
      box.hidden = false;
      box.textContent =
        "safety_id " +
        r.safety_id +
        "\nRestart your dev server. localhosting does not stop processes.";
      await loadSnaps();
    } catch (err) {
      $("restore-progress").hidden = true;
      const box = $("restore-result");
      box.hidden = false;
      box.textContent = "Error: " + (err && err.message ? err.message : String(err));
      $("btn-restore").disabled = false;
      $("btn-cancel").disabled = false;
    }
  }

  async function loadStatus() {
    try {
      const st = await getJson(statusUrl);
      renderStatus(st);
    } catch {
      /* keep last */
    }
  }

  async function loadSnaps() {
    $("loading").hidden = false;
    try {
      const env = await getJson(snapsUrl);
      renderSnaps(env);
    } catch (err) {
      $("loading").hidden = true;
      $("error").hidden = false;
      $("error").textContent = "Cannot read snapshots: " + (err && err.message ? err.message : String(err));
      $("btn-retry").hidden = false;
    }
  }

  function loopStatus() {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = schedulePoll(document.hidden, 2000, function () {
      void loadStatus().then(loopStatus);
    });
  }

  function loopSnaps() {
    if (snapsTimer) clearTimeout(snapsTimer);
    snapsTimer = schedulePoll(document.hidden, 5000, function () {
      void loadSnaps().then(loopSnaps);
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (statusTimer) clearTimeout(statusTimer);
      if (snapsTimer) clearTimeout(snapsTimer);
      statusTimer = null;
      snapsTimer = null;
    } else {
      void loadStatus();
      void loadSnaps();
      loopStatus();
      loopSnaps();
    }
  });

  $("btn-snapshot").addEventListener("click", function () {
    void postJson("/api/snapshot", {}).then(loadSnaps);
  });
  $("btn-retry").addEventListener("click", function () {
    void loadSnaps();
  });
  $("btn-restore").addEventListener("click", function () {
    void doRestore();
  });

  window.__lhPoll = { shouldPoll: shouldPoll, schedulePoll: schedulePoll };

  void loadStatus();
  void loadSnaps();
  loopStatus();
  loopSnaps();
})();
