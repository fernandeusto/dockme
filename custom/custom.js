(function () {
    'use strict';
    let dockmeWaitingForLogin = false;
    let dockmeLoginWasVisible = false;
    let dockmeEditMode = false;
    let dockmeIconVersion = localStorage.getItem('dockmeIconVersion') || Date.now();

    // ==================== CONSTANTES ====================
    const CONFIG = {
        DEBOUNCE_MS: 150,
        BASE_URL: window.location.origin,
        ICON_DEFAULT: `${window.location.origin}/icons/no-icon.svg`,
        REORDER_INTERVAL: 1000,
        ROUTE_CHECK_INTERVAL: 250,
        STATS_UPDATE_INTERVAL: 5000,
        RECENT_COMPOSES_LIMIT: 9,
        NOTIFICATION_BLOCK_TIME: 24 * 60 * 60 * 1000, // 24h en ms
        LOGO_INSERT_DELAY: 100,
        FOCUS_DELAY: 1200,
        ICON_REFRESH_DELAY: 1000
    };

    // ==================== GESTIÓN DE ESTADO GLOBAL ====================
    const State = {
        updatesDataGlobal: null,
        sourcesDataGlobal: null,
        hostnameLocal: null,
        lastPath: window.location.pathname,
        
        setUpdatesData(data) {
            this.updatesDataGlobal = data;
            window.updatesDataGlobal = data;
        },
        
        setSourcesData(data) {
            this.sourcesDataGlobal = data;
            window.sourcesDataGlobal = data;
        },

        setLocalHostname(hostname) {
            this.hostnameLocal = hostname;
            window.hostnameLocal = hostname;
        }
    };

    // ==================== UTILIDADES ====================
    const Utils = {
        debounce(func, wait) {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        },

        capitalizeFirst(str) {
            return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
        },

        removePrefix(str, prefix) {
            return str.toLowerCase().startsWith(prefix) ? str.slice(prefix.length) : str;
        },

        isEditing() {
            const el = document.activeElement;
            if (!el) return false;
            if (el.classList?.contains('search-input') && el.value.trim() === '') {
                return false;
            }
            return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
        },

        loadImage(url, fallback) {
            return new Promise((resolve) => {
                const img = new Image();
                img.onload = () => resolve(url);
                img.onerror = () => resolve(fallback);
                img.src = url;
            });
        },

        formatDate(timestamp) {
            const fecha = new Date(timestamp);
            const opciones = { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' };
            return fecha.toLocaleString('es-ES', opciones).replace(',', '');
        }
    };
    // ==================== UI / NAVEGACIÓN ====================
    function updatePageTitleForRoute() {
        const titleElement = document.querySelector('.fs-4.title');
        if (!titleElement) return;
        let routeHostname = null;
        if (RouteManager.isComposePath() || window.location.pathname.startsWith('/terminal/')) {
            const resolved = RouteManager.getHostnameForRoute();
            const endpoint = RouteManager.extractEndpoint?.();
            if (resolved && endpoint && resolved !== endpoint) {
                routeHostname = resolved;
            }
        }
        if (RouteManager.isComposeCreatePath()) {
            if (titleElement.textContent.trim().toLowerCase() === 'dockge') {
                const fallback = State.hostnameLocal || 'Dockme';
                titleElement.textContent = fallback;
                document.title = fallback;
            }
            titleElement.style.visibility = '';
            document.body.classList.add('dockme-title-ready');
            return;
        }
        const hostname = routeHostname || State.hostnameLocal || 'Dockme';
        titleElement.textContent = hostname;
        document.title = hostname;
        titleElement.style.visibility = '';
        document.body.classList.add('dockme-title-ready');
    }

    function ensureTitleIsCorrect() {
        const titleElement = document.querySelector('.fs-4.title');
        if (!titleElement) return;
        updatePageTitleForRoute();
    }
    // ==================== GESTIÓN DE STORAGE ====================
    const Storage = {
        get(key, defaultValue = null) {
            try {
                return JSON.parse(localStorage.getItem(key)) ?? defaultValue;
            } catch {
                return defaultValue;
            }
        },

        set(key, value) {
            try {
                localStorage.setItem(key, JSON.stringify(value));
                return true;
            } catch {
                return false;
            }
        },

        remove(key) {
            try {
                localStorage.removeItem(key);
                return true;
            } catch {
                return false;
            }
        }
    };

    // ==================== GESTIÓN DE RUTAS ====================
    const RouteManager = {
        extractEndpoint() {
            const path = window.location.pathname;
            // /compose/stack/endpoint
            let match = path.match(/^\/compose\/[^/]+\/([^/]+)$/);
            if (match) return match[1];
            // /terminal/stack/container/shell/endpoint
            match = path.match(/^\/terminal\/[^/]+\/[^/]+\/[^/]+\/(.+)$/);
            if (match) return match[1];
            
            return 'Actual';
        },

        extractStackName() {
            const match = window.location.pathname.match(/^\/compose\/([^/]+)/);
            return match ? match[1] : null;
        },

        extractComposeParts() {
            const match = window.location.pathname.match(/^\/compose\/([^/]+)(?:\/([^/]+))?/);
            if (!match) return null;
            return {
                name: match[1],
                endpoint: match[2] || 'Actual'
            };
        },

        getHostnameForRoute() {
            const endpoint = this.extractEndpoint();
            // Endpoint remoto
            if (endpoint && endpoint !== 'Actual') {
                if (Array.isArray(State.updatesDataGlobal)) {
                    const host = State.updatesDataGlobal.find(h =>
                        h.endpoint?.toLowerCase() === endpoint.toLowerCase()
                    );
                    if (host?.hostname) {
                        return host.hostname;
                    }
                }
                return endpoint;
            }
            // Endpoint local
            return State.hostnameLocal || null;
        },

        isRootPath() {
            return window.location.pathname === '/';
        },

        isComposePath() {
            return window.location.pathname.startsWith('/compose/');
        },

        isComposeCreatePath() {
            return window.location.pathname === '/compose';
        },

        isSetupPath() {
            return window.location.pathname === '/setup';
        },

        isSettingsPath() {
            return window.location.pathname.startsWith('/settings');
        }
    };

    // ==================== GESTIÓN DE NOTIFICACIONES ====================
    const NotificationManager = {
        KEY: 'notificacionesBloqueadas',

        ignore(nombre, endpoint = null) {
            const ahora = Date.now();
            const expiracion = ahora + CONFIG.NOTIFICATION_BLOCK_TIME;

            let bloqueadas = Storage.get(this.KEY, []);
            bloqueadas = bloqueadas.filter(item => item.expiracion > ahora);
            bloqueadas.push({ nombre, endpoint, expiracion });
            
            Storage.set(this.KEY, bloqueadas);
        },

        filter(lista) {
            const ahora = Date.now();
            let bloqueadas = Storage.get(this.KEY, []);
            
            bloqueadas = bloqueadas.filter(item => item.expiracion > ahora);
            Storage.set(this.KEY, bloqueadas);

            return lista.filter(item => {
                const nombre = item.stack || item.name || item.nombre || item;
                const endpoint = item.endpoint || null;

                return !bloqueadas.some(b =>
                    b.nombre.toLowerCase() === nombre.toLowerCase() &&
                    ((b.endpoint || '').toLowerCase() === (endpoint || '').toLowerCase())
                );
            });
        }
    };

    // ==================== GESTIÓN DE VISITAS RECIENTES ====================
    const RecentManager = {
        KEY: 'recentComposes',

        add() {
            const parts = RouteManager.extractComposeParts();
            if (!parts) return;
            setTimeout(() => {
                const badge = document.querySelector('.badge');
                const isNotFound = badge?.textContent.trim() === '?' || 
                                   badge?.querySelector('span')?.textContent.trim() === '?';
                if (isNotFound) {
                    this.remove(parts.name, parts.endpoint);
                    return;
                }
                let recientes = Storage.get(this.KEY, []);
                recientes = recientes.filter(item =>
                    !(item.name.toLowerCase() === parts.name.toLowerCase() &&
                      (item.endpoint || 'Actual').toLowerCase() === parts.endpoint.toLowerCase())
                );
                recientes.unshift({
                    name: parts.name,
                    visited: Date.now(),
                    endpoint: parts.endpoint
                });
                if (recientes.length > CONFIG.RECENT_COMPOSES_LIMIT) {
                    recientes = recientes.slice(0, CONFIG.RECENT_COMPOSES_LIMIT);
                }
                Storage.set(this.KEY, recientes);
            }, 500);
        },

        remove(nombre, endpoint) {
            let recientes = Storage.get(this.KEY, []);
            recientes = recientes.filter(item =>
                !(item.name === nombre && item.endpoint === endpoint)
            );
            Storage.set(this.KEY, recientes);
        },

        getAll() {
            return Storage.get(this.KEY, []);
        }
    };

    // ==================== API ====================
    const API = {
        async fetchJSON(url) {
            const response = await fetch(url);
            if (!response.ok) throw new Error();
            return response.json();
        },

        async loadSources() {
            try {
                return await this.fetchJSON(`${CONFIG.BASE_URL}/config/sources.json?t=${Date.now()}`);
            } catch {
                return {};
            }
        },

        async loadUpdates() {
            try {
                return await this.fetchJSON(`${CONFIG.BASE_URL}/config/updates.json?t=${Date.now()}`);
            } catch {
                return [];
            }
        },

        async removeUpdate(stack, hostname) {
            try {
                const response = await fetch(`${CONFIG.BASE_URL}/api/remove-update`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ stack, hostname })
                });
                return await response.json();
            } catch {
                return null;
            }
        }
    };

    // ==================== GESTIÓN DE ICONOS Y BADGES ====================
    const BadgeManager = {
        getStateColor(estado) {
            const e = (estado || '').toLowerCase();
            if (e.includes('inactivo') || e.includes('inactive')) return 'gray';
            if (e.includes('activo') || e.includes('running') || e.includes('up') || e.includes('starting')) return 'green';
            if (e.includes('finalizado') || e.includes('exited') || e.includes('down') || e.includes('stopped')) return 'red';
            return 'gray';
        },

        inferStateFromClass(badge) {
            const cs = badge.classList;
            if (cs.contains('bg-success')) return 'running';
            if (cs.contains('bg-warning')) return 'starting';
            if (cs.contains('bg-danger')) return 'exited';
            if (cs.contains('bg-secondary') || cs.contains('bg-info')) return 'inactive';
            return '';
        },

        normalize(badge) {
            if (badge.className !== 'cp-badge') {
                badge.className = 'cp-badge';
            }
            
            [...badge.childNodes].forEach(n => {
                if (n.nodeType === Node.TEXT_NODE) {
                    badge.removeChild(n);
                } else if (n.nodeType === Node.ELEMENT_NODE) {
                    const isIcon = n.classList?.contains('cp-icon');
                    const isCircle = n.classList?.contains('cp-circle');
                    if (!isIcon && !isCircle) {
                        badge.removeChild(n);
                    }
                }
            });
        },

        async ensureIcon(badge, item) {
            let img = badge.querySelector('img.cp-icon');
            const href = item.getAttribute('href') || '';
            const match = href.match(/^\/compose\/([^/]+)/);
            const nombreOriginal = match ? match[1] : null;
            if (!nombreOriginal) return;
            const iconoUrl = getStackIconUrl(nombreOriginal);
            if (!img) {
                img = document.createElement('img');
                img.className = 'cp-icon';
                img.setAttribute('data-icono-app', '1');
                img.style.height = '96px';
                img.style.width = 'auto';
                img.style.marginRight = '8px';
                badge.insertBefore(img, badge.firstChild);
            }
            const finalUrl = await Utils.loadImage(
                iconoUrl,
                `${CONFIG.ICON_DEFAULT}?v=${dockmeIconVersion}`
            );
            img.src = finalUrl;
            if (finalUrl.includes(CONFIG.ICON_DEFAULT)) {
                img.dataset.iconoFallback = 'true';
            } else {
                delete img.dataset.iconoFallback;
            }
        },

        ensureCircle(badge) {
            let circulo = badge.querySelector('span.cp-circle');
            if (!circulo) {
                circulo = document.createElement('span');
                circulo.className = 'cp-circle';
                circulo.setAttribute('data-circulo-estado', '1');
                badge.appendChild(circulo);
            }
            return circulo;
        },

        applyState(badge) {
            let estado = (badge.dataset.cpEstado || '').trim();
            if (!estado) {
                const texto = (badge.textContent || '').trim();
                if (texto) estado = texto;
            }
            if (!estado) {
                estado = this.inferStateFromClass(badge);
            }
            
            badge.dataset.cpEstado = estado || '';
            const color = this.getStateColor(estado);
            const circulo = this.ensureCircle(badge);
            circulo.style.backgroundColor = color;
            circulo.dataset.colorEstado = color;
            circulo.title = estado || 'estado';
        },

        process(badge, item) {
            const snap = (badge.textContent || '').trim();
            if (snap) badge.dataset.cpEstado = snap;
            
            this.normalize(badge);
            this.ensureIcon(badge, item);
            this.applyState(badge);
        }
    };

    // ==================== GESTIÃ“N DE ITEMS ====================
    const ItemManager = {
        processTitle(item) {
            const span = item.querySelector('.title span');
            if (!span) return '';
            
            const original = span.textContent.trim();
            let texto = Utils.removePrefix(original, 'ix-');
            texto = Utils.capitalizeFirst(texto);
            
            if (texto !== original) span.textContent = texto;
            
            const circulo = item.querySelector('.cp-badge .cp-circle');
            const inactivo = circulo && circulo.dataset.colorEstado === 'gray';
            
            span.classList.add('cp-title');
            span.classList.toggle('active', !inactivo);
            span.classList.toggle('inactive', inactivo);
            
            item.dataset.cpSortKey = texto.toLowerCase();
            item.dataset.cpGrupo = inactivo ? '1' : '0';
            
            return original;
        },

        processEndpoint(item) {
            const href = item.getAttribute('href') || '';
            const match = href.match(/^\/compose\/([^/]+)(?:\/([^/]+))?/);
            if (!match) return;

            const endpoint = match[2] || 'Actual';
            const host = State.updatesDataGlobal?.find(h =>
                h.endpoint.toLowerCase() === endpoint.toLowerCase()
            );
            const hostname = host?.hostname || endpoint;

            const divEndpoint = item.querySelector('.endpoint');
            if (divEndpoint) {
                divEndpoint.textContent = hostname;
                divEndpoint.style.color = '#4275b6';
                divEndpoint.style.marginTop = '0px';
            }
        },

        needsReorder(items) {
            const byDom = Array.from(items);
            const byKey = [...items].sort((a, b) => {
                const ka = a.dataset.cpSortKey || '';
                const kb = b.dataset.cpSortKey || '';
                return ka.localeCompare(kb);
            });
            
            return byDom.some((el, i) => el !== byKey[i]);
        },

        reorder() {
            if (Utils.isEditing()) return;
            
            const items = Array.from(document.querySelectorAll('a.item'));
            if (items.length === 0) return;

            items.forEach(item => this.processTitle(item));
            
            if (!this.needsReorder(items)) return;

            const contenedor = items[0].parentElement;
            if (!contenedor) return;

            const ordenados = [...items].sort((a, b) => {
                const ga = a.dataset.cpGrupo || '0';
                const gb = b.dataset.cpGrupo || '0';
                if (ga !== gb) return ga.localeCompare(gb);

                const ka = a.dataset.cpSortKey || '';
                const kb = b.dataset.cpSortKey || '';
                return ka.localeCompare(kb);
            });

            const frag = document.createDocumentFragment();
            ordenados.forEach(el => frag.appendChild(el));
            contenedor.appendChild(frag);
        },

        processAll() {
            document.querySelectorAll('a.item').forEach(item => {
                this.processTitle(item);
                this.processEndpoint(item);
                
                const badge = item.querySelector('.badge');
                if (badge) {
                    BadgeManager.process(badge, item);
                }
            });
            
            this.reorder();
        },

        refreshIcons() {
            document.querySelectorAll('a.item').forEach(item => {
                const badge = item.querySelector('.badge');
                if (badge) {
                    BadgeManager.ensureIcon(badge, item);
                }
            });
        }
    };

    // ==================== GESTIÓN DE BLOQUES DE STACKS ====================
    const StackBlockManager = {
        async create(contenedor, lista, idBase, titulo, status, sources = {}) {
            if (idBase.startsWith('updates')) {
                lista = NotificationManager.filter(lista);
            }
            if (!Array.isArray(lista) || lista.length === 0) {
                this.remove(contenedor, idBase);
                return;
            }
            let blockTitle = contenedor.querySelector(`#${idBase}-title`);
            if (!blockTitle) {
                blockTitle = document.createElement('h2');
                blockTitle.id = `${idBase}-title`;
                blockTitle.className = 'dashboard-section-title mb-3';
                blockTitle.textContent = titulo;
                contenedor.appendChild(blockTitle);
            }
            let blockRow = contenedor.querySelector(`#${idBase}-row`);
            if (!blockRow) {
                blockRow = document.createElement('div');
                blockRow.id = `${idBase}-row`;
                blockRow.classList.add('dashboard-section-grid');
                if (idBase.startsWith('recientes')) {
                    blockRow.classList.add('dashboard-grid-recientes');
                } else if (idBase.startsWith('updates')) {
                    blockRow.classList.add('dashboard-grid-updates');
                }
                contenedor.appendChild(blockRow);
            }
            blockRow.innerHTML = '';
            lista.forEach(item => {
                const card = this.createCard(item, idBase, sources, blockTitle, blockRow);
                blockRow.appendChild(card);
            });
        },

        createCard(item, idBase, sources, blockTitle, blockRow) {
            const { nombre, displayName, endpoint, composePath, fechaFormateada, dockerExtra } = 
                this.extractCardData(item, idBase);

            const iconoUrl = getStackIconUrl(nombre);
            const link = document.createElement('a');
            link.href = composePath;
            link.className = 'stack-card-link';

            link.addEventListener('click', e => {
                if (e.target.closest('a[target="_blank"]')) return;
                e.preventDefault();
                window.history.pushState({}, '', link.href);
                window.dispatchEvent(new Event('popstate'));
            });

            const card = document.createElement('div');
            card.className = 'stack-card-horizontal';

            if (idBase.startsWith('updates')) {
                this.setupUpdateCard(card, item, nombre, displayName, iconoUrl, sources, endpoint, blockTitle, blockRow);
            } else if (idBase.startsWith('recientes')) {
                this.setupRecentCard(card, item, displayName, iconoUrl, fechaFormateada);
            } 

            link.appendChild(card);
            return link;
        },

        extractCardData(item, idBase) {
            let nombre, displayName, endpoint, dockerExtra = '', fechaFormateada = '';

            if (idBase.startsWith('recientes')) {
                nombre = item.name;
                endpoint = item.endpoint || 'Actual';
                fechaFormateada = Utils.formatDate(item.visited);

            } else if (idBase.startsWith('updates')) {
                nombre = item.stack;
                endpoint = item.endpoint || 'Actual';

                if (item.dockers) {
                    const stackNorm = String(item.stack).toLowerCase();
                    const dockerNorm = String(item.dockers).toLowerCase();
                    if (dockerNorm !== stackNorm) {
                        dockerExtra = ` (${item.dockers})`;
                    }
                }

            } else {
                nombre = item;
                endpoint = 'Actual';
            }

            displayName = Utils.removePrefix(nombre, 'ix-');
            displayName = Utils.capitalizeFirst(displayName) + dockerExtra;

            const isRemote = endpoint && endpoint.toLowerCase() !== 'actual';
            const composePath = isRemote
                ? `/compose/${nombre}/${endpoint}`
                : `/compose/${nombre}`;

            return {
                nombre,
                displayName,
                endpoint,
                composePath,
                fechaFormateada,
                dockerExtra
            };
        },

        setupUpdateCard(card, item, nombre, displayName, iconoUrl, sources, endpoint, blockTitle, blockRow) {
            card.className = 'stack-card-horizontal update';
            const repoUrl = sources[nombre] || '';
            const changelogLine = repoUrl 
                ? `<a href="${repoUrl}/releases" target="_blank">${repoUrl}/releases</a>`
                : '';

            const mostrarHostname = 
                item.hostname &&
                State.hostnameLocal &&
                item.hostname !== State.hostnameLocal;

            card.innerHTML = `
                <div class="stack-logo-left">    
                    <img src="${iconoUrl}" alt="${displayName} logo">
                </div>
                <div class="stack-info">
                    <div class="linea1-stack-update">
                        <div class="stack-name">${displayName}</div>
                        <div class="stack-ignorar">
                            <strong class="ignore-btn">Ignorar</strong>
                        </div>
                    </div>
                    <div class="stack-hostname">${mostrarHostname ? item.hostname : '&nbsp;'}</div>
                    <div class="stack-docker-image">
                        ${changelogLine ? `Changelog: ${changelogLine}` : '&nbsp;'}
                    </div>
                </div>
            `;
            const img = card.querySelector('img');
            if (img) {
                img.onerror = () => {
                    if (img.src !== CONFIG.ICON_DEFAULT) {img.src = CONFIG.ICON_DEFAULT;}
                };
            }
            const ignoreBtn = card.querySelector('.ignore-btn');
            if (ignoreBtn) {
                ignoreBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    NotificationManager.ignore(nombre, endpoint);
                    card.remove();
                    if (blockRow.querySelectorAll('.stack-card-horizontal').length === 0) {
                        blockTitle.remove();
                        blockRow.remove();
                    }
                });
            }
        },

        setupRecentCard(card, item, displayName, iconoUrl, fechaFormateada) {
            const mostrarHostname = 
                item.hostname &&
                State.hostnameLocal &&
                item.hostname !== State.hostnameLocal;

            card.innerHTML = `
                <div class="stack-logo-left">    
                    <img src="${iconoUrl}" alt="${displayName} logo">
                </div>
                <div class="stack-info">
                    <div class="stack-name">${displayName}</div>
                    <div class="stack-hostname">${mostrarHostname ? item.hostname : '&nbsp;'}</div>
                    <div class="stack-status">${fechaFormateada}</div>
                </div>
            `;
            const img = card.querySelector('img');
            if (img) {
                img.onerror = () => {
                    if (img.src !== CONFIG.ICON_DEFAULT) {img.src = CONFIG.ICON_DEFAULT;}
                };
            }
        },

        remove(contenedor, idBase) {
            const title = contenedor.querySelector(`#${idBase}-title`);
            const row = contenedor.querySelector(`#${idBase}-row`);
            if (title) title.remove();
            if (row) row.remove();
        }
    };

    // ==================== GESTION DE DATOS (LOADER) ====================
    const DataLoader = {
        async loadAndDisplay() {
            if (!RouteManager.isRootPath()) return;
            
            const detected = getDetectedServers();
            const hasDetected = detected.length > 0;
            const updatesData = State.updatesDataGlobal;
            const sources = State.sourcesDataGlobal || {};

            if (!Array.isArray(updatesData)) return;

            const localHost =
                updatesData.find(h => h.endpoint?.toLowerCase() === 'actual') ||
                updatesData[0];

            const dashboard = document.querySelector('#dockme-dashboard');
            if (!dashboard) return;

            const col7 = dashboard;
            const allUpdates = [];
            updatesData.forEach(host => {
                const shouldFilter = AgentsState.agents.length > 0;
                
                if (shouldFilter) {
                    const connectedEndpoints = AgentsState.agents.map(a => a.endpoint.toLowerCase());
                    if (!connectedEndpoints.includes((host.endpoint || 'Actual').toLowerCase())) {
                        return;
                    }
                }
                
                const updates = Array.isArray(host.updates) ? host.updates : [];
                updates.forEach(u => {
                    allUpdates.push({
                        ...u,
                        endpoint: host.endpoint || 'Actual',
                        hostname: host.hostname || host.endpoint || 'Actual'
                    });
                });
            });

            allUpdates.sort((a, b) =>
                a.stack.localeCompare(b.stack, undefined, { sensitivity: 'base' })
            );
            window.allUpdatesGlobal = allUpdates;

            await StackBlockManager.create(
                col7,
                allUpdates,
                'updates',
                '⬆️ Actualizaciones disponibles',
                'Actualización',
                sources
            );

            // Recientes
            const recientesRaw = RecentManager.getAll();
            const endpointToHost = {};
            updatesData.forEach(h => {
                endpointToHost[h.endpoint] = h.hostname;
            });

            const recientesPlano = recientesRaw.map(item => ({
                ...item,
                hostname: endpointToHost[item.endpoint] || item.endpoint
            }));

            await StackBlockManager.create(
                col7,
                recientesPlano,
                'recientes',
                '🕘 Últimos visitados',
                '',
                sources
            );
        }
    };

    // ==================== UI COMPONENTS ====================
    const UIComponents = {
        async insertLogo() {
            const stackName = RouteManager.extractStackName();
            if (!stackName) return;
            if (document.querySelector('.compose-header')) return;
            const h1 = document.querySelector('h1.mb-3');
            if (!h1) return;
            const container = h1.parentElement;
            if (!container) return;
            const iconUrl = getStackIconUrl(stackName);
            const sources = State.sourcesDataGlobal || {};
            const githubUrl = sources[stackName];
            const row = document.createElement('div');
            row.className = 'row mb-4 compose-header align-items-start';
            const colLogo = document.createElement('div');
            colLogo.className = 'col-auto';
            const img = document.createElement('img');
            img.className = 'cp-icon';
            img.src = iconUrl;
            img.style.height = '96px';
            img.style.width = 'auto';
            img.onerror = () => {
                if (img.src !== CONFIG.ICON_DEFAULT) {
                    img.src = CONFIG.ICON_DEFAULT;
                }
            };
            if (githubUrl) {
                const link = document.createElement('a');
                link.href = githubUrl;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.appendChild(img);
                colLogo.appendChild(link);
            } else {
                colLogo.appendChild(img);
            }
            const colContent = document.createElement('div');
            colContent.className = 'col';
            colContent.appendChild(h1);
            let next = h1.nextElementSibling;
            while (next && next.tagName !== 'HR') {
                const current = next;
                next = next.nextElementSibling;
                colContent.appendChild(current);
            }
            row.appendChild(colLogo);
            row.appendChild(colContent);
            container.insertBefore(row, container.firstChild);
        },

        replaceEndpointsInSelect() {
            if (!State.updatesDataGlobal) return;

            const endpointToHost = {};
            State.updatesDataGlobal.forEach(h => {
                if (h.endpoint && h.hostname) {
                    endpointToHost[h.endpoint] = h.hostname;
                }
            });

            const selects = document.querySelectorAll('select.form-select');
            selects.forEach(select => {
                select.querySelectorAll('option').forEach(option => {
                    const endpoint = option.value;
                    if (!endpoint) {
                        option.textContent = `(local) ${endpointToHost['Actual']}`;
                        return;
                    }
                    const hostname = endpointToHost[endpoint];
                    if (hostname) {
                        option.textContent = option.textContent.replace(endpoint, hostname);
                    }
                });
            });
        }
    };

    // ==================== EVENT HANDLERS ====================
    const EventHandlers = {
        handleButtonClick(e) {
            if (dockmeEditMode) {
                const stackItem = e.target.closest('a.item');
                if (stackItem) {
                    e.preventDefault();
                    e.stopPropagation();

                    const href = stackItem.getAttribute('href');
                    if (!href) return;

                    handleEditStackSelection(href);
                    return;
                }
            }

            const btn = e.target.closest('button.btn');
            if (!btn) return;

            const icon = btn.querySelector('svg[data-icon]');
            const iconName = icon?.getAttribute('data-icon');

            if (iconName === 'cloud-arrow-down' || iconName === 'rocket') {
                const pathParts = location.pathname.split('/');
                const endpoint = pathParts.length > 3 ? pathParts[3] : 'Actual';

                if (isDockmeCompose()) {
                    e.preventDefault();
                    e.stopPropagation();

                    if (
                        !confirm(
                            'Dockme se reiniciará para aplicar la actualización.\n\n' +
                            '¿Deseas continuar?'
                        )
                    ) {
                        return;
                    }

                    this.handleUpdateButton();

                    if (iconName === 'rocket') {
                        const saveBtn = document.querySelector(
                            'button.btn.btn-normal svg[data-icon="floppy-disk"]'
                        )?.closest('button');
                        if (saveBtn) saveBtn.click();
                    }

                    const isLocalDockme = endpoint.toLowerCase() === 'actual';

                    const fetchUrl = isLocalDockme
                        ? '/api/update-self'
                        : '/api/update-dockme';

                    const fetchOptions = isLocalDockme
                        ? { method: 'POST' }
                        : {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ endpoint })
                        };

                    fetch(fetchUrl, fetchOptions)
                        .then(res => (res.ok ? res.json() : null))
                        .then(() => {
                            if (isLocalDockme) {
                                const overlay = document.createElement('div');
                                overlay.id = 'dockme-update-overlay';
                                overlay.innerHTML = `
                                    <div class="dockme-update-box">
                                        <h2>⚠️ Dockme se está actualizando</h2>
                                        <p>El servicio se reiniciará para aplicar la actualización.</p>
                                        <p>
                                            La página debería recargarse automáticamente en unos segundos.
                                            Si no ocurre, puedes recargarla manualmente.
                                        </p>
                                    </div>
                                `;
                                document.body.appendChild(overlay);
                            } else {
                                window.history.pushState({}, '', '/');
                                window.dispatchEvent(new Event('popstate'));
                                setTimeout(() => {
                                    showMetricsAlert(`⏳ Actualizando y reconectando Dockme remoto...`, 20000);
                                }, 2000);
                            }
                        });

                    return;
                }

                if (iconName === 'cloud-arrow-down') {
                    this.handleUpdateButton();
                    return;
                }

                if (iconName === 'rocket') {
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                    return;
                }
            }

            if (iconName === 'trash') {
                this.handleDeleteButton();
            }
        },

        handleUpdateButton() {
            const pathParts = location.pathname.split('/');
            const stack = pathParts.length > 2 ? pathParts[2] : null;
            if (!stack) return;
            if (!Array.isArray(State.updatesDataGlobal)) return;
            const endpoint = pathParts.length > 3 ? pathParts[3] : 'Actual';
            const hostEntry = State.updatesDataGlobal.find(
                h => h.endpoint?.toLowerCase() === endpoint.toLowerCase()
            );
            if (!hostEntry?.hostname) return;
            API.removeUpdate(stack, hostEntry.hostname)
                .then(() => API.loadUpdates())
                .then(updatesData => {
                    State.setUpdatesData(updatesData);
                });
        },

        handleDeleteButton() {
            const parts = RouteManager.extractComposeParts();
            if (!parts) return;
            RecentManager.remove(parts.name, parts.endpoint);
            if (!Array.isArray(State.updatesDataGlobal)) return;
            const hostEntry = State.updatesDataGlobal.find(
                h => h.endpoint?.toLowerCase() === parts.endpoint.toLowerCase()
            );
            if (!hostEntry?.hostname) return;
            API.removeUpdate(parts.name, hostEntry.hostname)
                .then(() => API.loadUpdates())
                .then(updatesData => {
                    State.setUpdatesData(updatesData);
                    setTimeout(() => {
                        if (RouteManager.isRootPath()) {
                            DataLoader.loadAndDisplay();
                        }
                    }, 300);
                });
        }
    };

    // ==================== ROUTE OBSERVER ====================
    const RouteObserver = {
        lastRoute: null,

        observe() {
            const currentRoute = window.location.pathname;
            if (currentRoute !== this.lastRoute) {
                this.lastRoute = currentRoute;
                this.handleRouteChange(currentRoute);
            }
        },

        handleRouteChange(route) {
            updatePageTitleForRoute();

            if (RouteManager.isSetupPath()) {
                forceSetupLanguageES();
                replaceSetupBranding();
            }
            if (RouteManager.isSettingsPath()) {
                if (window.location.pathname === '/settings/security') {
                    document.body.classList.add('settings-security');
                } else {
                    document.body.classList.remove('settings-security');
                    goToSettingsSecurity();
                }
            }
            if (RouteManager.isRootPath()) {
                hideDockgeHomeBlock();
                ensureDockmeRoot();
                readAgentsFromDockgeDOM();
                MetricsManager.ensureContainer();  
                setTimeout(() => {
                    DataLoader.loadAndDisplay();
                    MetricsManager.start();
                }, 100);
            } else {
                MetricsManager.stop();
            }
            if (RouteManager.isComposeCreatePath()) {
                setTimeout(() => {
                    UIComponents.replaceEndpointsInSelect();
                    this.setupSelectListener();
                }, CONFIG.LOGO_INSERT_DELAY);
            } else if (RouteManager.isComposePath()) {
                UIComponents.insertLogo();
                wrapComposeHeader();
                RecentManager.add();
            }
        },


        setupSelectListener() {
            const select = document.querySelector(".form-select");
            if (select && !select.dataset.listenerAttached) {
                select.dataset.listenerAttached = "true";
                select.addEventListener("change", function () {
                    let texto = this.options[this.selectedIndex].textContent.trim();
                    const titulo = texto.replace(/\(.*?\)\s*/g, "");
                    document.title = titulo;
                    const titleElement = document.querySelector('.fs-4.title');
                    if (titleElement) {
                        titleElement.textContent = titulo;
                    }
                });
            }
        }
    };

    // ==================== DYNAMIC STYLES ====================
    const DynamicStyles = {
        styleElement: null,

        init() {
            this.styleElement = document.createElement('style');
            this.styleElement.id = 'estilo-columna-dinamico';
            document.head.appendChild(this.styleElement);
            GlobalData.load();
        },
        
        updateForRoute(path) {
            const esRaiz = path === '/';
            this.styleElement.textContent = esRaiz
                ? `
                    div.col-xl-3.col-md-4.col-12 {
                        display: block !important;
                        width: 350px !important;
                        flex: 0 0 auto !important;
                    }
                `
                : `
                    div.col-xl-3.col-md-4.col-12 {
                        display: none !important;
                    }
                `;
            if (esRaiz) {
                setTimeout(() => {
                    const input = document.querySelector('.search-input');
                    if (input) input.focus();
                }, CONFIG.FOCUS_DELAY);
            }
        }
    };

    const GlobalData = {
        loaded: false,

        async load() {
            if (this.loaded) return;
            const [updatesData, sourcesData] = await Promise.all([
                API.loadUpdates(),
                API.loadSources()
            ]);
            State.setUpdatesData(updatesData);
            State.setSourcesData(sourcesData);
            if (Array.isArray(updatesData) && updatesData.length > 0) {
                if (Array.isArray(updatesData) && updatesData.length > 0) {
                    const localHost = updatesData.find(h =>
                        h.endpoint?.toLowerCase() === 'actual'
                    ) || updatesData[0];

                    if (localHost?.hostname) {
                        State.setLocalHostname(localHost.hostname);
                    }
                }
            }
            this.loaded = true;
            RouteObserver.handleRouteChange(window.location.pathname);
        }
    };

    // ==================== MUTATION OBSERVER ====================
    const DOMObserver = {
        observer: null,
        processTodo: null,

        init(processFn) {
            this.processTodo = Utils.debounce(processFn, CONFIG.DEBOUNCE_MS);
            this.observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (this.shouldProcess(m)) {
                        this.processTodo();
                        return;
                    }
                }
            });
        },

        shouldProcess(mutation) {
            if (mutation.type === 'childList') {
                return [...mutation.addedNodes, ...mutation.removedNodes].some(n =>
                    n.nodeType === 1 && (
                        n.matches?.('a.item, a.item .badge, a.item .cp-badge, .title span, .fs-4.title') ||
                        n.querySelector?.('a.item, a.item .badge, a.item .cp-badge, .title span, .fs-4.title')
                    )
                );
            } else if (mutation.type === 'characterData') {
                return true;
            } else if (mutation.type === 'attributes') {
                const t = mutation.target;
                return t.matches?.('a.item, a.item .badge, a.item .cp-badge, .title span') || 
                       t.closest?.('a.item');
            }
            return false;
        },
        
        start() {
            const contenedorItems = document.querySelector('a.item')?.parentElement || document.body;
            this.observer.observe(contenedorItems, {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true,
                attributeFilter: ['class', 'style', 'title', 'href']
            });
        }
    };

    // ==================== HELPER: FUNCIONES GENERICAS ====================
    function wrapComposeHeader() {
        const header = document.querySelector('.compose-header');
        if (!header) return;
        const buttons = header.nextElementSibling;
        if (!buttons || !buttons.classList.contains('mb-3')) return;
        if (header.parentElement.classList.contains('compose-sticky-wrapper')) {return;}
        const wrapper = document.createElement('div');
        wrapper.className = 'compose-sticky-wrapper';
        header.parentNode.insertBefore(wrapper, header);
        wrapper.appendChild(header);
        wrapper.appendChild(buttons);
    }
    function isDockmeCompose() {
        const imageBlocks = document.querySelectorAll('.image.mb-2');
        for (const block of imageBlocks) {
            const repoSpan = block.querySelector('.me-1');
            if (!repoSpan) continue;
            const repo = repoSpan.textContent.trim().toLowerCase();
            if (repo === 'dockme:' || repo.endsWith('/dockme:')) {
                return true;
            }
        }
        return false;
    }
    function getStackIconUrl(stackName) {
        if (!stackName) {
            return `${CONFIG.BASE_URL}/icons/no-icon.svg`;
        }
        return `${CONFIG.BASE_URL}/icons/${stackName}.svg?v=${dockmeIconVersion}`;
    }
    function showIconEditorError(editor, message) {
        clearIconEditorMessages(editor);
        const msg = document.createElement('div');
        msg.className = 'dockme-icon-error';
        msg.textContent = message;
        editor.appendChild(msg);
    }
    function setIconStatus(editor, type, ok, message = '') {
        const status = editor.querySelector(`.dockme-icon-status.${type}`);
        if (!status) return;
        status.textContent = ok ? '✅' : '❌';
        status.className = `dockme-icon-status ${type} ${ok ? 'ok' : 'error'}`;
        const oldMsg = status.parentElement.querySelector('.dockme-inline-error');
        if (oldMsg) oldMsg.remove();
        if (!ok && message) {
            const msg = document.createElement('span');
            msg.className = 'dockme-inline-error';
            msg.textContent = message;
            status.parentElement.appendChild(msg);
        }
    }
    function clearIconEditorMessages(editor) {
        const old = editor.querySelector('.dockme-icon-error, .dockme-icon-success');
        if (old) old.remove();
    }
    function insertEditStacksIcon() {
        const headerTop = document.querySelector('.header-top');
        if (!headerTop) return;
        if (headerTop.querySelector('.dockme-edit-stacks-icon')) return;
        const icon = document.createElement('div');
        icon.className = 'dockme-edit-stacks-icon';
        icon.title = 'Editar stacks';
        icon.textContent = '✏️';
        icon.addEventListener('click', () => {
            dockmeEditMode = !dockmeEditMode;
            updateEditModeToggleUI();
        });
        headerTop.prepend(icon);
    } 
    function updateEditModeToggleUI() {
        const icon = document.querySelector('.dockme-edit-stacks-icon');
        if (!icon) return;
        if (dockmeEditMode) {
            icon.classList.add('active');
            icon.title = 'Salir de edición';
            hideDashboardContainer();
            showStackEditorPlaceholder();
        } else {
            icon.classList.remove('active');
            icon.title = 'Editar stacks';
            hideStackEditor();
            showDashboardContainer();
            RecentManager.add();
            DataLoader.loadAndDisplay();
            dockmeIconVersion = Date.now();
            localStorage.setItem('dockmeIconVersion', dockmeIconVersion);
        }
    }
    function hideDashboardContainer() {
        const dashboard = document.querySelector('#dockme-dashboard');
        if (dashboard) dashboard.style.display = 'none';
        MetricsManager.stop();
    }

    function showDashboardContainer() {
        const dashboard = document.querySelector('#dockme-dashboard');
        if (dashboard) dashboard.style.display = '';
        MetricsManager.start();
    }
    function showStackEditorPlaceholder() {
        let editor = document.querySelector('#dockme-stack-editor');
        if (editor) return;
        editor = document.createElement('div');
        editor.id = 'dockme-stack-editor';
        editor.innerHTML = `
            <div class="shadow-box big-padding">
                <h2>Editar stacks</h2>
                <p>Selecciona un stack de la lista izquierda para editar sus datos.</p>
            </div>
        `;
        const dashboard = document.querySelector('#dockme-dashboard');
        if (dashboard) {
            dashboard.before(editor);
        }
    }
    function showStackEditorForStack(stackName) {
        let editor = document.querySelector('#dockme-stack-editor');
        if (!editor) {
            showStackEditorPlaceholder();
            editor = document.querySelector('#dockme-stack-editor');
            if (!editor) return;
        }
        if (stackName.toLowerCase() === 'dockme') {
            editor.innerHTML = `
                <h2>Editar datos del stack</h2>
                <div class="dockme-editor-hint">
                    🔒 <strong>Dockme</strong> es interno y no puede modificarse.
                </div>
                <div class="dockme-editor-hint">
                    👉 Puedes seleccionar otro stack para editar su icono,
                    o salir del modo edición usando el botón ✏️.
                </div>
            `;
            return;
        }
        editor.innerHTML = `
            <h2>Editar datos del stack</h2>
            <div class="dockme-editor-header">
                <div class="dockme-icon-preview">
                    <img src="${getStackIconUrl(stackName)}" alt="Icono de ${stackName}">
                </div>
                <div class="dockme-stack-name">
                    ${Utils.capitalizeFirst(stackName)}
                </div>
            </div>
            <div class="dockme-icon-editor">
                <label class="dockme-icon-label">URL del icono (SVG)</label>
                <div class="dockme-icon-input-row">
                    <input
                        type="text"
                        class="dockme-icon-url-input"
                        placeholder="https://example.com/icon.svg"
                    />
                    <span class="dockme-icon-status url"></span>
                </div>
                <button class="dockme-icon-upload-btn">
                    Subir icono local (SVG)
                </button>
                <span class="dockme-icon-status upload"></span>
                <input
                    type="file"
                    class="dockme-icon-file-input"
                    accept=".svg"
                    style="display:none"
                />
            </div>
            <div class="dockme-editor-hint">
                👉 Solo se admiten iconos en formato <strong>SVG</strong>.
                Si lo tienes en otro formato, puedes convertirlo online en
                <a href="https://www.freeconvert.com/es/png-to-svg" target="_blank" rel="noopener noreferrer">
                    freeconvert.com
                </a>
            </div>
            <div class="dockme-editor-hint">
                👉 Puedes seleccionar otro stack para seguir editando sus datos,
                o salir del modo edición usando el botón ✏️.
            </div>
        `;
//      URL SVG
        const urlInput = editor.querySelector('.dockme-icon-url-input');
        const handleUrlApply = () => {
            const url = urlInput.value.trim();
            if (!url || !url.toLowerCase().endsWith('.svg')) {
                setIconStatus(
                    editor,
                    'url',
                    false,
                    'La URL debe apuntar a un archivo SVG'
                );
                return;
            }
            fetch('/api/stack-icon', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    stack: stackName,
                    type: 'url',
                    url
                })
            })
            .then(res => res.json())
            .then(data => {
                if (!data.success) {
                    setIconStatus(
                        editor,
                        'url',
                        false,
                        data.error || 'Error al actualizar el icono'
                    );
                    return;
                }
                setIconStatus(editor, 'url', true);
                dockmeIconVersion = Date.now();
                localStorage.setItem('dockmeIconVersion', dockmeIconVersion);
                const preview = editor.querySelector('.dockme-icon-preview');
                if (preview) {
                    preview.innerHTML = `
                        <img src="${getStackIconUrl(stackName)}" alt="Icono de ${stackName}">
                    `;
                }
            })
            .catch(() => {
                setIconStatus(
                    editor,
                    'url',
                    false,
                    'Error de conexión'
                );
            });
        };
        // Enter
        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleUrlApply();
            }
        });
        // Paste
        urlInput.addEventListener('paste', () => {
            setTimeout(handleUrlApply, 50);
        });
