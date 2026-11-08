/* =====================================================================
   claude-shim.js
   The Manahil app was built to run inside Claude, which gave it a
   database, sign-in, file storage and downloads through window.claude.
   This file provides the SAME five services, but backed by Supabase,
   so the 5,800 lines of the app do not have to change.

     window.claude.use("db")        -> records (Postgres table "documents")
     window.claude.use("user")      -> sign-in, names, people search
     window.claude.use("assets")    -> photos, PDFs, signatures (private bucket)
     window.claude.use("downloads") -> saves CSV / PDF files in the browser
     window.claude.use("sample")    -> not available (the "Claude reads this policy" button)

   IMPORTANT: nothing in this file decides what a person is allowed to do.
   That is decided by the database (schema.sql). Anyone can edit this file
   in their browser; the database will still refuse what their role cannot do.
   ===================================================================== */
(function () {
  "use strict";

  var CFG = window.MMS_CONFIG || {};
  var BUCKET = "files";
  var PREFIX = "u_";                       // the app expects user ids that start with u_
  var MAX_BYTES = 20 * 1024 * 1024;
  var OK_TYPES = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/;

  var sb = null;                           // the Supabase client
  var ME = null;                           // the signed-in person, in the shape the app expects
  var signedIn = false;
  var readyResolve;
  var ready = new Promise(function (res) { readyResolve = res; });

  /* ------------------------------ small helpers ------------------------------ */

  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  function plain(x) { return JSON.parse(JSON.stringify(x === undefined ? {} : x)); }
  function strip(id) { return String(id || "").replace(/^u_/, ""); }
  function isUuid(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  function newId() {                       // 20 random letters and digits, like a Firestore id
    var a = new Uint8Array(20), s = "", ch = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    crypto.getRandomValues(a);
    for (var i = 0; i < 20; i++) s += ch[a[i] % 62];
    return s;
  }
  function newUuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = crypto.getRandomValues(new Uint8Array(1))[0] & 15; return (c === "x" ? r : (r & 3) | 8).toString(16);
    });
  }

  function avatar(name) {                  // a round maroon badge with the person's initials
    var t = String(name || "?").trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0] || ""; }).join("").toUpperCase() || "?";
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='#7B1E2B'/>" +
      "<text x='32' y='41' font-family='sans-serif' font-size='26' font-weight='700' fill='#fff' text-anchor='middle'>" + esc(t) + "</text></svg>";
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  // Turns a Supabase error into the kind of error the app expects.
  function fail(error, what) {
    var msg = (error && error.message) || String(error);
    var e = new Error(msg);
    var c = error && error.code;
    e.code = c === "42501" ? "permission-denied" : c === "P0002" ? "not-found" : (error && error.code) || "unavailable";
    try { console.warn("[mms] " + what + " failed: " + msg + (e.code === "permission-denied" ? "  (your role is not allowed to do this)" : "")); } catch (_) {}
    return e;
  }

  /* ------------------------------ the local copy of the records ------------------------------
     The app listens to whole collections ("students", "payments", ...). We load each one once,
     keep it in memory, keep it fresh from the live channel, and hand it to every listener. */

  var COL = {};
  function col(name) {
    return COL[name] || (COL[name] = { map: new Map(), state: "idle", subs: new Set(), gen: 0, dirty: false, timer: null });
  }

  function docSnap(name, id) {
    var map = col(name).map, has = map.has(id), d = map.get(id);
    return { id: id, exists: has, data: function () { return has ? clone(d) : undefined; } };
  }
  function colSnap(name) {
    var docs = [];
    col(name).map.forEach(function (d, id) { docs.push({ id: id, exists: true, data: function () { return clone(d); } }); });
    return { docs: docs, size: docs.length, empty: !docs.length, forEach: function (f) { docs.forEach(f); } };
  }

  function schedule(name) {                // tell the listeners, but not more than once per burst of changes
    var c = col(name);
    if (c.timer) return;
    c.timer = setTimeout(function () {
      c.timer = null;
      c.subs.forEach(function (s) {
        try { s.cb(s.id === undefined ? colSnap(name) : docSnap(name, s.id)); } catch (e) { console.error(e); }
      });
    }, 25);
  }

  async function loadAll(name) {           // read the whole collection (1000 rows per request)
    var c = col(name), gen = ++c.gen;
    c.state = "loading"; c.dirty = false;
    try {
      var rows = [], from = 0, size = 1000;
      for (;;) {
        var r = await sb.from("documents").select("id,data").eq("collection", name).order("id").range(from, from + size - 1);
        if (r.error) throw r.error;
        rows = rows.concat(r.data || []);
        if (!r.data || r.data.length < size) break;
        from += size;
      }
      if (gen !== c.gen) return;           // a newer load has started; let that one finish
      c.map = new Map(rows.map(function (x) { return [x.id, x.data]; }));
      c.state = "ready";
      schedule(name);
      if (c.dirty) loadAll(name);          // something changed while we were reading
    } catch (e) {
      if (gen !== c.gen) return;
      c.state = "idle";
      c.subs.forEach(function (s) { if (s.err) { try { s.err(fail(e, "read " + name)); } catch (_) {} } });
    }
  }

  function applySet(name, id, data) {
    var c = col(name);
    if (c.state === "loading") { c.dirty = true; return; }
    if (c.state !== "ready") return;
    c.map.set(id, data); schedule(name);
  }
  function applyMerge(name, id, patch) {
    var c = col(name);
    if (c.state === "loading") { c.dirty = true; return; }
    if (c.state !== "ready" || !c.map.has(id)) return;
    c.map.set(id, Object.assign({}, c.map.get(id), patch)); schedule(name);
  }
  function applyDelete(name, id) {
    var c = col(name);
    if (c.state === "loading") { c.dirty = true; return; }
    if (c.state !== "ready") return;
    c.map["delete"](id); schedule(name);
  }

  function listen(name, id, cb, err) {
    var c = col(name), sub = { cb: cb, err: err, id: id };
    c.subs.add(sub);
    if (c.state === "ready") {
      setTimeout(function () { if (c.subs.has(sub)) cb(id === undefined ? colSnap(name) : docSnap(name, id)); }, 0);
    } else if (c.state === "idle") {
      loadAll(name);
    }
    return function () { c.subs.delete(sub); };
  }

  /* ------------------------------ live updates ------------------------------ */

  var wasSubscribed = false;
  function startRealtime() {
    sb.channel("mms-documents")
      .on("postgres_changes", { event: "*", schema: "public", table: "documents" }, function (p) {
        var row = p.eventType === "DELETE" ? p.old : p.new;
        if (!row || !row.collection) return;
        var name = row.collection;
        if (!COL[name]) return;
        if (p.eventType === "DELETE") applyDelete(name, row.id);
        else if (p.new && p.new.data) applySet(name, p.new.id, p.new.data);
        else loadAll(name);
      })
      .subscribe(function (status) {
        if (status === "SUBSCRIBED") {
          if (wasSubscribed) Object.keys(COL).forEach(function (n) { if (COL[n].state !== "idle") loadAll(n); });  // catch up after a dropped connection
          wasSubscribed = true;
        }
      });
  }

  /* ------------------------------ db: records ------------------------------ */

  function docRef(name, id) {
    return {
      id: id,
      path: name + "/" + id,
      get: async function () {
        var r = await sb.from("documents").select("data").eq("collection", name).eq("id", id).maybeSingle();
        if (r.error) throw fail(r.error, "read " + name + "/" + id);
        var has = !!r.data;
        return { id: id, exists: has, data: function () { return has ? clone(r.data.data) : undefined; } };
      },
      set: async function (data) {
        var d = plain(data);
        var r = await sb.rpc("doc_set", { p_coll: name, p_id: id, p_data: d });
        if (r.error) throw fail(r.error, "save " + name + "/" + id);
        applySet(name, id, d);
      },
      update: async function (patch) {
        var p = plain(patch);
        if (name === "settings") {         // the settings records do not exist in a new database; create them on first save
          var ex = await sb.from("documents").select("id").eq("collection", name).eq("id", id).maybeSingle();
          if (!ex.error && !ex.data) {
            var c = await sb.rpc("doc_set", { p_coll: name, p_id: id, p_data: p });
            if (c.error) throw fail(c.error, "save " + name + "/" + id);
            applySet(name, id, p);
            return;
          }
        }
        var r = await sb.rpc("doc_update", { p_coll: name, p_id: id, p_patch: p });
        if (r.error) throw fail(r.error, "update " + name + "/" + id);
        applyMerge(name, id, p);
      },
      "delete": async function () {
        var r = await sb.from("documents").delete().eq("collection", name).eq("id", id).select("id");
        if (r.error) throw fail(r.error, "delete " + name + "/" + id);
        if (!(r.data && r.data.length) && col(name).map.has(id)) throw fail({ code: "42501", message: "Not allowed to delete " + name + "/" + id }, "delete " + name + "/" + id);
        applyDelete(name, id);
      },
      onSnapshot: function (cb, err) { return listen(name, id, cb, err); }
    };
  }

  function collectionRef(name) {
    return {
      path: name,
      doc: function (id) { return docRef(name, id || newId()); },
      add: async function (data) {
        var id = newId(), d = plain(data);
        var r = await sb.from("documents").insert({ collection: name, id: id, data: d });
        if (r.error) throw fail(r.error, "add to " + name);
        applySet(name, id, d);
        return docRef(name, id);
      },
      onSnapshot: function (cb, err) { return listen(name, undefined, cb, err); }
    };
  }

  function splitPath(p) { var a = String(p).split("/").filter(Boolean); return [a[0], a[1]]; }

  var dbApi = {
    collection: function (p) { return collectionRef(splitPath(p)[0]); },
    doc: function (p) { var a = splitPath(p); return docRef(a[0], a[1]); }
  };

  /* ------------------------------ user: who is signed in ------------------------------ */

  var userApi = {
    me: async function () { await ready; return ME; },
    profiles: async function (ids) {
      var uu = (ids || []).map(strip).filter(isUuid);
      var out = {};
      if (!uu.length) return out;
      var r = await sb.from("profiles").select(ME && ME.isOwner ? "id,name,avatar_url,email,is_owner" : "id,name,avatar_url").in("id", uu);
      (r.data || []).forEach(function (p) { out[PREFIX + p.id] = { name: p.name || "Unnamed", avatarUrl: p.avatar_url || avatar(p.name), email: p.email || "", owner: p.is_owner === true }; });
      return out;
    },
    search: async function (q) {
      q = String(q || "").replace(/[,()*%\\]/g, " ").trim();
      if (q.length < 2) return [];
      var r = await sb.from("profiles").select("id,name,email,avatar_url").or("name.ilike.%" + q + "%,email.ilike.%" + q + "%").limit(8);
      return (r.data || []).map(function (p) {
        return { id: PREFIX + p.id, name: p.name || p.email, avatarUrl: p.avatar_url || avatar(p.name), isMe: !!ME && ME.id === PREFIX + p.id };
      });
    }
  };

  /* ------------------------------ assets: photos, PDFs, signatures ------------------------------ */

  function coded(code) { var e = new Error(code); e.code = code; return e; }

  var assetsApi = {
    upload: async function (blob, opts) {
      var type = (opts && opts.type) || blob.type || "application/octet-stream";
      if (blob.size > MAX_BYTES) throw coded("too_large");
      if (!OK_TYPES.test(type)) throw coded("unsupported_type");
      var id = newUuid();
      var r = await sb.storage.from(BUCKET).upload(id, blob, { contentType: type, upsert: false });
      if (r.error) throw fail(r.error, "upload");
      return { id: id, contentType: type };
    }
  };

  /* The app shows files with plain addresses like /_blob/<id>. The bucket is private, so a plain
     address cannot work. These three small pieces fetch the file WITH the person's login and
     give the page a temporary local address instead. */
  var BLOBS = {}, BURLS = {};
  function blobData(id) {
    return BLOBS[id] || (BLOBS[id] = ready.then(async function () {
      var r = await sb.storage.from(BUCKET).download(id);
      if (r.error) { delete BLOBS[id]; throw r.error; }
      return r.data;
    }));
  }
  function blobUrl(id) {
    return BURLS[id] || (BURLS[id] = blobData(id).then(function (b) { return URL.createObjectURL(b); }, function (e) { delete BURLS[id]; throw e; }));
  }
  var BLOB_RE = /^(?:https?:\/\/[^/]+)?\/_blob\/([A-Za-z0-9_-]+)/;

  function patchFetch() {
    var orig = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var m = BLOB_RE.exec(url);
      if (!m) return orig(input, init);
      return blobData(m[1]).then(
        function (b) { return new Response(b, { status: 200, headers: { "Content-Type": b.type || "application/octet-stream" } }); },
        function () { return new Response("", { status: 404 }); });
    };
  }
  function fixImg(el) {
    if (!el || el.tagName !== "IMG") return;
    var m = BLOB_RE.exec(el.getAttribute("src") || "");
    if (!m) return;
    el.removeAttribute("src");
    blobUrl(m[1]).then(function (u) { el.src = u; }, function () { el.setAttribute("alt", el.getAttribute("alt") || "File not available"); });
  }
  function watchImages() {
    new MutationObserver(function (list) {
      list.forEach(function (m) {
        if (m.type === "attributes") { fixImg(m.target); return; }
        m.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          fixImg(n);
          if (n.querySelectorAll) n.querySelectorAll('img[src^="/_blob/"]').forEach(fixImg);
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
    document.querySelectorAll('img[src^="/_blob/"]').forEach(fixImg);
    document.addEventListener("click", function (e) {            // links that open a file in a new tab
      var a = e.target && e.target.closest ? e.target.closest('a[href^="/_blob/"]') : null;
      if (!a) return;
      var m = BLOB_RE.exec(a.getAttribute("href") || "");
      if (!m) return;
      e.preventDefault();
      var w = window.open("", "_blank");                         // open now so pop-up blockers allow it
      blobUrl(m[1]).then(function (u) { if (w) w.location.href = u; else window.open(u, "_blank"); }, function () { if (w) w.close(); });
    }, true);
  }

  /* ------------------------------ downloads ------------------------------ */

  var downloadsApi = {
    save: async function (o) {
      var data = o && o.data, name = (o && o.filename) || "download";
      var blob = data instanceof Blob ? data : new Blob([data == null ? "" : data], { type: /\.csv$/i.test(name) ? "text/csv;charset=utf-8" : "text/plain;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name; a.style.display = "none";
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
    }
  };

  /* ------------------------------ the login screen ------------------------------ */

  var AUTH_CSS =
    "#mmsAuth{position:fixed;inset:0;z-index:2147483000;background:#FBF3F3;display:flex;align-items:center;justify-content:center;padding:16px;font:15px/1.45 'Figtree',system-ui,sans-serif;color:#3a0710;overflow:auto}" +
    "#mmsAuth .card{background:#fff;border:1px solid #F0DEDF;border-top:5px solid #7B1E2B;border-radius:16px;max-width:400px;width:100%;padding:24px;box-shadow:0 10px 30px rgba(74,14,23,.12)}" +
    "#mmsAuth h1{margin:0 0 4px;font-size:22px;color:#7B1E2B}#mmsAuth p{margin:0 0 14px;color:#7a5f62;font-size:13.5px}" +
    "#mmsAuth label{display:block;font-weight:600;font-size:13px;margin:10px 0 4px}" +
    "#mmsAuth input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #d9c3c5;border-radius:10px;font:inherit}" +
    "#mmsAuth button.go{width:100%;margin-top:16px;padding:12px;border:0;border-radius:10px;background:#7B1E2B;color:#fff;font:inherit;font-weight:700;cursor:pointer}" +
    "#mmsAuth button.go:disabled{opacity:.6;cursor:default}" +
    "#mmsAuth .links{display:flex;justify-content:space-between;gap:8px;margin-top:14px;font-size:13px}" +
    "#mmsAuth a{color:#7B1E2B;font-weight:600;cursor:pointer;text-decoration:underline}" +
    "#mmsAuth .msg{margin-top:12px;padding:10px 12px;border-radius:10px;font-size:13px;display:none}" +
    "#mmsAuth .msg.err{display:block;background:#FBE3E0;color:#B0281F}#mmsAuth .msg.ok{display:block;background:#DDF2E5;color:#1D7A49}";

  function showAuth(mode, note) {
    var root = document.getElementById("mmsAuth");
    if (!root) {
      var st = document.createElement("style"); st.textContent = AUTH_CSS; document.head.appendChild(st);
      root = document.createElement("div"); root.id = "mmsAuth"; root.setAttribute("data-noi18n", "");
      document.body.appendChild(root);
    }
    var titles = { signin: "Sign in", signup: "Create your account", reset: "Reset your password", recovery: "Choose a new password" };
    var subs = {
      signin: "Manahil Education Center · Management System",
      signup: "You will not see any records until the owner approves your account.",
      reset: "We will email you a link to set a new password.",
      recovery: "Enter a new password for your account."
    };
    root.innerHTML = "<div class='card'><h1>" + titles[mode] + "</h1><p>" + subs[mode] + "</p><form novalidate>" +
      (mode === "signup" ? "<label for='mmsName'>Full name</label><input id='mmsName' autocomplete='name' required>" : "") +
      (mode !== "recovery" ? "<label for='mmsEmail'>Email</label><input id='mmsEmail' type='email' autocomplete='email' required>" : "") +
      (mode === "signin" || mode === "signup" || mode === "recovery" ? "<label for='mmsPass'>" + (mode === "recovery" ? "New password" : "Password") + "</label><input id='mmsPass' type='password' autocomplete='" + (mode === "signin" ? "current-password" : "new-password") + "' minlength='8' required>" : "") +
      "<button class='go' type='submit'>" + (mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : mode === "reset" ? "Send reset link" : "Save password") + "</button></form>" +
      "<div class='msg' id='mmsMsg'></div>" +
      "<div class='links'>" +
      (mode === "signin" ? "<a data-m='signup'>Create account</a><a data-m='reset'>Forgot password?</a>" : mode === "recovery" ? "" : "<a data-m='signin'>Back to sign in</a>") +
      "</div></div>";

    var msg = root.querySelector("#mmsMsg");
    function say(text, ok) { msg.className = "msg " + (ok ? "ok" : "err"); msg.textContent = text; }
    if (note) say(note, true);
    root.querySelectorAll("a[data-m]").forEach(function (a) { a.onclick = function () { showAuth(a.getAttribute("data-m")); }; });

    root.querySelector("form").onsubmit = async function (ev) {
      ev.preventDefault();
      var btn = root.querySelector("button.go"), v = function (id) { var el = root.querySelector(id); return el ? el.value.trim() : ""; };
      var email = v("#mmsEmail"), pass = root.querySelector("#mmsPass") ? root.querySelector("#mmsPass").value : "", name = v("#mmsName");
      if (mode !== "recovery" && !/^\S+@\S+\.\S+$/.test(email)) return say("Enter a valid email address.");
      if ((mode === "signup" || mode === "recovery") && pass.length < 8) return say("The password must be at least 8 characters.");
      if (mode === "signup" && !name) return say("Enter your full name.");
      btn.disabled = true; msg.className = "msg";
      try {
        if (mode === "signin") {
          var r = await sb.auth.signInWithPassword({ email: email, password: pass });
          if (r.error) throw r.error;
          await enter(r.data.session);
        } else if (mode === "signup") {
          var s = await sb.auth.signUp({ email: email, password: pass, options: { data: { name: name } } });
          if (s.error) throw s.error;
          if (s.data && s.data.session) await enter(s.data.session);
          else showAuth("signin", "Account created. Check your email to confirm it, then sign in.");
        } else if (mode === "reset") {
          var p = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
          if (p.error) throw p.error;
          say("If that email has an account, a reset link is on its way.", true);
        } else if (mode === "recovery") {
          var u = await sb.auth.updateUser({ password: pass });
          if (u.error) throw u.error;
          var g = await sb.auth.getSession();
          if (g.data.session) await enter(g.data.session);
        }
      } catch (e) {
        var m = String((e && e.message) || e);
        say(/invalid login/i.test(m) ? "Wrong email or password." : /already registered/i.test(m) ? "That email already has an account. Use Sign in." : /rate limit/i.test(m) ? "Too many attempts. Wait a few minutes and try again." : m);
      }
      btn.disabled = false;
    };
  }

  function fatal(text) {
    var st = document.createElement("style"); st.textContent = AUTH_CSS; document.head.appendChild(st);
    var d = document.createElement("div"); d.id = "mmsAuth"; d.setAttribute("data-noi18n", "");
    d.innerHTML = "<div class='card'><h1>Setup needed</h1><p>" + esc(text) + "</p></div>";
    document.body.appendChild(d);
  }

  function addSignOut() {
    var row = document.querySelector(".hrow");
    if (!row || document.getElementById("mmsOut")) return;
    var b = document.createElement("button");
    b.id = "mmsOut"; b.className = "term"; b.type = "button"; b.textContent = "Sign out"; b.setAttribute("data-noi18n", "");
    b.onclick = async function () { try { await sb.auth.signOut(); } catch (_) {} location.reload(); };
    row.appendChild(b);
  }

  /* ------------------------------ start-up ------------------------------ */

  async function enter(session) {
    var p = await sb.from("profiles").select("id,name,email,avatar_url,is_owner").eq("id", session.user.id).maybeSingle();
    var prof = (p && p.data) || {};
    var nm = prof.name || String(session.user.email || "").split("@")[0] || "User";
    ME = {
      id: PREFIX + session.user.id,
      name: nm,
      email: session.user.email || "",
      avatarUrl: prof.avatar_url || avatar(nm),
      isOwner: prof.is_owner === true,     // only for showing buttons; the database decides for real
      canEdit: true
    };
    signedIn = true;
    var root = document.getElementById("mmsAuth"); if (root) root.remove();
    startRealtime();
    addSignOut();
    readyResolve();
  }

  async function boot() {
    var bad = !CFG.supabaseUrl || !CFG.supabaseKey || /YOUR-/i.test(CFG.supabaseUrl + CFG.supabaseKey);
    if (bad) return fatal("Open config.js and paste your Supabase project URL and publishable key (see the guide, Step 1).");
    if (!window.supabase || !window.supabase.createClient) return fatal("The Supabase library did not load. Check your internet connection and reload.");
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    patchFetch();
    watchImages();
    sb.auth.onAuthStateChange(function (event) {
      if (event === "PASSWORD_RECOVERY") showAuth("recovery");
      else if (event === "SIGNED_OUT" && signedIn) location.reload();
    });
    var s = await sb.auth.getSession();
    if (s.data && s.data.session) await enter(s.data.session);
    else if (!document.getElementById("mmsAuth")) showAuth("signin");
  }

  window.claude = {
    use: async function (name) {
      if (name === "downloads") return downloadsApi;
      if (name === "sample") throw new Error("Not available outside Claude");
      await ready;                          // wait here until someone has signed in
      if (name === "db") return dbApi;
      if (name === "user") return userApi;
      if (name === "assets") return assetsApi;
      throw new Error("Unknown capability: " + name);
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
