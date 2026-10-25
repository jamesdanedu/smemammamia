/* ==========================================================================
   "Ask Donna" — the chat bubble on the public pages.
   Include after config.js:   <script src="donna.js" defer></script>
   It adds its own stylesheet (donna.css) and does nothing at all when
   CONFIG.features.showDonna is false.

   The conversation lives in this tab only (sessionStorage), so it follows
   the visitor from page to page and is gone when the tab closes. The server
   (/api/donna) stores none of it.
   ========================================================================== */
(function () {
    if (!window.CONFIG || !CONFIG.features || !CONFIG.features.showDonna) return;
    if (document.querySelector('.donna-launch')) return;

    const API = (CONFIG.api && CONFIG.api.donna) || '/api/donna';
    const STORE = 'donna-chat-v1';
    const MAX_CHARS = 300;
    const SEND_TURNS = 8;

    /* Pages Donna may link to — the same list as PAGES in api/_donna-prompt.js.
       Any other link she writes is shown as plain text. */
    const PAGES = ['booking.html', 'about.html', 'seating.html', 'contact.html', 'cast.html',
                   'photos.html', 'quiz.html', 'games.html', 'wall.html'];

    const GREETING = "Kalimera! I'm Donna — I run the taverna, and apparently the website too. " +
                     'Ask me about the show, tickets or the hall.';
    const CHIPS = ["When's the show?", 'How do I book?', 'Is there accessible seating?', "What's it about?"];

    /* ---------- storage (best effort: private windows may refuse) ---------- */
    function load() {
        try { return JSON.parse(sessionStorage.getItem(STORE)) || { open: false, log: [] }; }
        catch (e) { return { open: false, log: [] }; }
    }
    function save() {
        try { sessionStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* fine */ }
    }
    const state = load();
    if (!Array.isArray(state.log)) state.log = [];

    /* ---------- build ---------- */
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'donna.css';
    document.head.appendChild(css);

    const launch = document.createElement('button');
    launch.type = 'button';
    launch.className = 'donna-launch';
    launch.setAttribute('aria-haspopup', 'dialog');
    launch.innerHTML = '<span class="donna-face" aria-hidden="true">💬</span> Ask Donna';

    const panel = document.createElement('section');
    panel.className = 'donna-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Ask Donna — chat');
    panel.innerHTML =
        '<div class="donna-head">' +
          '<div class="donna-face" aria-hidden="true">🌼</div>' +
          '<div class="donna-title"><strong>Donna Sheridan</strong><span>Taverna owner · ex-Dynamo · your host</span></div>' +
          '<button type="button" class="donna-close" aria-label="Close chat">×</button>' +
        '</div>' +
        '<div class="donna-notice"><strong>Donna is an AI chatbot</strong> run by DeepSeek, a company based in China. ' +
          'She can get things wrong — the booking page has the final word. ' +
          '<strong>Please don\'t type your name, phone, email or anything personal.</strong></div>' +
        '<div class="donna-log" role="log" aria-live="polite" aria-relevant="additions"></div>' +
        '<div class="donna-chips"></div>' +
        '<form class="donna-form" novalidate>' +
          '<label class="donna-sr" for="donna-input">Your message to Donna</label>' +
          '<textarea id="donna-input" rows="1" maxlength="' + MAX_CHARS + '" placeholder="Ask Donna…" autocomplete="off"></textarea>' +
          '<button type="submit">Send</button>' +
        '</form>';

    document.body.appendChild(launch);
    document.body.appendChild(panel);

    const log = panel.querySelector('.donna-log');
    const chips = panel.querySelector('.donna-chips');
    const form = panel.querySelector('.donna-form');
    const input = panel.querySelector('textarea');
    const sendBtn = form.querySelector('button');

    CHIPS.forEach(text => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.addEventListener('click', () => send(text));
        chips.appendChild(b);
    });

    /* ---------- rendering ---------- */
    const esc = s => String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** Plain text, with [words](page.html) turned into links to our own pages only. */
    function toHtml(text) {
        return esc(text).replace(/\[([^\]]{1,60})\]\(([a-z]+\.html)\)/g, (m, words, href) =>
            PAGES.indexOf(href) >= 0 ? '<a href="' + href + '">' + words + '</a>' : words);
    }

    function bubble(role, text, note) {
        const div = document.createElement('div');
        div.className = 'donna-msg ' + (note ? 'is-note' : role === 'user' ? 'from-you' : 'from-donna');
        if (role === 'user') div.textContent = text;
        else div.innerHTML = toHtml(text);
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
        return div;
    }

    function renderAll() {
        log.innerHTML = '';
        bubble('assistant', GREETING);
        state.log.forEach(m => bubble(m.role, m.content, m.note));
        chips.hidden = state.log.some(m => m.role === 'user');
    }

    /* ---------- open / close ---------- */
    function open() {
        state.open = true; save();
        panel.hidden = false;
        launch.hidden = true;
        launch.setAttribute('aria-expanded', 'true');
        log.scrollTop = log.scrollHeight;
        input.focus();
    }
    function close() {
        state.open = false; save();
        panel.hidden = true;
        launch.hidden = false;
        launch.setAttribute('aria-expanded', 'false');
        launch.focus();
    }
    launch.addEventListener('click', open);
    panel.querySelector('.donna-close').addEventListener('click', close);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) close(); });

    /* ---------- sending ---------- */
    let busy = false;

    async function send(text) {
        text = String(text || '').trim().slice(0, MAX_CHARS);
        if (!text || busy) return;
        busy = true;
        sendBtn.disabled = true;
        chips.hidden = true;

        state.log.push({ role: 'user', content: text });
        save();
        bubble('user', text);
        input.value = '';

        const typing = document.createElement('div');
        typing.className = 'donna-msg from-donna donna-typing';
        typing.setAttribute('aria-label', 'Donna is typing');
        typing.innerHTML = '<i></i><i></i><i></i>';
        log.appendChild(typing);
        log.scrollTop = log.scrollHeight;

        // Only real turns go back to the server; notes are for this panel.
        const turns = state.log
            .filter(m => !m.note)
            .slice(-SEND_TURNS)
            .map(m => m.sig ? { role: m.role, content: m.content, sig: m.sig } : { role: m.role, content: m.content });

        let reply, sig, note = false;
        try {
            const res = await fetch(API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: turns })
            });
            const data = await res.json().catch(() => ({}));
            if (data.reply) { reply = data.reply; sig = data.sig; }
            else { reply = data.error || 'Donna has wandered off to find the goats. Try again in a moment.'; note = true; }
        } catch (e) {
            reply = "Can't reach the taverna just now — check your connection and try again.";
            note = true;
        }

        typing.remove();
        const entry = { role: 'assistant', content: reply };
        if (sig) entry.sig = sig;
        if (note) entry.note = true;
        state.log.push(entry);
        if (state.log.length > 40) state.log = state.log.slice(-40);
        save();
        bubble('assistant', reply, note);

        busy = false;
        sendBtn.disabled = false;
        input.focus();
    }

    form.addEventListener('submit', e => { e.preventDefault(); send(input.value); });
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); }
    });

    /* ---------- start ---------- */
    renderAll();
    launch.setAttribute('aria-expanded', 'false');
    if (state.open) { panel.hidden = false; launch.hidden = true; launch.setAttribute('aria-expanded', 'true'); }
})();