//      Subida SVG local
        const uploadBtn = editor.querySelector('.dockme-icon-upload-btn');
        const fileInput = editor.querySelector('.dockme-icon-file-input');
        if (uploadBtn && fileInput) {
            uploadBtn.addEventListener('click', () => fileInput.click());
            fileInput.addEventListener('change', () => {
                const file = fileInput.files[0];
                if (!file) return;
                if (
                    file.type !== 'image/svg+xml' &&
                    !file.name.toLowerCase().endsWith('.svg')
                ) {
                    showIconEditorError(editor, 'El archivo debe ser un SVG');
                    fileInput.value = '';
                    return;
                }
                const reader = new FileReader();
                reader.onload = () => {
                    const svgText = reader.result;
                    if (!svgText || !/<svg[\s>]/i.test(svgText)) {
                        setIconStatus(editor,'upload',false,'El archivo no es un SVG válido');
                        return;
                    }
                    uploadStackIconFromSvg(stackName, svgText, editor);
                };
                reader.onerror = () => {
                    showIconEditorError(editor, 'No se pudo leer el archivo');
                };
                reader.readAsText(file);
                fileInput.value = '';
            });
        }
    }
    function hideStackEditor() {
        const editor = document.querySelector('#dockme-stack-editor');
        if (editor) editor.remove();
    }
    function handleEditStackSelection(href) {
        const parts = href.split('/').filter(Boolean);
        const stackName = parts[1];
        if (!stackName) return;
        showStackEditorForStack(stackName);
    }
    function hideDockgeHomeBlock() {
        const h1s = document.querySelectorAll('h1.mb-3');
        for (const h1 of h1s) {
            if (h1.textContent.trim().toLowerCase() === 'inicio') {
                const rootBlock = h1.closest('div');
                if (rootBlock) {
                    rootBlock.style.display = 'none';
                    rootBlock.dataset.dockmeHidden = 'true';
                    return rootBlock;
                }
            }
        }
        return null;
    }
    function ensureDockmeRoot() {
        let root = document.querySelector('#dockme-dashboard');
        if (root) return root;
        const hiddenBlock = hideDockgeHomeBlock();
        if (!hiddenBlock) return null;
        root = document.createElement('div');
        root.id = 'dockme-dashboard';
        root.className = 'row mt-4';
        hiddenBlock.after(root);
        return root;
    }
    function uploadStackIconFromSvg(stackName, svgText, editor) {
        fetch('/api/stack-icon', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                stack: stackName,
                type: 'upload',
                svg: svgText
            })
        })
        .then(res => res.json())
        .then(data => {
            if (!data.success) {
                setIconStatus(
                    editor,
                    'upload',
                    false,
                    data.error || 'Error al guardar el icono'
                );
                return;
            }
            setIconStatus(editor, 'upload', true);
            dockmeIconVersion = Date.now();
            localStorage.setItem('dockmeIconVersion', dockmeIconVersion);
            const preview = editor.querySelector('.dockme-icon-preview');
            if (preview) {
                preview.innerHTML = `
                    <img src="${getStackIconUrl(stackName)}" alt="Icono de ${stackName}">
                `;
            }
        })
        .catch(() => {
            setIconStatus(
                editor,
                'upload',
                false,
                'Error de conexión'
            );
        });
    }

    function forceSetupLanguageES() {
        const select = document.querySelector('#language');
        if (!select) return;
        if (select.dataset.dockmeForced === 'true') return;
        select.value = 'es';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        select.disabled = true;
        const selectedOption = select.querySelector('option[value="es"]');
        if (selectedOption && !selectedOption.textContent.includes('(forzado)')) {
            selectedOption.textContent = 'Español (forzado)';
        }
        select.dataset.dockmeForced = 'true';
    }

    function replaceSetupBranding() {
        if (!RouteManager.isSetupPath()) return;
        if (document.body.dataset.dockmeBrandingApplied === 'true') return;
        const logoObject = document.querySelector('object[data="/icon.svg"]');
        if (logoObject) {
            logoObject.setAttribute('data', '/dockme-icon.svg');
        }
        const titleDivs = Array.from(document.querySelectorAll('div'))
            .filter(div => div.textContent?.trim() === 'Dockge');
        titleDivs.forEach(div => {
            div.textContent = 'Dockme';
        });
        document.body.dataset.dockmeBrandingApplied = 'true';
    }

    function goToSettingsSecurity() {
        if (window.location.pathname === '/settings/security') return;
        const securityLink = document.querySelector('a[href="/settings/security"]');
        if (!securityLink) return;
        securityLink.click();
    }

    function isLoginVisible() {
        return !!document.querySelector('.form-container');
    }

    // ==================== REASIGNACIÓN AUTOMÁTICA ====================
    function reasignarIconos() {
        const items = document.querySelectorAll('a.item');
        // 1. Reasignar iconos
        items.forEach(a => {
            const href = a.getAttribute('href');
            const img = a.querySelector('img.cp-icon');
            if (!href || !img) return;
            if (img.dataset.iconoFallback === 'true') return;
            const match = href.match(/\/compose\/([^/]+)/);
            if (!match) return;
            const stackName = match[1];
            const esperado = getStackIconUrl(stackName);
            if (!img.src.includes(esperado)) {
                img.src = esperado;
            }
        });
        // 2. Reordenar items visibles
        const visibleItems = Array.from(items).filter(item => {
            const style = window.getComputedStyle(item);
            return style.display !== 'none';
        });
        if (visibleItems.length > 0) {
            // Procesar títulos para actualizar cpSortKey y cpGrupo
            visibleItems.forEach(item => {
                const span = item.querySelector('.title span');
                if (!span) return;
                const texto = span.textContent.trim();
                const circulo = item.querySelector('.cp-badge .cp-circle');
                const inactivo = circulo && circulo.dataset.colorEstado === 'gray';
                item.dataset.cpSortKey = texto.toLowerCase();
                item.dataset.cpGrupo = inactivo ? '1' : '0';
            });
            // Verificar si necesita reordenar
            const contenedor = visibleItems[0].parentElement;
            if (!contenedor) return;
            const ordenados = [...visibleItems].sort((a, b) => {
                const ga = a.dataset.cpGrupo || '0';
                const gb = b.dataset.cpGrupo || '0';
                if (ga !== gb) return ga.localeCompare(gb);
                const ka = a.dataset.cpSortKey || '';
                const kb = b.dataset.cpSortKey || '';
                return ka.localeCompare(kb);
            });
            // Solo reordenar si realmente cambia el orden
            const needsReorder = visibleItems.some((el, i) => el !== ordenados[i]);
            if (needsReorder) {
                const frag = document.createDocumentFragment();
                ordenados.forEach(el => frag.appendChild(el));
                contenedor.appendChild(frag);
            }
        }
    }


    // ==================== GESTIÓN DE MÉTRICAS ====================
    const MetricsManager = {
        container: null,
        intervalId: null,
        filterActive: false,
        currentFilter: null,
        formatUptime(seconds) {
            if (!seconds || seconds < 0) return 'Desconectado';
            const days = Math.floor(seconds / 86400);
            const hours = Math.floor((seconds % 86400) / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            if (days > 0) return `Activo ${days} día${days > 1 ? 's' : ''}`;
            if (hours > 0) return `Activo ${hours}h`;
            if (minutes > 0) return `Activo ${minutes} min`;
            return 'Activo 1 min';
        },

        getColorClass(value, type) {
            if (type === 'cpu' || type === 'memory') {
                if (value >= 85) return 'danger';
                if (value >= 70) return 'warning';
                return 'normal';
            }
            if (type === 'temp') {
                if (value >= 80) return 'danger';
                if (value >= 70) return 'warning';
                return 'normal';
            }
            return 'normal';
        },

        createCard(hostname, metrics, status) {
            const card = document.createElement('div');
            card.className = `metric-card${status === 'error' ? ' disconnected' : ''}`;
            card.dataset.hostname = hostname;
            if (status === 'error') {
                card.innerHTML = `
                    <div class="metric-header">
                        <span class="metric-hostname">${hostname}</span>
                        <span class="metric-uptime disconnected">Desconectado</span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-label">No se pudo conectar</span>
                    </div>
                `;
            } else {
                const uptime = this.formatUptime(metrics.uptime_seconds);
                const uptimeClass = status === 'ok' ? 'active' : 'disconnected';
                const version = metrics.version || 'unknown';
                const versionDisplay = version !== 'unknown' 
                    ? `<span class="metric-version">v${version}</span>` 
                    : '';
                const cpuClass = this.getColorClass(metrics.cpu, 'cpu');
                const memClass = this.getColorClass(metrics.memory, 'memory');
                const tempClass = this.getColorClass(metrics.temp_cpu, 'temp');
                card.innerHTML = `
                    <div class="metric-header">
                        <span class="metric-hostname">${hostname}${versionDisplay}</span>
                        <span class="metric-uptime ${uptimeClass}">${uptime}</span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-label">CPU:</span>
                        <span class="metric-value ${cpuClass}">${metrics.cpu}%</span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-label">RAM:</span>
                        <span class="metric-value ${memClass}">${metrics.memory}%</span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-label">Temp:</span>
                        <span class="metric-value ${tempClass}">${metrics.temp_cpu}°C</span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-label">🐋 Contenedores:</span>
                        <span>
                            <span class="metric-docker">${metrics.docker_running}</span>
                            ${
                                metrics.docker_stopped > 0
                                    ? ` / <span class="metric-stopped">${metrics.docker_stopped}</span>`
                                    : ''
                            }
                        </span>
                    </div>
                `;
            }

            // Click para filtrar
            card.addEventListener('click', () => {
                // Click sobre el mismo host → desactivar filtro
                if (this.filterActive && this.currentFilter === hostname) {
                    this.clearHostFilter();
                    return;
                }
                // Click sobre otro host → activar / cambiar filtro
                this.applyHostFilter(hostname);
            });
            return card;
        },

        async fetchAndUpdate() {
            if (!RouteManager.isRootPath()) return;
            if (!this.container) {
                this.ensureContainer();
            }

            const response = await fetch('/api/fetch-all-metrics');
            const data = await response.json();

            if (!this.container) return;

            const cardsContainer = this.container.querySelector('.metrics-container');
            if (!cardsContainer) return;

            cardsContainer.innerHTML = '';

            const connectedEndpoints = AgentsState.agents.map(a => a.endpoint.toLowerCase());

            data.hosts.forEach(host => {
                // Solo mostrar si está conectado en Dockge
                if (!connectedEndpoints.includes(host.endpoint.toLowerCase())) {
                    return;
                }
                
                const card = this.createCard(
                    host.hostname,
                    host.metrics,
                    host.status
                );
                cardsContainer.appendChild(card);
            });
            this.updateManageButton();
            if (this.filterActive && this.currentFilter) {
                this.updateSelectedCard(this.currentFilter);
            }
        },

        updateManageButton() {
            if (!this.container) return;
            
            const header = this.container.querySelector('.dockme-section-header');
            if (!header) return;
            
            const agents = AgentsState.getAgents();
            const detected = getDetectedServers();
            
            const shouldShowBtn = agents.length > 1 || detected.length > 0;
            
            let manageBtn = header.querySelector('.dockme-manage-btn');
            
            if (shouldShowBtn && !manageBtn) {
                manageBtn = document.createElement('button');
                manageBtn.className = 'dockme-manage-btn';
                manageBtn.textContent = '⚙️ Gestionar';
                manageBtn.addEventListener('click', showAgentsManager);
                const title = header.querySelector('.metrics-section-title');
                title.after(manageBtn);
                
            } else if (!shouldShowBtn && manageBtn) {
                manageBtn.remove();
            }
            
            // ALERTA DE DETECTADOS
            let alert = header.querySelector('.dockme-detected-alert-simple');
            if (detected.length > 0 && !alert) {
                alert = document.createElement('h3');
                alert.className = 'dockme-detected-alert-simple';
                alert.innerHTML = `⚠️ Hay ${detected.length} servidor${detected.length > 1 ? 'es' : ''} detectado${detected.length > 1 ? 's' : ''} sin conectar`;
                header.appendChild(alert);
            } else if (detected.length === 0 && alert) {
                alert.remove();
            } else if (detected.length > 0 && alert) {
                alert.innerHTML = `⚠️ Hay ${detected.length} servidor${detected.length > 1 ? 'es' : ''} detectado${detected.length > 1 ? 's' : ''} sin conectar`;
            }
        },

        ensureContainer() {
            const dockmeBlocks = document.querySelector('#dockme-dashboard');
            if (!dockmeBlocks) return;
            this.container = document.querySelector('#metrics-section');
            if (this.container) return;
            this.container = document.createElement('div');
            this.container.id = 'metrics-section';
             const header = document.createElement('div');
            header.className = 'dockme-section-header';
            const title = document.createElement('h2');
            title.className = 'metrics-section-title mb-3';
            title.textContent = '🖥️  Servidores conectados';
            const manageBtn = document.createElement('button');
            manageBtn.className = 'dockme-manage-btn';
            manageBtn.textContent = '⚙️ Gestionar';
            manageBtn.addEventListener('click', showAgentsManager);
            header.appendChild(title);
            this.container.appendChild(header);
            const cardsContainer = document.createElement('div');
            cardsContainer.className = 'metrics-container';
            this.container.style.minHeight = '300px';
            this.container.appendChild(cardsContainer);
            dockmeBlocks.insertBefore(this.container, dockmeBlocks.firstChild);
        },

        applyHostFilter(hostname) {
            this.filterActive = true;
            this.currentFilter = hostname;
            this.updateSelectedCard(hostname);
            const items = document.querySelectorAll('a.item');
            items.forEach(item => {
                const href = item.getAttribute('href') || '';
                const match = href.match(/^\/compose\/([^/]+)(?:\/([^/]+))?/);
                if (!match) {
                    item.style.display = 'none';
                    return;
                }
                const endpoint = match[2] || 'Actual';
                const host = State.updatesDataGlobal?.find(h =>
                    h.endpoint.toLowerCase() === endpoint.toLowerCase()
                );
                const itemHostname = host?.hostname || endpoint;
                item.style.display = itemHostname === hostname ? '' : 'none';
            });
        },

        clearHostFilter() {
            this.filterActive = false;
            this.currentFilter = null;
            this.updateSelectedCard(null);
            const items = document.querySelectorAll('a.item');
            items.forEach(item => {
                item.style.display = '';
            });
            ItemManager.reorder();
        },

        updateSelectedCard(hostname) {
            if (!this.container) return;
            const cards = this.container.querySelectorAll('.metric-card');
            cards.forEach(card => {
                if (card.dataset.hostname === hostname) {
                    card.classList.add('selected');
                } else {
                    card.classList.remove('selected');
                }
            });
        },

        start() {
            if (!RouteManager.isRootPath()) return;
            if (this.intervalId) return;
            this.ensureContainer();
            this.fetchAndUpdate();
            this.intervalId = setInterval(
                () => this.fetchAndUpdate(),
                2000
            );
        },

        stop() {
            if (this.intervalId) {
                clearInterval(this.intervalId);
                this.intervalId = null;
            }
            if (this.container) {
                this.container.remove();
                this.container = null;
            }
        }
    };
    // ==================== ALERTA TEMPORAL EN MÉTRICAS ====================
    function showMetricsAlert(message, duration = 10000) {
        const metricsSection = document.querySelector('#metrics-section');
        if (!metricsSection) return;
        
        const header = metricsSection.querySelector('.dockme-section-header');
        if (!header) return;
        let alert = header.querySelector('.dockme-updating-alert');
        if (!alert) {
            alert = document.createElement('h3');
            alert.className = 'dockme-updating-alert';
            header.appendChild(alert);
        }
        
        alert.textContent = message;
        alert.style.display = 'block';
        setTimeout(() => {
            alert.style.display = 'none';
        }, duration);
    }

    // Cargar CSS personalizado desde custom.css
    function ensureCustomCSS() {
        if (document.querySelector('link[data-dockme-css]')) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `${CONFIG.BASE_URL}/custom.css`;
        link.dataset.dockmeCss = 'true';
        document.head.appendChild(link);
    }

// ==================== GESTIÓN DE AGENTES DOCKGE ====================
const AgentsState = {
    agents: [],
    lastUpdate: null,
    isManaging: false,

    setAgents(agents) {
        this.agents = agents;
        this.lastUpdate = Date.now();
    },

    getAgents() {
        return this.agents;
    }
};

// ==================== LECTURA DE AGENTES DESDE DOM OCULTO ====================
function readAgentsFromDockgeDOM() {
    const agents = [];
    const agentElements = document.querySelectorAll('.first-row .agent');
    if (agentElements.length === 0) {return;}
    agentElements.forEach(el => {
        const badge = el.querySelector('.badge');
        const link = el.querySelector('a');
        const span = el.querySelector('span:not(.badge)');
        const endpoint = link 
            ? link.textContent.trim() 
            : (span ? span.textContent.trim() : 'Actual');
        const isOnline = badge && badge.classList.contains('bg-primary');
        const host = State.updatesDataGlobal?.find(h => 
            h.endpoint.toLowerCase() === endpoint.toLowerCase()
        );
        agents.push({
            endpoint,
            hostname: host?.hostname || endpoint,
            isOnline,
            hasMetrics: false
        });
    });
    AgentsState.setAgents(agents);
}

// ==================== DETECTAR SERVIDORES PENDIENTES ====================
function getDetectedServers() {
    const connectedEndpoints = AgentsState.agents.map(a => a.endpoint.toLowerCase());
    const detected = [];
    if (Array.isArray(State.updatesDataGlobal)) {
        State.updatesDataGlobal.forEach(host => {
            const endpoint = (host.endpoint || '').toLowerCase();
            if (!endpoint || endpoint === 'actual') return;
            if (!connectedEndpoints.includes(endpoint)) {
                detected.push({
                    hostname: host.hostname || endpoint,
                    endpoint: host.endpoint,
                    hasUpdates: Array.isArray(host.updates) && host.updates.length > 0
                });
            }
        });
    }
    return detected;
}
// ==================== CREAR SECCIÓN SERVIDORES DETECTADOS ====================
function createDetectedServersSection() {
    const detected = getDetectedServers();
    if (detected.length === 0) {return '';}
    const rows = detected.map((server, index) => `
        <div class="detected-server-row" data-endpoint="${server.endpoint}">
            <div class="detected-server-header">
                <div class="detected-server-info">
                    <div class="detected-server-hostname">${server.hostname}</div>
                    <div class="detected-server-endpoint"><code>${server.endpoint}</code></div>
                </div>
                <button class="btn-discard-detected" data-endpoint="${server.endpoint}" title="Descartar servidor">
                    ❌
                </button>
            </div>
            
            <div class="detected-server-form">
                <div class="form-field">
                    <label>Usuario:</label>
                    <input type="text" class="agent-username" placeholder="admin" />
                </div>
                <div class="form-field">
                    <label>Contraseña:</label>
                    <input type="password" class="agent-password" placeholder="••••••••" />
                </div>
                <button class="btn btn-primary dockme-connect-agent-btn" data-endpoint="${server.endpoint}">
                    Conectar agente
                </button>
            </div>
            
            <div class="detected-server-error" style="display: none;"></div>
        </div>
    `).join('');
    return `
        <div class="dockme-detected-servers" style="margin-top: 40px;">
            <h3 style="font-size: 20px;">Servidores Dockme detectados</h3>
            <div class="detected-servers-list">
                ${rows}
            </div>
        </div>
    `;
}
// ==================== CREAR TABLA DE AGENTES ====================
function createAgentsTable() {
    const agents = AgentsState.getAgents();
    
    if (agents.length === 0) {
        return `
            <div class="dockme-agents-wrapper">
                <div class="dockme-placeholder-box">
                    <p>No hay agentes configurados</p>
                    <p style="font-size: 0.9em; color: #888; margin-top: 10px;">
                        Los agentes aparecerán aquí cuando se conecten a Dockge
                    </p>
                </div>
            </div>
        `;
    }

   const rows = agents.map(agent => {
        const isLocal = agent.endpoint.toLowerCase() === 'actual';
        return `
            <tr>
                <td class="text-center">${agent.isOnline ? '🟢' : '🔴'}</td>
                <td><strong>${agent.hostname}</strong></td>
                <td><code>${agent.endpoint}</code></td>
                <td class="text-center">
                    ${isLocal 
                        ? '-' 
                        : `<button class="btn-delete-agent" data-endpoint="${agent.endpoint}" title="Eliminar agente">❌</button>`
                    }
                </td>
            </tr>
        `;
    }).join('');
    return `
        <div class="dockme-agents-wrapper">
            <h3 style="font-size: 20px;">Agentes conectados</h3>
            <table class="dockme-agents-table">
                <thead>
                    <tr>
                        <th style="width: 80px;">Estado</th>
                        <th style="width: 200px;">Hostname</th>
                        <th>Endpoint</th>
                        <th style="width: 120px;">Acción</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
        </div>
    `;
}

// ==================== MOSTRAR PANEL DE GESTIÓN ====================
function showAgentsManager() {
    AgentsState.isManaging = true;
    hideDashboardContainer();
    MetricsManager.stop();
    readAgentsFromDockgeDOM();
    const dashboard = document.querySelector('#dockme-dashboard');
    if (!dashboard) {return;}
    dashboard.style.display = '';
    dashboard.innerHTML = `
        <div class="dockme-agents-manager">
            <div class="dockme-section-header" style="margin-bottom: 20px;">
                <h2 class="dashboard-section-title">📡 Gestión de servidores</h2>
                <button class="btn btn-normal dockme-manage-btn dockme-agents-back-btn">
                    ⬅️ Volver
                </button>
            </div>
            ${createAgentsTable()}
            ${createDetectedServersSection()}
        </div>
    `;
    const backBtn = dashboard.querySelector('.dockme-agents-back-btn');
    if (backBtn) {
        backBtn.addEventListener('click', hideAgentsManager);
    }
    const deleteButtons = dashboard.querySelectorAll('.btn-delete-agent');
    deleteButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const endpoint = btn.dataset.endpoint;
            deleteAgent(endpoint);
        });
    });
    const connectButtons = dashboard.querySelectorAll('.dockme-connect-agent-btn');
    connectButtons.forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            
            const row = btn.closest('.detected-server-row');
            const endpoint = btn.dataset.endpoint;
            
            const username = row.querySelector('.agent-username').value.trim();
            const password = row.querySelector('.agent-password').value;
            const errorDiv = row.querySelector('.detected-server-error');
            if (!username || !password) {
                errorDiv.textContent = '⚠️ Por favor, completa usuario y contraseña';
                errorDiv.style.display = 'block';
                return;
            }
            errorDiv.style.display = 'none';
            const url = `http://${endpoint}`;
            btn.disabled = true;
            btn.textContent = 'Conectando...';
            const success = await addAgentToDockge(url, username, password, endpoint, errorDiv);
            if (success) {
                readAgentsFromDockgeDOM();
                showAgentsManager();
            } else {
                btn.disabled = false;
                btn.textContent = 'Conectar agente';
            }
        });
    });
    const discardButtons = dashboard.querySelectorAll('.btn-discard-detected');
    discardButtons.forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            
            const endpoint = btn.dataset.endpoint;
            const row = btn.closest('.detected-server-row');
            const hostname = row.querySelector('.detected-server-hostname').textContent;
            
            if (!confirm(`¿Descartar servidor "${hostname}"?\n\nSi se vuelve a iniciar hacia este central, volverá a aparecer.`)) {
                return;
            }
            
            await discardDetectedServer(endpoint);
        });
    });
}
// ==================== OCULTAR PANEL DE GESTIÓN ====================
function hideAgentsManager() {
    AgentsState.isManaging = false;
    const dashboard = document.querySelector('#dockme-dashboard');
    if (!dashboard) return;
    dashboard.innerHTML = '';
    showDashboardContainer();
    DataLoader.loadAndDisplay();
    MetricsManager.stop();
    MetricsManager.start();
}  

