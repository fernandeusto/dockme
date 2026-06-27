/* ================================================================
   DockMe v3 — init.js
   Crea el socket y autentica con el token.
   ================================================================ */
(function () {

    // 1. Conectar socket.io
    const socket = io({
        reconnectionDelay: 250,
        reconnectionDelayMax: 1000,
        timeout: 5000
    });

    // 2. Shim del proxy de Vue
    const appEl = document.getElementById('app');
    const proxy = {
        getSocket:        () => socket,
        currentUser:      {},
        username:         '',
        stackList:        {},
        completeStackList:{},
        agentList:        { '': '' },
        agentStatusList:  { '': 'online' },
        allAgentStackList:{},
    };

    // Cargar endpoints remotos de updates.json y añadirlos al agentList
    fetch('/config/updates.json').then(r => r.json()).then(updates => {
        if (!Array.isArray(updates)) return;
        updates.forEach(h => {
            const ep = h.endpoint || '';
            if (ep && ep !== 'Actual') {
                proxy.agentList[ep]       = ep;
                proxy.agentStatusList[ep] = 'online';
            }
        });
    }).catch(() => {});

    if (appEl) {
        appEl._vnode = { component: { root: { proxy } } };
    }

    // ---- Funciones de login/logout ----
    // ---- Modo del overlay: 'login' | 'setup' ----
    let authMode = 'login';

    function showAuth(mode) {
        authMode = mode;
        document.getElementById('app').style.display = 'none';
        document.getElementById('dm-header')?.style.setProperty('display', 'none', 'important');
        const overlay = document.getElementById('dm-auth-overlay');
        if (!overlay) return;
        overlay.style.display = 'flex'; overlay.style.alignItems = 'center'; overlay.style.justifyContent = 'center';
        const subtitle  = document.getElementById('dm-auth-subtitle');
        const repWrap   = document.getElementById('dm-auth-rep-wrap');
        const remWrap   = document.getElementById('dm-auth-remember-wrap');
        const btn       = document.getElementById('dm-auth-btn');
        if (mode === 'setup') {
            if (subtitle) subtitle.textContent = 'Crea tu cuenta de administrador';
            if (repWrap)  repWrap.style.display = '';
            if (remWrap)  remWrap.style.display = 'none';
            if (btn)      btn.textContent = 'Crear';
        } else {
            if (subtitle) subtitle.textContent = '';
            if (repWrap)  repWrap.style.display = 'none';
            const isRemote = window._dmIsRemoteAgent || false;
            if (remWrap)  remWrap.style.setProperty('display', isRemote ? 'none' : '', 'important');
            const remCheck = document.getElementById('dm-remember');
            if (isRemote && remCheck) remCheck.checked = false;
            if (btn)      btn.textContent = 'Iniciar Sesión';
        }
        document.getElementById('dm-auth-user').value = '';
        document.getElementById('dm-auth-pass').value = '';
        document.getElementById('dm-auth-rep').value  = '';
        document.getElementById('dm-auth-err').style.display = 'none';
        setTimeout(() => document.getElementById('dm-auth-user')?.focus(), 100);
    }

    function showLogin() { showAuth('login'); }
    function showSetup() { showAuth('setup'); }

    function hideAuth() {
        const overlay = document.getElementById('dm-auth-overlay');
        if (overlay) overlay.style.display = 'none';
        document.getElementById('app').style.display = '';
        const hdr = document.getElementById('dm-header');
        if (hdr) hdr.style.removeProperty('display');
        else {
            const t = setInterval(() => {
                const h = document.getElementById('dm-header');
                if (h) { h.style.removeProperty('display'); clearInterval(t); }
            }, 100);
        }
    }

    function saveToken(token) {
        const remember = !window._dmIsRemoteAgent && document.getElementById('dm-remember')?.checked;
        if (remember) {
            localStorage.setItem('token', token);
            sessionStorage.removeItem('token');
        } else {
            sessionStorage.setItem('token', token);
            localStorage.removeItem('token');
        }
    }

    function onLoginOk(token) {
        try {
            const payload = JSON.parse(atob(token.split('.')[1]));
            const username = payload.username || 'Usuario';
            if (proxy) {
                proxy.currentUser = { username };
                proxy.username    = username;
            }
                // Rellenar profile-pic y username en el header
            const picEl  = document.getElementById('dm-profile-pic');
            const nameEl = document.getElementById('dm-username');
            if (picEl)  picEl.textContent  = username.charAt(0).toUpperCase();
            if (nameEl) nameEl.textContent = username;
            // Hostname en título
            const titleEl = document.getElementById('dm-header-title');
            if (titleEl) titleEl.textContent = window.hostnameLocal || 'DockMe';
        } catch(e) {}
        hideAuth();
    }

    window._dmLogout = () => {
        socket.emit('logout');
        localStorage.removeItem('token');
        sessionStorage.removeItem('token');
        showLogin();
    };

    socket.on('setup', () => showSetup());

    document.getElementById('dm-auth-btn')?.addEventListener('click', () => {
        const user = document.getElementById('dm-auth-user')?.value.trim();
        const pass = document.getElementById('dm-auth-pass')?.value;
        const err  = document.getElementById('dm-auth-err');
        const btn  = document.getElementById('dm-auth-btn');
        err.style.display = 'none';

        if (!user) { err.textContent = 'El usuario es obligatorio'; err.style.display = 'block'; return; }
        if (!pass) { err.textContent = 'La contraseña es obligatoria'; err.style.display = 'block'; return; }

        if (authMode === 'setup') {
            const rep = document.getElementById('dm-auth-rep')?.value;
            if (pass !== rep) { err.textContent = 'Las contraseñas no coinciden'; err.style.display = 'block'; return; }
            if (pass.length < 8) { err.textContent = 'La contraseña debe tener al menos 8 caracteres'; err.style.display = 'block'; return; }
            btn.disabled = true; btn.textContent = 'Creando...';
            socket.emit('setup', user, pass, res => {
                btn.disabled = false; btn.textContent = 'Crear';
                if (res?.ok) {
                    socket.emit('login', { username: user, password: pass }, lr => {
                        if (lr?.ok) { saveToken(lr.token); onLoginOk(lr.token); }
                    });
                } else { err.textContent = res?.msg || 'Error al crear el usuario'; err.style.display = 'block'; }
            });
        } else {
            btn.disabled = true; btn.textContent = 'Entrando...';
            socket.emit('login', { username: user, password: pass }, res => {
                btn.disabled = false; btn.textContent = 'Iniciar Sesión';
                if (res?.ok) { saveToken(res.token); onLoginOk(res.token); }
                else { err.textContent = res?.msg || 'Usuario o contraseña incorrectos'; err.style.display = 'block'; }
            });
        }
    });

    socket.on('connect', () => {
        // Detectar modo agente antes de mostrar login (para ocultar "Recuérdame")
        fetch('/config/settings.json')
            .then(r => r.json())
            .then(s => { if (s?.centralUrl) window._dmIsRemoteAgent = true; })
            .catch(() => {})
            .finally(() => {
                const token = localStorage.getItem('token') || sessionStorage.getItem('token');
                if (!token) {
                    setTimeout(() => { if (authMode !== 'setup') showLogin(); }, 300);
                    return;
                }
                socket.emit('loginByToken', token, res => {
                    if (res?.ok) {
                        console.log('[v2] Autenticado con token');
                        onLoginOk(token);
                    } else {
                        localStorage.removeItem('token');
                        sessionStorage.removeItem('token');
                        setTimeout(() => { if (authMode !== 'setup') showLogin(); }, 300);
                    }
                });
            });
    });

    ['dm-auth-pass', 'dm-auth-rep'].forEach(id => {
        document.getElementById(id)?.addEventListener('keydown', e => {
            if (e.key === 'Enter') document.getElementById('dm-auth-btn')?.click();
        });
    });

    window.dockmeSocket = socket;

    // ---- Banner de conexión perdida ----
    const banner = document.createElement('div');
    banner.id = 'dm-conn-banner';
    banner.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
        'background:#c0392b', 'color:#fff', 'text-align:center',
        'padding:10px 16px', 'font-size:14px', 'font-weight:600',
        'display:none', 'align-items:center', 'justify-content:center', 'gap:10px'
    ].join(';');
    banner.innerHTML = '<span>⚠ Se ha perdido la conexión con el servidor. Reconectando...</span>';
    document.body.appendChild(banner);

    let wasDisconnected = false;

    socket.on('disconnect', () => {
        wasDisconnected = true;
        banner.style.display = 'flex';
    });

    socket.on('connect', () => {
        if (wasDisconnected) {
            banner.style.background = '#27ae60';
            banner.querySelector('span').textContent = '✓ Conexión restaurada. Recargando...';
            setTimeout(() => window.location.reload(), 300);
        }
    });

    // Poblar AgentsState desde updates.json
    fetch('/config/updates.json').then(r => r.json()).then(updates => {
        if (!Array.isArray(updates)) return;
        const agentsMap = {};
        updates.forEach(h => {
            const ep = h.endpoint || 'Actual';
            agentsMap[ep] = {
                endpoint:   ep,
                hostname:   h.hostname || ep,
                isOnline:   ep === 'Actual', // local siempre online
                hasMetrics: false
            };
        });

        // AgentsState solo contiene los CONECTADOS (igual que el original)
        // Los que están en updates.json pero no en AgentsState → "detectados sin conectar"
        const updateConnected = () => {
            if (!window._dmAgentsState) return;
            const online = Object.values(agentsMap).filter(a => a.isOnline);
            window._dmAgentsState.setAgents(online);
            fetch('/api/set-connected-endpoints', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoints: online.map(a => a.endpoint) })
            }).catch(() => {});
        };

        const trySet = () => {
            if (!window._dmAgentsState) { setTimeout(trySet, 200); return; }
            updateConnected();
        };
        setTimeout(trySet, 500);

        // Si un remoto tiene loggedIn:true en updates.json y llega su stackList → añadir a AgentsState
        // Esto restaura el estado tras F5 para agentes ya conectados
        socket.on('agent', (eventName, data) => {
            if (eventName !== 'stackList' || !data?.ok || !data?.endpoint) return;
            const ep = data.endpoint;
            if (!ep || !agentsMap[ep]) return; // ignorar local ("")
            if (agentsMap[ep].isOnline) return; // ya está
            // Solo si estaba logueado antes (loggedIn en updates.json)
            const host = (window.updatesDataGlobal || []).find(h =>
                (h.endpoint || '').toLowerCase() === ep.toLowerCase()
            );
            if (host?.loggedIn) {
                agentsMap[ep].isOnline = true;
                updateConnected();
            }
        });
    }).catch(() => {});

})();