// ==================== ELIMINAR AGENTE ====================
function deleteAgent(endpoint) {
    const agentElements = document.querySelectorAll('.first-row .agent');
    let targetAgent = null;
    for (const el of agentElements) {
        const link = el.querySelector('a');
        const linkText = link ? link.textContent.trim() : '';
        if (link && linkText === endpoint) {
            targetAgent = el;
            break;
        }
    }
    if (!targetAgent) {
        console.error('[Dockme] Agente no encontrado en DOM:', endpoint);
        return;
    }
    const trashBtn = targetAgent.querySelector('.remove-agent');
    if (!trashBtn) {
        alert('No se pudo eliminar');
        console.error('[Dockme] Botón de eliminar no encontrado');
        return;
    }
    const clickEvent = new MouseEvent('click', {
        view: window,
        bubbles: true,
        cancelable: true
    });
    trashBtn.dispatchEvent(clickEvent);
    let attempts = 0;
    const maxAttempts = 10;
    const checkModal = () => {
        attempts++;
        const modal = document.querySelector('.modal.fade.show');
        if (modal) {
            const deleteModalBtn = modal.querySelector('.btn-danger');
            const cancelModalBtn = modal.querySelector('.btn-secondary');
            if (!deleteModalBtn) {
                alert('No se pudo eliminar el agente');
                console.error('[Dockme] Botón de confirmación no encontrado');
                return;
            }
            deleteModalBtn.addEventListener('click', () => {
                setTimeout(() => {
                    let recientes = RecentManager.getAll();
                    recientes = recientes.filter(item => 
                        item.endpoint.toLowerCase() !== endpoint.toLowerCase()
                    );
                    Storage.set(RecentManager.KEY, recientes);
                    if (Array.isArray(State.updatesDataGlobal)) {
                        const updatedData = State.updatesDataGlobal.filter(host => 
                            host.endpoint.toLowerCase() !== endpoint.toLowerCase()
                        );
                        State.setUpdatesData(updatedData);
                        fetch('/api/set-updates-file', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(updatedData)
                        }).then(() => {
                            console.log('[Dockme] Endpoint eliminado del updates.json');
                        }).catch(err => {
                            console.error('[Dockme] Error eliminando endpoint:', err);
                        });
                    }
                    readAgentsFromDockgeDOM();
                    showAgentsManager();
                }, 1000);
            }, { once: true });
        } else if (attempts < maxAttempts) {
            setTimeout(checkModal, 200);
        }
    };
    setTimeout(checkModal, 300);
}
// ==================== AÑADIR AGENTE A DOCKGE ====================
async function addAgentToDockge(url, username, password, endpoint, errorDiv) {
    try {
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'http://' + url;
        }
        const agentBox = Array.from(document.querySelectorAll('.first-row .shadow-box.big-padding'))
            .find(box => box.querySelector('h4')?.textContent.includes('Agentes Dockge'));
        if (!agentBox) {
            throw new Error('No se encontró el panel de agentes');
        }
        let form = agentBox.querySelector('form');
        if (!form) {
            const buttons = document.querySelectorAll('.first-row .btn.btn-normal');
            let addAgentBtn = null;
            buttons.forEach(btn => {
                if (btn.textContent.trim() === 'Añadir Agente') {
                    addAgentBtn = btn;
                }
            });
            if (!addAgentBtn) {
                throw new Error('No se encontró el botón "Añadir Agente"');
            }
            addAgentBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            let attempts = 0;
            while (!form && attempts < 10) {
                await new Promise(resolve => setTimeout(resolve, 200));
                form = agentBox.querySelector('form');
                attempts++;
            }
            if (!form) {
                throw new Error('El formulario no apareció');
            }
        }
        const urlInput = form.querySelector('#url');
        const usernameInput = form.querySelector('#username');
        const passwordInput = form.querySelector('#password');
        if (!urlInput || !usernameInput || !passwordInput) {
            throw new Error('No se encontraron los campos');
        }
        urlInput.value = url;
        urlInput.dispatchEvent(new Event('input', { bubbles: true }));
        urlInput.dispatchEvent(new Event('change', { bubbles: true }));
        usernameInput.value = username;
        usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
        usernameInput.dispatchEvent(new Event('change', { bubbles: true }));
        passwordInput.value = password;
        passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
        passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 500));
        const submitBtn = form.querySelector('button[type="submit"]');
        if (!submitBtn) {
            throw new Error('No se encontró el botón submit');
        }
        submitBtn.click();
        await new Promise(resolve => setTimeout(resolve, 3000));
        const agentElements = document.querySelectorAll('.first-row .agent');
        let found = false;
        for (const el of agentElements) {
            const link = el.querySelector('a');
            if (link && link.textContent.trim() === endpoint) {
                found = true;
                break;
            }
        }
        if (found) {
            return true;
        } else {
            const formStillExists = agentBox.querySelector('form');
            if (formStillExists) {
                throw new Error('Credenciales incorrectas o el agente no está accesible');
            } else {
                throw new Error('No se pudo verificar si el agente se añadió');
            }
        }
        
    } catch (err) {
        console.error('[Dockme] Error:', err);
        errorDiv.textContent = `⚠️ ${err.message}`;
        errorDiv.style.display = 'block';
        return false;
    }
}
// ==================== DESCARTAR SERVIDOR DETECTADO ====================
async function discardDetectedServer(endpoint) {
    try {
        if (!Array.isArray(State.updatesDataGlobal)) {
            throw new Error('No se pudo cargar updates.json');
        }
        
        const updatedData = State.updatesDataGlobal.filter(host =>
            host.endpoint?.toLowerCase() !== endpoint.toLowerCase()
        );
        
        const response = await fetch('/api/set-updates-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updatedData)
        });
        
        if (!response.ok) {
            throw new Error('Error al actualizar updates.json');
        }
        
        State.setUpdatesData(updatedData);
        showAgentsManager();
        
    } catch (err) {
        console.error('[Dockme] Error descartando servidor:', err);
        alert('Error al descartar servidor: ' + err.message);
    }
}

// ==================== INICIALIZACIÓN PRINCIPAL ====================
function init() {
    const titleEl = document.querySelector('.fs-4.title');
    if (titleEl) {
        titleEl.style.visibility = 'hidden';
    }
    ensureCustomCSS();
    DynamicStyles.init();
    DynamicStyles.updateForRoute(State.lastPath);
    setInterval(() => {
        const currentPath = window.location.pathname;
        if (currentPath !== State.lastPath) {
            State.lastPath = currentPath;
            DynamicStyles.updateForRoute(currentPath);
        }
    }, 100);
    document.addEventListener('click', (e) => EventHandlers.handleButtonClick(e), true);

    let initialLoginCheckAttempts = 0;
    const initialLoginCheck = setInterval(() => {
        initialLoginCheckAttempts++;
        if (isLoginVisible()) {
            dockmeWaitingForLogin = true;
            clearInterval(initialLoginCheck);
        }
        if (initialLoginCheckAttempts > 50) {
            clearInterval(initialLoginCheck);
        }
    }, 100);

    const processTodoCompleto = () => {
        const loginVisible = isLoginVisible();
        if (loginVisible && !dockmeLoginWasVisible) {
            dockmeWaitingForLogin = true;
        }
        dockmeLoginWasVisible = loginVisible;
        if (dockmeWaitingForLogin && !loginVisible) {
            dockmeWaitingForLogin = false;
            if (RouteManager.isRootPath()) {
                hideDockgeHomeBlock();
                ensureDockmeRoot();
                DataLoader.loadAndDisplay();
                MetricsManager.stop();
                MetricsManager.start();
            }
        }
        ItemManager.processAll();
        ensureTitleIsCorrect();
        insertEditStacksIcon();
        setTimeout(() => ItemManager.refreshIcons(), CONFIG.ICON_REFRESH_DELAY);
    };

    DOMObserver.init(processTodoCompleto);
    processTodoCompleto();
    DOMObserver.start();

    setInterval(() => ItemManager.refreshIcons(), CONFIG.REORDER_INTERVAL);
    setInterval(() => RouteObserver.observe(), CONFIG.ROUTE_CHECK_INTERVAL);
    setInterval(reasignarIconos, 500);

// CARGAR AGENTES Y MÉTRICAS
if (!dockmeWaitingForLogin && RouteManager.isRootPath()) {
    let attempts = 0;
    const maxAttempts = 20; 
    const checkAndLoadAgents = () => {
        const agentsExist = document.querySelectorAll('.first-row .agent').length > 0;
        attempts++;
        
        if (agentsExist) {
            console.log('[Dockme] DOM de agentes encontrado en intento', attempts);
            readAgentsFromDockgeDOM();
            DataLoader.loadAndDisplay();
            MetricsManager.start();
        } else if (attempts < maxAttempts) {
            console.log('[Dockme] Intento', attempts, '- Esperando DOM de agentes...');
            setTimeout(checkAndLoadAgents, 200);
        } else {
            console.error('[Dockme] No se pudo cargar el DOM de agentes después de', maxAttempts, 'intentos');
            DataLoader.loadAndDisplay();
            MetricsManager.start();
        }
    };
    setTimeout(checkAndLoadAgents, 500);
}
}

    // ==================== START ====================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();