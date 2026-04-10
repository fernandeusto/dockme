(function () {
    'use strict';
    let dockmeWaitingForLogin = false;
    let dockmeLoginWasVisible = false;
    let dockmeEditMode = false;
    let dockmeEditModeFilterBackup = null;
    let dockmeUpdateInProgress = false;
    let dockmeIconVersion = localStorage.getItem('dockmeIconVersion') || Date.now();
    // Polling de icon-version al arrancar — detecta cuando el CDN termina de descargar iconos
    // y refresca stacksConfig + iconos en la UI sin necesidad de F5
    (() => {
        const MAX_ATTEMPTS = 10;
        const INTERVAL_MS  = 3000;
        let attempts = 0;
        const check = () => {
            fetch('/api/icon-version')
                .then(r => r.json())
                .then(data => {
                    if (data.version && data.version > dockmeIconVersion) {
                        dockmeIconVersion = data.version;
                        localStorage.setItem('dockmeIconVersion', dockmeIconVersion);
                        loadStacksConfig().then(() => reasignarIconos());
                    }
                    attempts++;
                    if (attempts < MAX_ATTEMPTS) setTimeout(check, INTERVAL_MS);
                })
                .catch(() => {
                    attempts++;
                    if (attempts < MAX_ATTEMPTS) setTimeout(check, INTERVAL_MS);
                });
        };
        check();
    })();
    let primaryHostLocal = null;
    let stacksConfig = [];
    const loadStacksConfig = () => {
        return fetch('/config/stacks.json')
            .then(r => r.json())
            .then(data => {
                if (Array.isArray(data)) {
                    stacksConfig = data;
                    // Lanzar auto-icon en background para entradas sin icono
                    const sinIcono = [...new Set(
                        data.filter(s => !s.icon).map(s => s.name.toLowerCase())
                    )];
                    sinIcono.forEach(name => {
                        fetch(`/api/auto-icon?name=${encodeURIComponent(name)}`)
                            .then(r => r.json())
                            .then(d => {
                                if (d.success && d.iconFile) {
                                    stacksConfig.filter(s => s.name.toLowerCase() === name)
                                                .forEach(s => { s.icon = d.iconFile; });
                                    dockmeIconVersion = Date.now();
                                    localStorage.setItem('dockmeIconVersion', dockmeIconVersion);
                                    reasignarIconos();
                                }
                            })
                            .catch(() => {});
                    });
                }
            })
            .catch(() => { stacksConfig = []; });
    };
    let linksConfig = [];
    let currentLayoutProfile = 'default';
    let currentDeviceId = localStorage.getItem('dockme-device-id') || 'default';
    const loadLinksConfig = () => {
        return fetch('/api/get-links')
            .then(r => r.json())
            .then(data => {
                if (Array.isArray(data.links)) {
                    linksConfig = data.links
                        .map(cat => {
                            const { order, width, height, ...rest } = cat;
                            return {
                                ...rest,
                                links: (cat.links || []).filter(l => l.url && l.url.trim() !== '')
                            };
                        })
                        .filter(cat => 
                            cat.type === 'favoritos' || 
                            cat.type === 'recientes' ||
                            cat.type === 'metrics' ||
                            (cat.links.length > 0 || (cat.category && cat.category !== 'Nueva categoría'))
                        );
                }
            })
            .catch(() => { linksConfig = []; });
    };

// ==================== GESTIÓN DE LAYOUTS ====================
    const LayoutManager = {
        layouts: {},

        async load() {
            const r = await fetch('/api/get-layouts');
            const data = await r.json();
            this.layouts = data.layouts || {};
            // Buscar perfil por deviceId
            const match = Object.entries(this.layouts).find(([, v]) => v.deviceId === currentDeviceId);
            if (match) {
                currentLayoutProfile = match[0];
            } else {
                currentLayoutProfile = 'default';
            }
            return this.getActiveBlocks();
        },

        getSidebarWidth() {
            const localWidths = JSON.parse(localStorage.getItem(`dockme-widths-${currentDeviceId}`) || '{}');
            return localWidths['sidebar'] ?? (this.layouts[currentLayoutProfile]?.sidebarWidth ?? 350);
        },

        getActiveBlocks() {
            return this.layouts[currentLayoutProfile]?.blocks || [];
        },

        applyToLinksConfig(blocks) {
            if (!blocks.length) return;
            // Leer anchos guardados localmente para este dispositivo
            const localWidths = JSON.parse(localStorage.getItem(`dockme-widths-${currentDeviceId}`) || '{}');
            blocks.forEach(b => {
                const sep = b.key.indexOf(':');
                const keyType = b.key.slice(0, sep);
                const keyVal  = b.key.slice(sep + 1);
                let entry;
                if (keyType === 'type') {
                    entry = linksConfig.find(c => c.type === keyVal);
                } else if (keyType === 'category') {
                    entry = linksConfig.find(c => c.category === keyVal);
                }
                if (entry) {
                    if (b.order != null) entry.order = b.order;
                    const localW = localWidths[b.key];
                    const finalW = localW ?? b.width;
                    if (finalW != null) entry.width = finalW;
                    if (b.height != null) entry.height = localWidths[`${b.key}_h`] ?? b.height;

                    // Aplicar ancho directamente al DOM si el elemento ya existe
                    const el = document.querySelector(`[data-block-key="${b.key}"]`);
                    if (el && finalW) el.style.width = finalW + 'px';
                }
            });
        },

        collectBlocks() {
            const blocksRow = document.querySelector('#dockme-blocks-row');
            if (!blocksRow) return [];
            const localWidths = {};
            const blocks = [...blocksRow.children].map((el, i) => {
                const key = el.dataset.blockKey;
                if (!key) return null;
                const block = { key, order: i };
                if (el.offsetWidth) {
                    block.width = el.offsetWidth;
                    localWidths[key] = el.offsetWidth;
                }
                if (el.offsetHeight) {
                    block.height = el.offsetHeight;
                    localWidths[`${key}_h`] = el.offsetHeight;
                }
                return block;
            }).filter(Boolean);
            // Capturar ancho del sidebar
            const sidebar = document.querySelector('div.col-xl-3.col-md-4.col-12');
            if (sidebar) {
                const sw = sidebar.offsetWidth;
                localWidths['sidebar'] = sw;
                // Guardar también en el perfil del servidor
                if (this.layouts[currentLayoutProfile]) {
                    this.layouts[currentLayoutProfile].sidebarWidth = sw;
                }
            }
            // Guardar anchos localmente
            localStorage.setItem(`dockme-widths-${currentDeviceId}`, JSON.stringify(localWidths));
            return blocks;
        },

        async save() {
            if (currentLayoutProfile === 'default') return;
            const blocks = this.collectBlocks(); // ya guarda en localStorage
            const sidebarWidth = this.layouts[currentLayoutProfile]?.sidebarWidth;
            await fetch('/api/set-layout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    profileName: currentLayoutProfile,
                    deviceId: currentDeviceId,
                    blocks,
                    sidebarWidth
                })
            });
            const r = await fetch('/api/get-layouts');
            const data = await r.json();
            this.layouts = data.layouts || {};
        },

        async rename(oldName, newName) {
            await fetch('/api/rename-layout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ oldName, newName })
            });
            currentLayoutProfile = newName;
            const r = await fetch('/api/get-layouts');
            const data = await r.json();
            this.layouts = data.layouts || {};
        },

        async deleteProfile(name) {
            // Buscar el deviceId del perfil antes de borrarlo
            const profileToDelete = this.layouts[name];
            await fetch(`/api/delete-layout/${encodeURIComponent(name)}`, { method: 'DELETE' });
            // Limpiar localStorage del dispositivo de ese perfil
            if (profileToDelete?.deviceId) {
                localStorage.removeItem(`dockme-widths-${profileToDelete.deviceId}`);
                if (localStorage.getItem('dockme-device-id') === profileToDelete.deviceId) {
                    localStorage.removeItem('dockme-device-id');
                }
            }
            currentLayoutProfile = 'default';
            currentDeviceId = 'default';
            const r = await fetch('/api/get-layouts');
            const data = await r.json();
            this.layouts = data.layouts || {};
            // Mantener modo organizar activo
            const row = document.querySelector('#dockme-blocks-row');
            if (row) row.classList.add('organizing');
            document.querySelector('.dockme-organize-icon')?.classList.add('active');
            document.body.classList.add('dockme-organizing');
        },

async switchTo(profileName) {
            const profile = this.layouts[profileName];
            if (!profile) return;
            currentLayoutProfile = profileName;
            currentDeviceId = profile.deviceId;
            localStorage.setItem('dockme-device-id', currentDeviceId);
            this.applyToLinksConfig(profile.blocks);

            // Actualizar ancho del sidebar inmediatamente (CSS rule + inline style)
            const newSidebarW = this.getSidebarWidth();
            DynamicStyles.updateForRoute(State.lastPath);
            const sidebar = document.querySelector('div.col-xl-3.col-md-4.col-12');
            if (sidebar) sidebar.style.setProperty('width', newSidebarW + 'px', 'important');

            await Promise.all([loadStacksConfig(), loadLinksConfig()]).then(() => {
                this.applyToLinksConfig(profile.blocks);
                DataLoader.loadAndDisplay();
                // Restaurar modo organizar tras recargar
                setTimeout(() => {
                    const row = document.querySelector('#dockme-blocks-row');
                    if (row) {
                        row.classList.add('organizing');
                        row.querySelectorAll('.links-item-card, .stack-card-link[data-fav-nombre]').forEach(el => {
                            el.draggable = true;
                        });
                    }
                    document.querySelector('.dockme-organize-icon')?.classList.add('active');
                    renderProfileBar();
                }, 100);
            });
        }
    };

    // ==================== CONSTANTES ====================
    const CONFIG = {
        DEBOUNCE_MS: 150,
        BASE_URL: window.location.origin,
        ICON_DEFAULT: `${window.location.origin}/system-icons/no-icon.svg`,
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
            // Actualizar primaryHostLocal desde la entrada Actual
            if (Array.isArray(data)) {
                const local = data.find(h => h.endpoint?.toLowerCase() === 'actual');
                if (local?.primaryHost) {
                    primaryHostLocal = local.primaryHost;
                } else if (local && !local.primaryHost && RouteManager.isRootPath()) {
                    // Primera vez — mostrar modal para configurar IP base
                    setTimeout(() => {
                        showPrimaryHostModal('Actual', null, (newVal, onSuccess) => {
                            fetch('/api/set-primary-host', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ primaryHost: newVal, oldHostname: window.location.hostname })
                            })
                            .then(r => r.json())
                            .then(d => {
                                if (d.success) {
                                    primaryHostLocal = newVal;
                                    const span = document.querySelector('.agent-primary-host-value[data-endpoint="Actual"]');
                                    if (span) span.textContent = newVal;
                                    if (local) local.primaryHost = newVal;
                                    loadStacksConfig();
                                    onSuccess();
                                }
                            })
                            .catch(() => {});
                        }, null, false); // fromServidores=false → muestra hint primera vez
                    }, 1500);
                }
            }
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
        document.title = `Dockme - ${hostname}`;
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
                return await this.fetchJSON(`${CONFIG.BASE_URL}/api/sources`);
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
            const endpointOriginal = href.match(/\/compose\/[^/]+\/(.+)$/)?.[1] || 'Actual';
            if (!nombreOriginal) return;
            const iconoUrl = getStackIconUrl(nombreOriginal, endpointOriginal);
            if (!img) {
                img = document.createElement('img');
                img.className = 'cp-icon';
                img.setAttribute('data-icono-app', '1');
                img.style.height = '96px';
                img.style.width = 'auto';
                img.style.marginRight = '8px';
                badge.insertBefore(img, badge.firstChild);
            }
            img.dataset.stackName = nombreOriginal;
            img.dataset.stackEndpoint = endpointOriginal;
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

    // ==================== GESTIÓN DE ITEMS ====================
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
            // Reaplicar filtro activo tras reordenar si no esta en modo edición
            if (!dockmeEditMode && MetricsManager.filterActive && MetricsManager.currentFilter) {
                MetricsManager.applyHostFilter(MetricsManager.currentFilter);
            }
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
    const syncBulkButtons = () => {
        // Si el panel bulk está abierto, no tocar los botones
        if (BulkUpdatePanel.panel) return;
        const allCheckboxes = document.querySelectorAll('.stack-checkbox');
        const visibleCheckboxes = Array.from(allCheckboxes).filter(cb => cb.closest('.stack-card-link')?.style.display !== 'none');
        const btnSelectAll = document.querySelector('.btn-select-all');
        const btnUpdate = document.querySelector('.btn-update-selected');
        const anyChecked = visibleCheckboxes.some(cb => cb.checked);
        const hasCheckboxes = visibleCheckboxes.length > 0;
        if (btnUpdate) btnUpdate.style.display = anyChecked ? '' : 'none';
        if (btnSelectAll) {
            btnSelectAll.style.display = hasCheckboxes ? '' : 'none';
            btnSelectAll.textContent = anyChecked ? 'Deseleccionar todas' : 'Seleccionar todas';
        }
    };

    const syncUpdatesUI = () => {
        const updatesTitle = document.getElementById('updates-title');
        const updatesRow = document.getElementById('updates-row');
        const favTitle = document.getElementById('favoritos-title') || document.getElementById('recientes-title');
        const isFav = !!document.getElementById('favoritos-title');

        const visibleUpdates = Array.from(document.querySelectorAll('.stack-card-horizontal.update'))
            .filter(c => c.closest('.stack-card-link')?.style.display !== 'none').length;

        if (!BulkUpdatePanel.panel) {
            if (updatesTitle) updatesTitle.style.display = visibleUpdates > 0 ? '' : 'none';
            if (updatesRow) updatesRow.style.display = visibleUpdates > 0 ? '' : 'none';
        }

        if (favTitle && !BulkUpdatePanel.panel) {
            const existingControls = favTitle.querySelector('.bulk-update-controls');
            if (visibleUpdates > 0) {
                favTitle.childNodes[0].textContent = isFav ? '⭐ Favoritos y actualizaciones' : '🕘 Recientes y actualizaciones';
                if (!existingControls) StackBlockManager.addUpdateButtons(favTitle);
            } else {
                existingControls?.remove();
                favTitle.textContent = isFav ? '⭐ Favoritos' : '🕘 Recientes';
            }
        }
    };
    
    const StackBlockManager = {
        async create(contenedor, lista, idBase, titulo, status) {
            if (!Array.isArray(lista) || lista.length === 0) {
                this.remove(contenedor, idBase);
                return;
            }

            const isFavOrRecent = idBase.startsWith('favoritos') || idBase.startsWith('recientes');

            // Wrapper box para favoritos/recientes
            let wrapper = document.querySelector(`#${idBase}-wrapper`);
            const targetContainer = isFavOrRecent ? (() => {
                if (!wrapper) {
                    wrapper = document.createElement('div');
                    wrapper.id = `${idBase}-wrapper`;
                    wrapper.className = 'links-cat-box';
                    wrapper.dataset.blockKey = 'type:favoritos';
                    // Añadir al blocksRow
                    const blocksRow = document.querySelector('#dockme-blocks-row') || contenedor;
                    blocksRow.appendChild(wrapper);
                    // Drag & drop
                    setupBlockDrag(wrapper, blocksRow);
                    setupResizeHandle(wrapper, (newWidth) => {
                        saveBlockOrder();
                    });
                }
                return wrapper;
            })() : contenedor;

            let blockTitle = targetContainer.querySelector(`#${idBase}-title`);
            if (!blockTitle) {
                blockTitle = document.createElement('div');
                blockTitle.id = `${idBase}-title`;
                blockTitle.className = isFavOrRecent ? 'links-cat-box-title' : 'dashboard-section-title mb-3';
                blockTitle.textContent = titulo;
                targetContainer.appendChild(blockTitle);
            if (idBase.startsWith('updates')) {
                    if (!BulkUpdatePanel.panel) this.addUpdateButtons(blockTitle);
                }
            }
            let blockRow = targetContainer.querySelector(`#${idBase}-row`);
            if (!blockRow) {
                blockRow = document.createElement('div');
                blockRow.id = `${idBase}-row`;
                blockRow.classList.add('dashboard-section-grid');
                if (idBase.startsWith('recientes') || idBase.startsWith('favoritos')) {
                    blockRow.classList.add('dashboard-grid-recientes');
                } else if (idBase.startsWith('updates')) {
                    blockRow.classList.add('dashboard-grid-updates');
                }
                targetContainer.appendChild(blockRow);
            }
            blockRow.innerHTML = '';
            lista.forEach(item => {
                const card = this.createCard(item, idBase, blockTitle, blockRow);
                blockRow.appendChild(card);
            });
        },

        createCard(item, idBase, blockTitle, blockRow) {
            const { nombre, displayName, endpoint, composePath, fechaFormateada, dockerExtra } = 
                this.extractCardData(item, idBase);

            const iconoUrl = getStackIconUrl(nombre, endpoint || 'Actual');
            const link = document.createElement('a');
            link.href = composePath;
            link.className = 'stack-card-link';

            link.addEventListener('click', e => {
                // Click en icono con URL → abrir servicio
                if (e.target.closest('.stack-logo-left.has-url')) {
                    const stackData = stacksConfig.find(s =>
                        s.name?.toLowerCase() === nombre?.toLowerCase() &&
                        s.endpoint?.toLowerCase() === (endpoint || 'Actual').toLowerCase()
                    );
                    e.preventDefault();
                    if (stackData?.url) window.open(stackData.url, '_blank');
                    return;
                }

                if (e.target.closest('a[target="_blank"]')) return;
                
                // Gestionar checkbox en updates (todas las pantallas)
                if (idBase.startsWith('updates')) {        
                    const checkbox = card.querySelector('.stack-checkbox');
                    if (checkbox && !e.target.closest('.stack-checkbox')) {
                        e.preventDefault();
                        // Si el panel bulk está abierto, no permitir selección
                        if (BulkUpdatePanel.panel) return;
                        
                        const allCheckboxes = document.querySelectorAll('.stack-checkbox:checked');
                        const totalChecked = allCheckboxes.length;
                        
                        // Si hay exactamente 1 marcada Y es esta → navegar
                        if (totalChecked === 1 && checkbox.checked) {
                            window.history.pushState({}, '', link.href);
                            window.dispatchEvent(new Event('popstate'));
                            return;
                        }
                        
                        // Si no → toggle
                        checkbox.checked = !checkbox.checked;
                        syncBulkButtons();
                        return;
                    }
                }
                
                // Comportamiento normal
                e.preventDefault();
                window.history.pushState({}, '', link.href);
                window.dispatchEvent(new Event('popstate'));
            });

            const card = document.createElement('div');
            card.className = 'stack-card-horizontal';

            if (idBase.startsWith('updates')) {
                this.setupUpdateCard(card, item, nombre, displayName, iconoUrl, endpoint, blockTitle, blockRow);
            } else if (idBase.startsWith('recientes')) {
                this.setupRecentCard(card, item, displayName, iconoUrl, fechaFormateada);
            } else if (idBase.startsWith('favoritos')) {
                this.setupFavoriteCard(card, item, displayName, iconoUrl, endpoint);
            }
            if (idBase.startsWith('recientes') || idBase.startsWith('favoritos')) {
                link.dataset.endpoint = endpoint || 'Actual';
            }
            if (idBase.startsWith('favoritos')) {
                link.draggable = false;
                link.dataset.favNombre = nombre;
                link.dataset.favEndpoint = endpoint || 'Actual';

                link.addEventListener('dragstart', (e) => {
                    if (!document.querySelector('#dockme-blocks-row')?.classList.contains('organizing')) {
                        e.preventDefault();
                        return;
                    }
                    e.dataTransfer.setData('text/plain', JSON.stringify({ nombre, endpoint: endpoint || 'Actual' }));
                    link.style.opacity = '0.4';
                });
                link.addEventListener('dragend', () => {
                    link.style.opacity = '';
                });
                link.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    link.style.outline = '2px dashed #4f84c8';
                });
                link.addEventListener('dragleave', () => {
                    link.style.outline = '';
                });
                link.addEventListener('drop', (e) => {
                    e.preventDefault();
                    link.style.outline = '';
                    const draggedData = JSON.parse(e.dataTransfer.getData('text/plain'));
                    if (draggedData.nombre === nombre && draggedData.endpoint === (endpoint || 'Actual')) return;

                    const row = document.getElementById('favoritos-row');
                    if (!row) return;
                    const allLinks = Array.from(row.querySelectorAll('.stack-card-link'));
                    const draggedEl = allLinks.find(l =>
                        l.dataset.favNombre === draggedData.nombre &&
                        l.dataset.favEndpoint === draggedData.endpoint
                    );
                    if (!draggedEl) return;

                    // Reordenar en el DOM
                    const targetIndex = allLinks.indexOf(link);
                    const draggedIndex = allLinks.indexOf(draggedEl);
                    if (draggedIndex < targetIndex) {
                        link.after(draggedEl);
                    } else {
                        link.before(draggedEl);
                    }

                    // Guardar nuevo orden en stacks.json
                    const newOrder = Array.from(row.querySelectorAll('.stack-card-link'));
                    newOrder.forEach((l, i) => {
                        fetch('/api/set-stack', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                name: l.dataset.favNombre,
                                endpoint: l.dataset.favEndpoint,
                                order: i
                            })
                        }).catch(() => {});
                    });
                    // Actualizar stacksConfig en memoria
                    loadStacksConfig();
                });
            }
            link.appendChild(card);
            return link;
        },

        addUpdateButtons(blockTitle) {
            // Evitar duplicados
            if (blockTitle.querySelector('.bulk-update-controls')) return;

            const controls = document.createElement('div');
            controls.className = 'bulk-update-controls';
            controls.innerHTML = `
                <button class="btn btn-normal dockme-manage-btn btn-select-all">Seleccionar todas</button>
                <button class="btn btn-normal dockme-manage-btn btn-update-selected" style="display:none">Actualizar seleccionadas</button>
            `;

            blockTitle.appendChild(controls);

            const btnSelectAll = controls.querySelector('.btn-select-all');
            const btnUpdate = controls.querySelector('.btn-update-selected');

            btnSelectAll.addEventListener('click', () => {
                const checkboxes = Array.from(document.querySelectorAll('.stack-checkbox'))
                    .filter(cb => cb.closest('.stack-card-link')?.style.display !== 'none');
                const anyChecked = checkboxes.some(cb => cb.checked);
                checkboxes.forEach(cb => cb.checked = !anyChecked);
                syncBulkButtons();
            });

            btnUpdate.addEventListener('click', () => {
                const selected = Array.from(document.querySelectorAll('.stack-checkbox:checked'));
                if (selected.length === 0) return;
                const stacks = selected.map(cb => ({
                    name: cb.dataset.stackName,
                    endpoint: cb.dataset.endpoint
                }));
                // Ocultar botones mientras el panel está abierto
                btnSelectAll.style.display = 'none';
                btnUpdate.style.display = 'none';
                BulkUpdatePanel.open(stacks);
            });
        },

        extractCardData(item, idBase) {
            let nombre, displayName, endpoint, dockerExtra = '', fechaFormateada = '';

            if (idBase.startsWith('recientes') || idBase.startsWith('favoritos')) {
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

        setupUpdateCard(card, item, nombre, displayName, iconoUrl, endpoint, blockTitle, blockRow) {
            card.className = 'stack-card-horizontal update';
            const repoUrl = getStackRepo(nombre, endpoint);
            const changelogLine = repoUrl 
                ? (window.innerWidth <= 700 
                    ? `<a href="${repoUrl}/releases" target="_blank" rel="noopener">Changelog</a>`
                    : `Changelog: <a href="${repoUrl}/releases" target="_blank" rel="noopener">${repoUrl}/releases</a>`)
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
                        <div class="stack-selector">
                            <input type="checkbox" class="stack-checkbox" data-stack-name="${nombre}" data-endpoint="${endpoint || 'Actual'}">
                        </div>
                    </div>
                    <div class="stack-hostname">${mostrarHostname ? item.hostname : '&nbsp;'}</div>
                    <div class="stack-docker-image">
                        ${changelogLine || '&nbsp;'}
                    </div>
                </div>
            `;
            const img = card.querySelector('img');
            if (img) {
                img.onerror = () => {
                    if (img.src !== CONFIG.ICON_DEFAULT) {img.src = CONFIG.ICON_DEFAULT;}
                };
            }
            const checkbox = card.querySelector('.stack-checkbox');
            if (checkbox) {
                checkbox.addEventListener('click', (e) => {
                    e.stopPropagation(); // Evitar que navegue al compose al hacer click
                    syncBulkButtons();
                });
            }
        },

        setupRecentCard(card, item, displayName, iconoUrl, fechaFormateada) {
            const mostrarHostname = 
                item.hostname &&
                State.hostnameLocal &&
                item.hostname !== State.hostnameLocal;

            const stackServiceData = stacksConfig.find(s =>
                s.name?.toLowerCase() === item.name?.toLowerCase() &&
                s.endpoint?.toLowerCase() === (item.endpoint || 'Actual').toLowerCase()
            );
            const hasUrl = !!stackServiceData?.url;

            card.innerHTML = `
                <div class="stack-logo-left${hasUrl ? ' has-url' : ''}">
                    ${hasUrl ? `
                    <div class="stack-logo-flip">
                        <div class="logo-front"><img src="${iconoUrl}" alt="${displayName} logo"></div>
                        <div class="logo-back"></div>
                    </div>` : `<img src="${iconoUrl}" alt="${displayName} logo">`}
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

        setupFavoriteCard(card, item, displayName, iconoUrl, endpoint) {
            const mostrarHostname = 
                item.hostname &&
                State.hostnameLocal &&
                item.hostname !== State.hostnameLocal;

            const stackServiceData = stacksConfig.find(s =>
                s.name?.toLowerCase() === item.name?.toLowerCase() &&
                s.endpoint?.toLowerCase() === (item.endpoint || 'Actual').toLowerCase()
            );
            const hasUrl = !!stackServiceData?.url;

            card.innerHTML = `
                <div class="stack-logo-left${hasUrl ? ' has-url' : ''}">
                    ${hasUrl ? `
                    <div class="stack-logo-flip">
                        <div class="logo-front"><img src="${iconoUrl}" alt="${displayName} logo"></div>
                        <div class="logo-back"></div>
                    </div>` : `<img src="${iconoUrl}" alt="${displayName} logo">`}
                </div>
                <div class="stack-info">
                    <div class="stack-name">${displayName}</div>
                    <div class="stack-hostname">${mostrarHostname ? item.hostname : '&nbsp;'}</div>
                    <div class="stack-status">&nbsp;</div>
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
            await loadStacksConfig();
            await loadLinksConfig();
            const layoutBlocks = await LayoutManager.load();
            // Garantizar entradas especiales ANTES de aplicar perfil
            if (!linksConfig.find(b => b.type === 'metrics')) {
                linksConfig.push({ type: 'metrics', links: [] });
            }
            if (!linksConfig.find(b => b.type === 'favoritos')) {
                const recEntry = linksConfig.find(b => b.type === 'recientes');
                if (recEntry) recEntry.type = 'favoritos';
                else linksConfig.push({ type: 'favoritos', links: [] });
            }
            LayoutManager.applyToLinksConfig(layoutBlocks);
            const detected = getDetectedServers();
            const hasDetected = detected.length > 0;
            const updatesData = State.updatesDataGlobal;
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

            // Filtrar Dockme del dashboard (se actualiza desde tarjeta de métricas)
            const updatesForDashboard = allUpdates.filter(item => 
                item.stack.toLowerCase() !== 'dockme'
            );

            // Preparar datos favoritos/recientes
            const endpointToHost = {};
            updatesData.forEach(h => {
                endpointToHost[h.endpoint] = h.hostname;
            });
            const favoritosRaw = stacksConfig.filter(s => s.favorite);

            // Crear/encontrar contenedor compartido de bloques
            let blocksRow = col7.querySelector('#dockme-blocks-row');
            if (!blocksRow) {
                blocksRow = document.createElement('div');
                blocksRow.id = 'dockme-blocks-row';
                col7.appendChild(blocksRow);
            }
            // Limpiar solo los boxes de categorías, no métricas ni favoritos
            [...blocksRow.children].forEach(el => {
                const key = el.dataset.blockKey;
                if (!key || key.startsWith('category:')) el.remove();
            });

            // Orden por defecto si no hay perfil activo
            if (currentLayoutProfile === 'default') {
                const metricsEntry = linksConfig.find(b => b.type === 'metrics');
                const favEntry = linksConfig.find(b => b.type === 'favoritos');
                if (metricsEntry) metricsEntry.order = 0;
                if (favEntry) favEntry.order = 1;
                linksConfig.filter(b => b.category).forEach((b, i) => { b.order = 2 + i; });
            } else {
                // Aplicar orden del perfil primero, luego normalizar los que falten
                const maxProfileOrd = layoutBlocks.reduce((m, b) => Math.max(m, b.order ?? 0), -1);
                let maxOrd = maxProfileOrd;
                linksConfig.forEach(b => {
                    if (b.order == null) b.order = ++maxOrd;
                });
            }

            // Renderizar bloques en orden guardado
            const sortedBlocks = [...linksConfig].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

            for (const block of sortedBlocks) {
                if (block.type === 'metrics') {
                    MetricsManager.ensureContainer();

                } else if (block.type === 'favoritos') {
                    StackBlockManager.remove(col7, 'recientes');
                    StackBlockManager.remove(col7, 'favoritos');

                    const hasUpdates = updatesForDashboard.length > 0;
                    const favoritosOrdenados = favoritosRaw.length > 0
                        ? favoritosRaw
                            .sort((a, b) => {
                                if (a.order === null && b.order === null) return 0;
                                if (a.order === null) return 1;
                                if (b.order === null) return -1;
                                return a.order - b.order;
                            })
                            .map(s => ({
                                name: s.name,
                                endpoint: s.endpoint || 'Actual',
                                hostname: endpointToHost[s.endpoint] || s.endpoint
                            }))
                        : null;
                    const recientesPlano = !favoritosOrdenados
                        ? RecentManager.getAll().map(item => ({
                            ...item,
                            hostname: endpointToHost[item.endpoint] || item.endpoint
                        }))
                        : null;

                    // Determinar lista secundaria y título
                    const secLista = favoritosOrdenados || recientesPlano || [];
                    const secId = favoritosOrdenados ? 'favoritos' : 'recientes';
                    const secTitulo = hasUpdates
                        ? (favoritosOrdenados ? '⭐ Favoritos y actualizaciones' : '🕘 Recientes y actualizaciones')
                        : (favoritosOrdenados ? '⭐ Favoritos' : '🕘 Recientes');

                    // Crear wrapper con título correcto
                    if (hasUpdates || secLista.length > 0) {
                        await StackBlockManager.create(col7, secLista.length > 0 ? secLista : [secLista[0] || {}], secId, secTitulo, '');
                    }

                    // Obtener wrapper ya creado
                    const favWrapper = document.querySelector(`#${secId}-wrapper`);
                    if (favWrapper) {
                        // Limpiar siempre el updates-row previo, haya o no updates ahora
                        favWrapper.querySelector('#updates-row')?.remove();

                        // Actualizar título
                        const titleEl = favWrapper.querySelector(`#${secId}-title`);
                        if (titleEl) {
                            titleEl.textContent = secTitulo;
                            if (hasUpdates && !BulkUpdatePanel.panel) StackBlockManager.addUpdateButtons(titleEl);
                        }

                        // Añadir updates antes del separador si los hay
                        if (hasUpdates) {
                            // (updates-row ya eliminado arriba)

                            // Grid de updates
                            const updatesRow = document.createElement('div');
                            updatesRow.id = 'updates-row';
                            updatesRow.classList.add('dashboard-section-grid', 'dashboard-grid-updates');
                            updatesForDashboard.forEach(item => {
                                const card = StackBlockManager.createCard(item, 'updates', titleEl, updatesRow);
                                updatesRow.appendChild(card);
                            });
                            favWrapper.insertBefore(updatesRow, favWrapper.querySelector(`#${secId}-row`) || null);
                        }
                    }

                } else if (block.category) {
                    if (block.links?.length > 0) {
                        renderCategoryBox(block, blocksRow);
                    }
                }
            }
            // Reordenar elementos del blocksRow según el orden del perfil
            sortedBlocks.forEach(block => {
                const key = block.type ? `type:${block.type}` : `category:${block.category}`;
                const el = blocksRow.querySelector(`[data-block-key="${key}"]`);
                if (el) blocksRow.appendChild(el);
            });
            // Aplicar anchos del perfil al DOM una vez renderizados los boxes
            const activeBlocks = LayoutManager.getActiveBlocks();
            const localWidths = JSON.parse(localStorage.getItem(`dockme-widths-${currentDeviceId}`) || '{}');
            activeBlocks.forEach(b => {
                const finalW = localWidths[b.key] ?? b.width;
                if (!finalW) return;
                const el = document.querySelector(`[data-block-key="${b.key}"]`);
                if (el) el.style.width = finalW + 'px';
            });
            // Reaplicar filtro activo si existe
            if (MetricsManager.filterActive && MetricsManager.currentFilter) {
                MetricsManager.applyHostFilter(MetricsManager.currentFilter);
            }

            // Resetear modo organizar al recargar dashboard
            document.querySelector('#dockme-blocks-row')?.classList.remove('organizing');
            document.querySelector('.dockme-organize-icon')?.classList.remove('active');
        }
    };

    // ── Guarda el orden actual de todos los bloques en #dockme-blocks-row ──────
    function saveBlockOrder() {
        markLayoutDirty();
    }

    // ── Barra de perfiles en modo organizar ───────────────────────────────────
let layoutDirty = false;

    function markLayoutDirty() {
        layoutDirty = true;
        const bar = document.querySelector('#dockme-profile-bar');
        if (bar) renderProfileBar();
    }

    // ── Barra de perfiles en modo organizar ───────────────────────────────────
    function renderProfileBar() {
        const existing = document.querySelector('#dockme-profile-bar');
        if (existing) existing.remove();

        const bar = document.createElement('div');
        bar.id = 'dockme-profile-bar';

        // ── Nombre del perfil activo (solo si no hay cambios pendientes) ──────
        if (currentLayoutProfile !== 'default' && !layoutDirty) {
            const nameLabel = document.createElement('span');
            nameLabel.className = 'profile-bar-name-label';
            nameLabel.textContent = currentLayoutProfile;
            bar.appendChild(nameLabel);
        }

        // ── Input nombre + botón guardar (solo si hay cambios) ────────────────
        if (layoutDirty) {
            const nameInput = document.createElement('input');
            nameInput.className = 'profile-bar-input';
            nameInput.value = currentLayoutProfile === 'default' ? 'Mi layout' : currentLayoutProfile;
            nameInput.placeholder = 'Nombre del perfil';
            nameInput.addEventListener('keydown', async e => {
                if (e.key !== 'Enter') return;
                const name = nameInput.value.trim();
                if (!name) { nameInput.style.borderColor = 'red'; return; }
                nameInput.style.borderColor = '';
                const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
                nameInput.value = capitalized;
                nameInput.select();
            });

            const btnSave = document.createElement('button');
            btnSave.className = 'btn btn-primary';
            btnSave.textContent = '💾 Guardar';
            btnSave.addEventListener('click', async () => {
                const name = nameInput.value.trim();
                if (!name) { nameInput.style.borderColor = 'red'; return; }
                nameInput.style.borderColor = '';
                const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
                if (currentLayoutProfile === 'default') {
                    currentLayoutProfile = capitalized;
                    currentDeviceId = 'device-' + Math.random().toString(36).slice(2, 10);
                    localStorage.setItem('dockme-device-id', currentDeviceId);
                } else if (capitalized !== currentLayoutProfile) {
                    await LayoutManager.rename(currentLayoutProfile, capitalized);
                }
                await LayoutManager.save();
                layoutDirty = false;
                // Cerrar modo organizar
                const row = document.querySelector('#dockme-blocks-row');
                if (row) {
                    row.classList.remove('organizing');
                    row.querySelectorAll('.links-item-card, .stack-card-link[data-fav-nombre]').forEach(el => {
                        el.draggable = false;
                    });
                }
                document.querySelector('.dockme-organize-icon')?.classList.remove('active');
                document.body.classList.remove('dockme-organizing');
                document.querySelector('#dockme-profile-bar')?.remove();
            });

            bar.appendChild(nameInput);
            bar.appendChild(btnSave);
        }
        // ── Botón nuevo perfil ─────────────────────────────────────────────────
        const btnNew = document.createElement('button');
        btnNew.className = 'btn btn-normal';
        btnNew.textContent = '+ Nuevo';
        btnNew.addEventListener('click', async () => {
            // Generar nombre por defecto único
            const baseName = 'Mi layout';
            const existing = Object.keys(LayoutManager.layouts).filter(n => n !== 'default');
            let newName = baseName;
            let idx = 2;
            while (existing.includes(newName)) {
                newName = `${baseName} ${idx++}`;
            }

            // Nuevo deviceId y limpiar localStorage
            currentLayoutProfile = newName;
            currentDeviceId = 'device-' + Math.random().toString(36).slice(2, 10);
            localStorage.setItem('dockme-device-id', currentDeviceId);
            localStorage.removeItem(`dockme-widths-${currentDeviceId}`);

            // Resetear órdenes a default
            const metricsEntry = linksConfig.find(b => b.type === 'metrics');
            const favEntry = linksConfig.find(b => b.type === 'favoritos');
            if (metricsEntry) { metricsEntry.order = 0; delete metricsEntry.width; delete metricsEntry.height; }
            if (favEntry) { favEntry.order = 1; delete favEntry.width; delete favEntry.height; }
            linksConfig.filter(b => b.category).forEach((b, i) => {
                b.order = 2 + i;
                delete b.width;
                delete b.height;
            });

            // Redibujar paneles en orden default sin salir del modo organizar
            layoutDirty = true;
            await DataLoader.loadAndDisplay();

            // Mantener modo organizar activo tras redibujar
            const row = document.querySelector('#dockme-blocks-row');
            if (row) row.classList.add('organizing');
            document.body.classList.add('dockme-organizing');

            // Redibujar barra (mostrará input con newName y botón guardar)
            renderProfileBar();
        });

        // ── Dropdown perfiles (a la derecha del todo) ─────────────────────────
        const btnList = document.createElement('div');
        btnList.className = 'profile-bar-dropdown';

        const btnListToggle = document.createElement('button');
        btnListToggle.className = 'btn btn-normal';
        btnListToggle.textContent = '⋯ Perfiles';

        const dropdown = document.createElement('div');
        dropdown.className = 'profile-bar-dropdown-menu';
        dropdown.style.display = 'none';

        Object.entries(LayoutManager.layouts)
            .filter(([name]) => name !== 'default')
            .forEach(([name]) => {
                const item = document.createElement('div');
                item.className = 'profile-bar-dropdown-item' + (name === currentLayoutProfile ? ' active' : '');
                item.style.cursor = 'pointer';

                const itemName = document.createElement('span');
                itemName.textContent = name;
                itemName.style.flex = '1';

                item.addEventListener('click', async (e) => {
                    if (e.target.closest('.profile-bar-btn-del')) return;
                    dropdown.style.display = 'none';
                    layoutDirty = false;
                    await LayoutManager.switchTo(name);
                    renderProfileBar();
                });

                const btnDel = document.createElement('button');
                btnDel.className = 'btn btn-danger profile-bar-btn-del';
                btnDel.textContent = '🗑';
                btnDel.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (!confirm(`¿Eliminar perfil "${name}"?`)) return;
                    await LayoutManager.deleteProfile(name);
                    layoutDirty = false;
                    localStorage.removeItem('dockme-widths-default');
                    window.location.reload();
                });

                item.appendChild(itemName);
                item.appendChild(btnDel);
                dropdown.appendChild(item);
            });

        let hideTimer = null;
        btnList.addEventListener('mouseenter', () => {
            clearTimeout(hideTimer);
            dropdown.style.display = 'block';
        });
        btnList.addEventListener('mouseleave', () => {
            hideTimer = setTimeout(() => { dropdown.style.display = 'none'; }, 1500);
        });
        dropdown.addEventListener('mouseenter', () => clearTimeout(hideTimer));
        dropdown.addEventListener('mouseleave', () => {
            hideTimer = setTimeout(() => { dropdown.style.display = 'none'; }, 1500);
        });

        btnList.appendChild(btnListToggle);
        btnList.appendChild(dropdown);

        bar.appendChild(btnNew);
        bar.appendChild(btnList);

        const dashboard = document.querySelector('#dockme-dashboard');
        if (dashboard) dashboard.insertBefore(bar, dashboard.firstChild);
    }

    // ── Drag & drop unificado para cualquier bloque del row ───────────────────
    function setupBlockDrag(box, blocksRow) {
        // ── Mouse drag ────────────────────────────────────────────────────────
        box.addEventListener('mousedown', e => {
            if (e.target.closest('.links-cat-box-title')?.closest('.links-cat-box') === box) {
                box.draggable = true;
            }
        });
        box.addEventListener('dragstart', e => {
            if (e.target !== box && !e.target.closest('.links-cat-box-title')) return;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('block-drag', '1');
            box.style.opacity = '0.4';
        });
        box.addEventListener('dragend', () => {
            box.style.opacity = '';
            box.draggable = false;
            saveBlockOrder();
        });
        box.addEventListener('dragover', e => {
            if (!e.dataTransfer.types.includes('block-drag')) return;
            e.preventDefault();
            const dragging = [...blocksRow.children].find(el => el.style.opacity === '0.4');
            if (dragging && dragging !== box) {
                const rect = box.getBoundingClientRect();
                if (e.clientX < rect.left + rect.width / 2) {
                    blocksRow.insertBefore(dragging, box);
                } else {
                    blocksRow.insertBefore(dragging, box.nextSibling);
                }
            }
        });

        // ── Touch drag (iPad / móvil) ─────────────────────────────────────────
        let touchDragging = false;
        let touchClone = null;
        let touchOffsetX = 0;
        let touchOffsetY = 0;
        let touchStartTimer = null;

        box.addEventListener('touchstart', e => {
            if (!document.querySelector('#dockme-blocks-row')?.classList.contains('organizing')) return;
            if (e.target.closest('.links-item-card') || e.target.closest('.stack-card-link')) return;
            const title = e.target.closest('.links-cat-box-title');
            if (!title || title.closest('.links-cat-box') !== box) return;

            const touch = e.touches[0];
            const rect = box.getBoundingClientRect();
            touchOffsetX = touch.clientX - rect.left;
            touchOffsetY = touch.clientY - rect.top;

            // Retrasar inicio para dar tiempo a stopPropagation de hijos
            touchStartTimer = setTimeout(() => {
                touchDragging = true;
                touchClone = box.cloneNode(true);
                touchClone.style.cssText = `
                    position: fixed;
                    pointer-events: none;
                    opacity: 0.7;
                    z-index: 9999;
                    width: ${rect.width}px;
                    left: ${touch.clientX - touchOffsetX}px;
                    top: ${touch.clientY - touchOffsetY}px;
                    margin: 0;
                `;
                document.body.appendChild(touchClone);
                box.style.opacity = '0.3';
            }, 50);
        }, { passive: true });

        box.addEventListener('touchmove', e => {
            if (!touchDragging || !touchClone) return;
            e.preventDefault();
            const touch = e.touches[0];
            touchClone.style.left = (touch.clientX - touchOffsetX) + 'px';
            touchClone.style.top  = (touch.clientY - touchOffsetY) + 'px';

            const els = [...blocksRow.children].filter(el => el !== box);
            for (const target of els) {
                const rect = target.getBoundingClientRect();
                if (touch.clientX >= rect.left && touch.clientX <= rect.right &&
                    touch.clientY >= rect.top  && touch.clientY <= rect.bottom) {
                    if (touch.clientX < rect.left + rect.width / 2) {
                        blocksRow.insertBefore(box, target);
                    } else {
                        blocksRow.insertBefore(box, target.nextSibling);
                    }
                    break;
                }
            }
        }, { passive: false });

        const endTouch = () => {
            clearTimeout(touchStartTimer);
            if (!touchDragging) return;
            touchDragging = false;
            if (touchClone) { touchClone.remove(); touchClone = null; }
            box.style.opacity = '';
            saveBlockOrder();
        };
        box.addEventListener('touchend', endTouch, { passive: true });
        box.addEventListener('touchcancel', endTouch, { passive: true });
    }

// ── Handle de resize custom (esquina superior derecha) ────────────────────
    function setupResizeHandle(box, onResizeEnd) {
        const handle = document.createElement('div');
        handle.className = 'dockme-resize-handle';
        box.appendChild(handle);

        let startX = 0;
        let startW = 0;
        let resizing = false;

        const onMove = (clientX) => {
            if (!resizing) return;
            const diff = clientX - startX;
            const newW = Math.max(96, startW + diff);
            box.style.width = newW + 'px';
        };

        const onEnd = () => {
            if (!resizing) return;
            resizing = false;
            document.removeEventListener('mousemove', mouseMove);
            document.removeEventListener('mouseup', mouseUp);
            document.removeEventListener('touchmove', touchMove);
            document.removeEventListener('touchend', touchEnd);
            if (onResizeEnd) onResizeEnd(box.offsetWidth);
        };

        const mouseMove = e => onMove(e.clientX);
        const mouseUp = () => onEnd();
        const touchMove = e => { e.preventDefault(); e.stopPropagation(); onMove(e.touches[0].clientX); };
        const touchEnd = () => onEnd();

        const startResize = (clientX) => {
            resizing = true;
            startX = clientX;
            startW = box.offsetWidth;
            document.addEventListener('mousemove', mouseMove);
            document.addEventListener('mouseup', mouseUp);
            document.addEventListener('touchmove', touchMove, { passive: false });
            document.addEventListener('touchend', touchEnd);
        };

        handle.addEventListener('mousedown', e => {
            e.preventDefault();
            e.stopPropagation();
            startResize(e.clientX);
        });

        handle.addEventListener('touchstart', e => {
            e.stopPropagation();
            startResize(e.touches[0].clientX);
        }, { passive: true });
    }

    // ── Renderiza un box de categoría de links en el blocksRow ────────────────
    function renderCategoryBox(cat, blocksRow) {
        const catBox = document.createElement('div');
        catBox.className = 'links-cat-box';
        catBox.dataset.blockKey = `category:${cat.category}`;
        if (cat.width) catBox.style.width = cat.width + 'px';

        setupResizeHandle(catBox, (newWidth) => {
            saveBlockOrder();
        });

        const catTitle = document.createElement('div');
        catTitle.className = 'links-cat-box-title';
        catTitle.textContent = cat.category;
        catBox.appendChild(catTitle);

        const linksGrid = document.createElement('div');
        linksGrid.className = 'links-items-grid';
        catBox.appendChild(linksGrid);
        linksGrid.addEventListener('dragover', e => {
            if (!document.querySelector('#dockme-blocks-row')?.classList.contains('organizing')) return;
            e.preventDefault();
            e.stopPropagation();
        });
        linksGrid.addEventListener('drop', e => {
            if (!document.querySelector('#dockme-blocks-row')?.classList.contains('organizing')) return;
            e.preventDefault();
            e.stopPropagation();
        });

        cat.links
            .filter(l => l.url)
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .forEach(link => {
                const iconSrc = link.icon ? `/icons/${link.icon}` : '/system-icons/no-icon.svg';
                const item = document.createElement('div');
                item.className = 'links-item-card';
                item.title = link.name;
                item.dataset.linkName = link.name;
                item.draggable = false;
                item.innerHTML = `
                    <img src="${iconSrc}" alt="${link.name}" onerror="this.src='/system-icons/no-icon.svg'">
                    <span>${link.name}</span>
                `;
                item.addEventListener('click', () => window.open(link.url, '_blank'));

                item.addEventListener('dragstart', e => {
                    if (!document.querySelector('#dockme-blocks-row')?.classList.contains('organizing')) {
                        e.preventDefault();
                        e.stopPropagation();
                        return;
                    }
                    e.stopPropagation();
                    e.dataTransfer.setData('text/plain', link.name);
                    item.style.opacity = '0.4';
                });
                item.addEventListener('touchstart', e => {
                    e.stopPropagation();
                }, { passive: true });
                item.addEventListener('dragend', () => {
                    item.style.opacity = '';
                });
                item.addEventListener('dragover', e => {
                    e.preventDefault();
                    e.stopPropagation();
                    item.style.outline = '2px dashed #4f84c8';
                });
                item.addEventListener('dragleave', () => {
                    item.style.outline = '';
                });
                item.addEventListener('drop', e => {
                    e.preventDefault();
                    e.stopPropagation();
                    item.style.outline = '';
                    const draggedName = e.dataTransfer.getData('text/plain');
                    if (draggedName === link.name) return;

                    const allItems = Array.from(linksGrid.querySelectorAll('.links-item-card'));
                    const draggedEl = allItems.find(el => el.dataset.linkName === draggedName);
                    if (!draggedEl) return;

                    // Reordenar en el DOM
                    const targetIdx = allItems.indexOf(item);
                    const draggedIdx = allItems.indexOf(draggedEl);
                    if (draggedIdx < targetIdx) {
                        item.after(draggedEl);
                    } else {
                        item.before(draggedEl);
                    }

                    // Guardar nuevo orden en linksConfig
                    const newOrder = Array.from(linksGrid.querySelectorAll('.links-item-card'));
                    newOrder.forEach((el, i) => {
                        const l = cat.links.find(x => x.name === el.dataset.linkName);
                        if (l) l.order = i;
                    });
                    fetch('/api/set-links', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ links: linksConfig })
                    }).catch(() => {});
                });

                linksGrid.appendChild(item);
            });

        blocksRow.appendChild(catBox);
        setupBlockDrag(catBox, blocksRow);
    }

    // ==================== UI COMPONENTS ====================
    const UIComponents = {
        fixPortLinks() {
            if (!primaryHostLocal) return;
            document.querySelectorAll('.col-7 a[href]').forEach(a => {
                try {
                    const url = new URL(a.href);
                    // Solo links con puerto explícito que no sean ya primaryHostLocal
                    if (!url.port || url.hostname === primaryHostLocal) return;
                    url.hostname = primaryHostLocal;
                    a.href = url.toString();
                } catch {}
            });
        },

        async insertLogo() {
            const stackName = RouteManager.extractStackName();
            if (!stackName) return;
            if (document.querySelector('.compose-header')) return;
            const h1 = document.querySelector('h1.mb-3');
            if (!h1) return;
            // Capitalizar solo el nodo de texto con el nombre del stack (no los elementos hijo)
            h1.childNodes.forEach(node => {
                if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
                    node.textContent = ' ' + Utils.capitalizeFirst(node.textContent.trim()) + ' ';
                }
            });
            const container = h1.parentElement;
            if (!container) return;
            const endpoint = RouteManager.extractEndpoint();
            const iconUrl = getStackIconUrl(stackName, endpoint);
            const githubUrl = getStackRepo(stackName, endpoint);
            // Si no tiene icono asignado, intentar descargarlo del CDN en background
            const currentEntry = stacksConfig.find(s =>
                s.name.toLowerCase() === stackName.toLowerCase() &&
                s.endpoint.toLowerCase() === endpoint.toLowerCase()
            );
            if (!currentEntry?.icon) {
                fetch(`/api/auto-icon?name=${encodeURIComponent(stackName)}&endpoint=${encodeURIComponent(endpoint)}`)
                    .then(r => r.json())
                    .then(data => {
                        if (data.success && data.iconFile) {
                            if (currentEntry) currentEntry.icon = data.iconFile;
                            dockmeIconVersion = Date.now();
                            localStorage.setItem('dockmeIconVersion', dockmeIconVersion);
                            const logoImg = document.querySelector('.compose-header .cp-icon');
                            if (logoImg) logoImg.src = getStackIconUrl(stackName, endpoint);
                            reasignarIconos();
                        }
                    })
                    .catch(() => {});
            }
            const serviceUrl = stacksConfig.find(s =>
                s.name.toLowerCase() === stackName.toLowerCase() &&
                s.endpoint.toLowerCase() === endpoint.toLowerCase()
            )?.url || '';
            const row = document.createElement('div');
            row.className = 'row mb-4 compose-header align-items-start';
            const colLogo = document.createElement('div');
            colLogo.className = 'col-auto';
            const img = document.createElement('img');
            img.className = 'cp-icon';
            img.src = iconUrl;
            img.onerror = () => {
                if (img.src !== CONFIG.ICON_DEFAULT) {
                    img.src = CONFIG.ICON_DEFAULT;
                }
            };
            if (serviceUrl) {
                const logoWrap = document.createElement('div');
                logoWrap.className = 'stack-logo-left has-url';
                logoWrap.style.width = '96px';
                logoWrap.style.height = '96px';
                const flipDiv = document.createElement('div');
                flipDiv.className = 'stack-logo-flip';
                const front = document.createElement('div');
                front.className = 'logo-front';
                front.appendChild(img);
                const back = document.createElement('div');
                back.className = 'logo-back';
                flipDiv.appendChild(front);
                flipDiv.appendChild(back);
                logoWrap.appendChild(flipDiv);
                logoWrap.addEventListener('click', () => window.open(serviceUrl, '_blank'));
                colLogo.appendChild(logoWrap);
            } else {
                img.style.height = '96px';
                img.style.width = 'auto';
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
            const btnRow = document.createElement('div');
            btnRow.style.display = 'flex';
            btnRow.style.gap = '8px';
            btnRow.style.flexWrap = 'wrap';
            btnRow.style.marginTop = '8px';
            const volverBtn = document.createElement('button');
            volverBtn.className = 'btn btn-normal';
            volverBtn.innerHTML = '⬅️ Volver';
            volverBtn.addEventListener('click', () => {
                document.querySelector('header .fs-4.title')?.click();
            });
            btnRow.appendChild(volverBtn);
            if (githubUrl) {
                const repoBtn = document.createElement('a');
                repoBtn.className = 'btn btn-normal';
                repoBtn.href = githubUrl;
                repoBtn.target = '_blank';
                repoBtn.rel = 'noopener noreferrer';
                repoBtn.style.display = 'inline-flex';
                repoBtn.style.alignItems = 'center';
                repoBtn.style.gap = '6px';
                repoBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>Repositorio GitHub';
                btnRow.appendChild(repoBtn);
            }
            colContent.appendChild(btnRow);
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
    function autoAssignServiceUrl(stackName, endpoint) {
        if (!stackName) return;
        // Solo si no tiene URL asignada
        const entry = stacksConfig.find(s =>
            s.name.toLowerCase() === stackName.toLowerCase() &&
            s.endpoint.toLowerCase() === endpoint.toLowerCase()
        );
        // Leer el puerto directamente del editor CodeMirror (YAML del compose)
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
            .map(l => l.textContent).join('\n');
        const portMatch = lines.match(/^\s*-\s*["']?(?:[\d.]+:)?(\d+):\d+/m);
        const port = portMatch?.[1];
        if (!port) return;

        // Para local usar primaryHostLocal, para remoto usar solo el host del endpoint (sin puerto)
        const isLocal = endpoint.toLowerCase() === 'actual';
        const remoteHost = endpoint.includes(':') ? endpoint.split(':')[0] : endpoint;
        const host = isLocal ? (primaryHostLocal || window.location.hostname) : remoteHost;
        const serviceUrl = `http://${host}:${port}`;

        // Si ya tiene URL con el mismo puerto, no hacer nada
        if (entry?.url === serviceUrl) return;
        // Si ya tiene URL con puerto diferente al del compose actual, actualizar
        // Si no tiene URL, crear

        // Buscar repo en sources.json si no tiene uno asignado
        const repoFromSources = (!entry?.repo) ? (State.sourcesDataGlobal?.[stackName] || '') : '';

        fetch('/api/set-stack', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: stackName, endpoint, url: serviceUrl, ...(repoFromSources ? { repo: repoFromSources, applyRepoToAll: true } : {}) })
        })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                if (entry) {
                    entry.url = serviceUrl;
                    if (repoFromSources) entry.repo = repoFromSources;
                } else {
                    stacksConfig.push({ name: stackName, endpoint, url: serviceUrl, repo: '', favorite: false, order: null });
                    // Stack nuevo — intentar descargar icono del CDN en background
                    fetch(`/api/auto-icon?name=${encodeURIComponent(stackName)}&endpoint=${encodeURIComponent(endpoint)}`)
                        .then(r => r.json())
                        .then(d => {
                            if (d.success && d.iconFile) {
                                const e = stacksConfig.find(s =>
                                    s.name.toLowerCase() === stackName.toLowerCase() &&
                                    s.endpoint.toLowerCase() === endpoint.toLowerCase()
                                );
                                if (e) e.icon = d.iconFile;
                                dockmeIconVersion = Date.now();
                                localStorage.setItem('dockmeIconVersion', dockmeIconVersion);
                            }
                            reasignarIconos();
                        })
                        .catch(() => {});
                }
                // Recargar stacksConfig para garantizar sincronización con el servidor
                loadStacksConfig().then(() => reasignarIconos());
            }
        })
        .catch(() => {});
    }

    const EventHandlers = {
        handleButtonClick(e) {
            // Detectar "Detener y desactivar" en dropdown
            const menuItem = e.target.closest('[role="menuitem"]');
            if (menuItem) {
                const text = menuItem.textContent.trim();
                if (text.includes('Detener y desactivar')) {
                    const parts = RouteManager.extractComposeParts();
                    if (parts) {
                        RecentManager.remove(parts.name, parts.endpoint);
                        if (Array.isArray(State.updatesDataGlobal)) {
                            const hostEntry = State.updatesDataGlobal.find(
                                h => h.endpoint?.toLowerCase() === parts.endpoint.toLowerCase()
                            );
                            if (hostEntry?.hostname) {
                                API.removeUpdate(parts.name, hostEntry.hostname)
                                    .then(() => API.loadUpdates())
                                    .then(updatesData => { State.setUpdatesData(updatesData); });
                            }
                        }
                    }
                }
            }

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

                // Scroll al inicio para ver el terminal (en caso de rocket)
                if (iconName === 'rocket') {
                    const scrollContainer = document.querySelector('.col-12.col-md-8.col-xl-9.mb-3');
                    if (scrollContainer) {
                        scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
                    } else {
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    }
                }

                if (isDockmeCompose()) {
                    e.preventDefault();
                    e.stopPropagation();

                    if (iconName === 'rocket') {
                        const saveBtn = document.querySelector(
                            'button.btn.btn-normal svg[data-icon="floppy-disk"]'
                        )?.closest('button');
                        if (saveBtn) saveBtn.click();
                    }

                    this.updateDockme(endpoint);
                    return;
                }

                if (iconName === 'cloud-arrow-down') {
                    this.handleUpdateButton();
                    const parts = RouteManager.extractComposeParts();
                    if (parts) autoAssignServiceUrl(parts.name, parts.endpoint || 'Actual');
                    return;
                }

                if (iconName === 'rocket') {
                    let parts = RouteManager.extractComposeParts();
                    // Stack nuevo en /compose: leer nombre e endpoint del formulario o del h1
                    if (!parts?.name) {
                        // Primero intentar input#name (stack nunca desplegado)
                        let stackName = document.querySelector('input#name')?.value?.trim();
                        // Si ya fue desplegado (fallido), leer del h1
                        if (!stackName) {
                            const h1 = document.querySelector('h1.mb-3');
                            if (h1) {
                                const clone = h1.cloneNode(true);
                                clone.querySelectorAll('.badge, .agent-name').forEach(el => el.remove());
                                stackName = clone.textContent.trim();
                            }
                        }
                        const selectVal = document.querySelector('select.form-select')?.value || '';
                        const ep = selectVal ? selectVal : 'Actual';
                        if (stackName) parts = { name: stackName, endpoint: ep };
                    }
                    if (parts?.name) autoAssignServiceUrl(parts.name, parts.endpoint || 'Actual');
                    return;
                }
            }

            if (iconName === 'rotate') {
                const parts = RouteManager.extractComposeParts();
                if (parts) autoAssignServiceUrl(parts.name, parts.endpoint || 'Actual');
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
            let parts = RouteManager.extractComposeParts();
            // Si estamos en /compose sin nombre (deploy fallido), leer del h1
            if (!parts?.name) {
                const h1 = document.querySelector('h1.mb-3');
                if (h1) {
                    const clone = h1.cloneNode(true);
                    clone.querySelectorAll('.badge, .agent-name').forEach(el => el.remove());
                    const stackName = clone.textContent.trim();
                    const agentName = h1.querySelector('.agent-name')?.textContent?.replace(/[()]/g, '').trim();
                    const ep = (!agentName || agentName === 'Actual') ? 'Actual' : agentName;
                    if (stackName) parts = { name: stackName, endpoint: ep };
                }
            }
            if (!parts?.name) return;
            // Esperar a que el usuario confirme en el modal de Dockge
            // El botón .btn-danger dentro del modal es la confirmación real
            const waitForConfirm = () => {
                const confirmBtn = document.querySelector('.modal.show .btn-danger');
                if (!confirmBtn) {
                    setTimeout(waitForConfirm, 100);
                    return;
                }
                confirmBtn.addEventListener('click', () => {
                    RecentManager.remove(parts.name, parts.endpoint);
                    if (!Array.isArray(State.updatesDataGlobal)) return;
                    const hostEntry = State.updatesDataGlobal.find(
                        h => h.endpoint?.toLowerCase() === parts.endpoint.toLowerCase()
                    );
                    if (hostEntry?.hostname) {
                        API.removeUpdate(parts.name, hostEntry.hostname)
                            .then(() => API.loadUpdates())
                            .then(updatesData => {
                                State.setUpdatesData(updatesData);
                                setTimeout(() => {
                                    if (RouteManager.isRootPath()) {
                                        Promise.all([loadStacksConfig(), loadLinksConfig()]).then(() => DataLoader.loadAndDisplay());
                                    }
                                }, 300);
                            });
                    }
                    // Limpiar stacks.json
                    const stackIdx = stacksConfig.findIndex(s =>
                        s.name?.toLowerCase() === parts.name?.toLowerCase() &&
                        s.endpoint?.toLowerCase() === (parts.endpoint || 'Actual').toLowerCase()
                    );
                    if (stackIdx >= 0) {
                        stacksConfig.splice(stackIdx, 1);
                        fetch('/api/set-stack', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: parts.name, endpoint: parts.endpoint || 'Actual', _delete: true })
                        }).catch(() => {});
                    }
                }, { once: true });
            };
            setTimeout(waitForConfirm, 100);
        },

        updateDockme(endpoint) {
            if (window.dockmeUpdateInProgress) return;
            window.dockmeUpdateInProgress = true;
            // Eliminar update del updates.json Y de la variable global
            if (Array.isArray(State.updatesDataGlobal)) {
                const hostEntry = State.updatesDataGlobal.find(
                    h => h.endpoint?.toLowerCase() === endpoint.toLowerCase()
                );
                if (hostEntry?.hostname) {
                    // Eliminar de la variable global inmediatamente
                    if (Array.isArray(window.allUpdatesGlobal)) {
                        window.allUpdatesGlobal = window.allUpdatesGlobal.filter(item => {
                            const isSameStack = 
                                (item.stack || '').toLowerCase() === 'dockme' &&
                                (item.endpoint || '').toLowerCase() === endpoint.toLowerCase();
                            return !isSameStack;
                        });
                    }
                    
                    // Y del servidor
                    API.removeUpdate('dockme', hostEntry.hostname)
                        .then(() => API.loadUpdates())
                        .then(updatesData => {
                            State.setUpdatesData(updatesData);
                        });
                }
            }            
            const isLocalDockme = endpoint.toLowerCase() === 'actual';
            const fetchUrl = isLocalDockme ? '/api/update-self' : '/api/update-dockme';
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
                    window.dockmeUpdateInProgress = false;
                    window.history.pushState({}, '', '/');
                    window.dispatchEvent(new Event('popstate'));
                    const serverName = isLocalDockme ? 'este servidor' : 'Dockme remoto';
                    setTimeout(() => {
                        showMetricsAlert(`⏳ Actualizando y reconectando ${serverName}...`, 20000);
                    }, 1000);
                })
                .catch(() => { window.dockmeUpdateInProgress = false; });
        }
    };
    // ==================== MENÚ MÓVIL ====================
    const MobileMenu = {
        ensureToggle() {
            document.querySelector('.mobile-menu-toggle')?.remove();

            if (!RouteManager.isRootPath() || window.innerWidth > 700) return;
            if (document.querySelector('#mobile-sidebar-handle')) return;

            const sidebar = document.querySelector('div.col-xl-3.col-md-4.col-12');
            if (!sidebar) return;

            // Handle fijo en body — no le afecta el overflow del sidebar
            const handle = document.createElement('div');
            handle.id = 'mobile-sidebar-handle';
            handle.innerHTML = '<span style="color:#5fb8ed;font-size:20px;line-height:1;pointer-events:none;">›</span>';
            document.body.appendChild(handle);

            let startX = 0;
            let isOpen = false;

            const setOpen = (open) => {
                isOpen = open;
                sidebar.style.transform = '';
                if (open) {
                    sidebar.classList.add('mobile-open');
                    handle.style.left = (sidebar.offsetWidth || Math.round(window.innerWidth * 0.85)) + 'px';
                    handle.innerHTML = '<span style="color:#5fb8ed;font-size:20px;line-height:1;pointer-events:none;">‹</span>';
                } else {
                    sidebar.classList.remove('mobile-open');
                    handle.style.left = '0';
                    handle.innerHTML = '<span style="color:#5fb8ed;font-size:20px;line-height:1;pointer-events:none;">›</span>';
                }
            };

            const onTouchStart = (e) => {
                e.preventDefault(); // bloquea el gesto de "volver atrás" de iOS
                startX = e.touches[0].clientX;
                sidebar.style.transition = 'none';
            };

            const onTouchMove = (e) => {
                e.preventDefault(); // bloquea scroll de página durante el drag
                const diff = e.touches[0].clientX - startX;
                const sidebarW = sidebar.offsetWidth || Math.round(window.innerWidth * 0.85);
                if (!isOpen && diff > 0) {
                    const offset = Math.min(diff - sidebarW, 0);
                    sidebar.style.transform = `translateX(${offset}px)`;
                } else if (isOpen && diff < 0) {
                    const offset = Math.max(diff, -sidebarW);
                    sidebar.style.transform = `translateX(${offset}px)`;
                }
            };

            const onTouchEnd = (e) => {
                sidebar.style.transition = '';
                handle.style.transition = '';
                const diff = e.changedTouches[0].clientX - startX;
                // Si el dedo apenas se movió → es un tap → toggle
                if (Math.abs(diff) < 10) {
                    setOpen(!isOpen);
                    return;
                }
                const shouldOpen = isOpen ? diff >= -60 : diff >= 60;
                setOpen(shouldOpen);
            };

            handle.addEventListener('touchstart', onTouchStart, { passive: false });
            handle.addEventListener('touchmove', onTouchMove, { passive: false });
            handle.addEventListener('touchend', onTouchEnd, { passive: true });
            // Tap sin arrastre → toggle
            handle.addEventListener('click', () => setOpen(!isOpen));

            // Cerrar al tocar fuera del sidebar abierto
            document.addEventListener('touchstart', (e) => {
                if (isOpen && !sidebar.contains(e.target) && e.target.id !== 'mobile-sidebar-handle') {
                    setOpen(false);
                }
            }, { passive: true });
        },

        close() {
            const lista = document.querySelector('div.col-xl-3.col-md-4.col-12');
            lista?.classList.remove('mobile-open');
            const handle = document.querySelector('#mobile-sidebar-handle');
            if (handle) {
                handle.style.left = '0';
                handle.innerHTML = '<span style="color:#5fb8ed;font-size:20px;line-height:1;pointer-events:none;">›</span>';
            }
        }
    };

    // ==================== BULK UPDATE PANEL ====================
    const BulkUpdatePanel = {
        panel: null,
        stacks: [],
        isActive: false,
        currentIndex: 0,
        timers: {},
        closeButtonShown: false,
        isCancelling: false,
        hasStarted: false,
        isCompleted: false,
        hasErrors: false,
        
        open(stacks) {
            this.isActive = true;
            this.stacks = stacks;
            this.currentIndex = 0;
            this.timers = {};
            this.closeButtonShown = false;
            this.isCompleted = false;
            this.startTime = null;
            this.totalTimer = null;
            this.hasErrors = false;
            this.createPanel();
            this.updateButton();
            this.setupStackListListener();
        },
        
        createPanel() {
            // Si ya existe, no crear otro
            if (this.panel) return;
            
            this.panel = document.createElement('div');
            this.panel.className = 'bulk-update-panel';
            // Agrupar por servidor
            const grouped = {};
            this.stacks.forEach(s => {
                const endpoint = s.endpoint || 'Actual';
                if (!grouped[endpoint]) grouped[endpoint] = [];
                grouped[endpoint].push(s);
            });

            // Generar HTML
            let bodyHTML = '';
            for (const [endpoint, stacks] of Object.entries(grouped)) {
                const host = State.updatesDataGlobal?.find(h => 
                    h.endpoint.toLowerCase() === endpoint.toLowerCase()
                );
                const hostname = host?.hostname || endpoint;
                
                bodyHTML += `<div class="server-group-title">${hostname}</div>`;
                stacks.forEach(s => {
                    const iconUrl = getStackIconUrl(s.name, s.endpoint || 'Actual');
                    const stackData = stacksConfig.find(sc =>
                        sc.name?.toLowerCase() === s.name?.toLowerCase() &&
                        sc.endpoint?.toLowerCase() === (s.endpoint || 'Actual').toLowerCase()
                    );
                    const iconHtml = stackData?.url
                        ? `<span class="stack-update-icon-wrap has-url" onclick="window.open('${stackData.url}', '_blank')">
                            <img src="${iconUrl}" class="stack-update-icon stack-icon-normal" alt="${s.name}">
                            <img src="/system-icons/open-external.svg" class="stack-update-icon stack-icon-hover" alt="abrir">
                           </span>`
                        : `<img src="${iconUrl}" class="stack-update-icon" alt="${s.name}">`;
                    bodyHTML += `
                        <div class="stack-update-row" data-stack="${s.name}" data-endpoint="${s.endpoint}">
                            ${iconHtml}
                            <span class="stack-update-name">${Utils.capitalizeFirst(s.name)}</span>
                            <span class="stack-update-status">⏳ Pendiente</span>
                        </div>
                    `;
                });
            }

            this.panel.innerHTML = `
                <div class="panel-header">
                    <button class="btn-start-updates">🚀 Comenzar Actualizaciones</button>
                    <h3 class="panel-title" style="display: none;">🔄 Actualizando stacks</h3>
                    <button class="btn-close-panel">×</button>
                </div>
                <div class="panel-body">
                    ${bodyHTML}
                </div>
            `;
            
            document.body.appendChild(this.panel);
            
            // Listener cerrar
            this.panel.querySelector('.btn-close-panel').addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                // Si no ha empezado, cerrar directamente
                if (!this.hasStarted) {
                    this.close();
                    return;
                }
                
                // Si ya está cancelando, completado, o inactivo, cerrar
                if (this.isCancelling || this.isCompleted || !this.isActive) {
                    // Parar cualquier verificación pendiente
                    this.panel?.querySelectorAll('[data-checking-services="true"]').forEach(row => {
                        row.dataset.checkingServices = 'false';
                    });
                    this.close();
                    return;
                }
                
                // Si está actualizando, cancelar (o cerrar si solo queda verificando)
                if (this.isActive && this.hasStarted) {
                    const rows = this.panel?.querySelectorAll('[data-stack]');
                    const allUpdated = rows && [...rows].every(r => 
                        r.dataset.checkingServices === 'true' || 
                        r.querySelector('.status-done, .status-error, .status-skipped')
                    );
                    if (allUpdated) {
                        this.panel?.querySelectorAll('[data-checking-services="true"]').forEach(r => {
                            r.dataset.checkingServices = 'false';
                        });
                        this.close();
                    } else {
                        this.cancel();
                        if (window.innerWidth <= 700) {
                            this.panel.classList.remove('open');
                        }
                    }
                }
            });
            // Listener botón comenzar
            const btnStart = this.panel.querySelector('.btn-start-updates');
            btnStart?.addEventListener('click', () => {
                btnStart.style.display = 'none';
                const title = this.panel.querySelector('.panel-title');
                if (title) title.style.display = '';
                this.startTotalTimer();
                this.runUpdates();
            });
            // Swipe derecha para cerrar en móvil
            if (window.innerWidth <= 700) {
                let startX = 0;
                this.panel.addEventListener('touchstart', (e) => {
                    startX = e.touches[0].clientX;
                });
                this.panel.addEventListener('touchmove', (e) => {
                    const currentX = e.touches[0].clientX;
                    const diff = currentX - startX;
                    if (diff > 0) {
                        this.panel.style.transform = `translateX(${diff}px)`;
                    }
                });
                this.panel.addEventListener('touchend', (e) => {
                    const currentX = e.changedTouches[0].clientX;
                    const diff = currentX - startX;
                    if (diff > 100) {
                        // Solo minimizar, no cerrar
                        this.panel.classList.remove('open');
                        this.panel.style.transform = '';
                    } else {
                        this.panel.style.transform = 'translateX(0)';
                    }
                });
            }
            // Abrir en móvil
            setTimeout(() => this.panel.classList.add('open'), 10);
        },
        
        startTotalTimer() {
            this.startTime = Date.now();
            const header = this.panel?.querySelector('.panel-header h3, .panel-header .panel-title');
            
            this.totalTimer = setInterval(() => {
                if (!this.isActive && !this.isCancelling) {
                    clearInterval(this.totalTimer);
                    return;
                }
                
                const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
                const mins = Math.floor(elapsed / 60);
                const secs = elapsed % 60;
                const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
                
                if (header) {
                    if (this.isCancelling) {
                        header.textContent = `⚠️ Cancelando... (${timeStr})`;
                    } else {
                        header.textContent = `🔄 Actualizando stacks (${timeStr})`;
                    }
                }
            }, 1000);
        },

        updateButton() {
            const btn = document.querySelector('.btn-update-selected');
            if (!btn) return;
            if (this.isActive) {
                btn.style.display = 'none';
            }
        },

        async runUpdates() {
            this.hasStarted = true;
            
            for (let i = 0; i < this.stacks.length; i++) {
                this.currentIndex = i;
                const stack = this.stacks[i];
                
                // Actualizar este stack
                await this.updateStack(stack);
                
                // Después de terminar, comprobar si se canceló
                if (this.isCancelling) {
                    const header = this.panel?.querySelector('.panel-header h3, .panel-header .panel-title');
                    if (header) {
                        header.textContent = '⚠️ Proceso cancelado';
                    }
                    this.isActive = false;
                    break;
                }
            }
        },

        async updateStack(stack) {
            return new Promise((resolve) => {
                const row = this.panel.querySelector(`[data-stack="${stack.name}"][data-endpoint="${stack.endpoint}"]`);
                if (!row) return resolve();
                
                const statusEl = row.querySelector('.stack-update-status');
                
                // Iniciar contador
                let seconds = 0;
                statusEl.textContent = '🔄 0s';
                
                this.timers[stack.name] = setInterval(() => {
                    seconds++;
                    statusEl.textContent = `🔄 ${seconds}s`;
                }, 1000);
                
                const socket = document.querySelector("#app")?._vnode?.component?.root?.proxy?.getSocket();
                const endpoint = (stack.endpoint === 'Actual' || !stack.endpoint) ? '' : stack.endpoint;
                socket.emit("agent", endpoint, "updateStack", stack.name, (res) => {
                    clearInterval(this.timers[stack.name]);
                    
                    if (res.ok) {
                        statusEl.textContent = '🔄 Actualizando...';
                        row.dataset.needsPolling = 'true'; 
                        this.removeUpdatedStack(stack); 
                    } else {
                        statusEl.textContent = '❌ Error';
                        this.hasErrors = true;
                        this.panel?.classList.add('error');
                    }
                    resolve();
                });
            });
        },

        setupStackListListener() {
            const socket = document.querySelector("#app")?._vnode?.component?.root?.proxy?.getSocket();
            
            // Escuchar actualizaciones de stackList
                socket.on("agent", (event, data) => {
                    if (event === "stackList" && data.stackList && (this.isActive || this.isCancelling)) {
                    // Actualizar status de nuestros stacks
                    this.stacks.forEach(stack => {
                        const stackData = data.stackList[stack.name];
                        if (stackData && stackData.endpoint === (stack.endpoint === 'Actual' ? '' : stack.endpoint)) {
                            const row = this.panel?.querySelector(`[data-stack="${stack.name}"][data-endpoint="${stack.endpoint}"]`);
                            if (!row) return;
                            
                            const statusEl = row.querySelector('.stack-update-status');
                            const needsPolling = row.dataset.needsPolling === 'true';
                            
                            if (needsPolling) {
                                if (stackData.status === 3) { // RUNNING
                                    statusEl.textContent = '🔄 Verificando...';
                                    row.dataset.needsPolling = 'false';
                                    row.dataset.checkingServices = 'true';
                                    this.checkServices(stack, row);
                                } else if (stackData.status === 4) { // EXITED
                                    statusEl.textContent = '⚠️ Exited';
                                    row.removeAttribute('data-needs-polling');
                                    this.hasErrors = true;
                                    this.panel?.classList.add('error');    
                                }
                            }
                        }
                    });
                    
                    // Verificar si todos terminaron
                    this.checkIfAllDone();
                }
            });
        },

        checkServices(stack, row) {
            const socket = document.querySelector("#app")?._vnode?.component?.root?.proxy?.getSocket();
            const endpoint = (stack.endpoint === 'Actual' || !stack.endpoint) ? '' : stack.endpoint;
            const statusEl = row.querySelector('.stack-update-status');
            
            const checkInterval = setInterval(() => {
                // Si ya no está en checking, detener
                if (row.dataset.checkingServices !== 'true') {
                    clearInterval(checkInterval);
                    return;
                }
                
                socket.emit("agent", endpoint, "serviceStatusList", stack.name, (res) => {
                    if (!res.ok || !res.serviceStatusList) {
                        clearInterval(checkInterval);
                        statusEl.textContent = '❌ Error';
                        row.removeAttribute('data-checking-services');
                        this.hasErrors = true;
                        this.panel?.classList.add('error');
                        this.checkIfAllDone();
                        return;
                    }
                    
                    const services = Object.entries(res.serviceStatusList);
                    const total = services.length;
                    const healthy = services.filter(([name, status]) => 
                        status.state === 'running' || status.state === 'healthy'
                    ).length;
                    const unhealthy = services.filter(([name, status]) => 
                        status.state === 'unhealthy' || status.state === 'exited'
                    ).length;
                    
                    // Todos OK
                    if (healthy === total) {
                        clearInterval(checkInterval);
                        statusEl.textContent = `✅ Running (${healthy}/${total})`;
                        row.removeAttribute('data-checking-services');
                        this.checkIfAllDone();
                    }
                    // Alguno unhealthy
                    else if (unhealthy > 0) {
                        clearInterval(checkInterval);
                        statusEl.textContent = `⚠️ Running (${healthy}/${total})`;
                        row.removeAttribute('data-checking-services');
                        this.hasErrors = true;
                        this.panel?.classList.add('error');
                        this.checkIfAllDone();
                    }
                    // Aún iniciando
                    else {
                        statusEl.textContent = `🔄 Iniciando (${healthy}/${total})`;
                    }
                });
            }, 3000); // Cada 3 segundos
        },

        removeUpdatedStack(stack) {
            // 1. Desmarcar checkbox
            const checkbox = document.querySelector(
                `.stack-checkbox[data-stack-name="${stack.name}"][data-endpoint="${stack.endpoint}"]`
            );
            if (checkbox) checkbox.checked = false;
            
            // 2. Eliminar tarjeta del DOM
            const card = checkbox?.closest('.stack-card-link');
            if (card) {
                card.style.opacity = '0';
                setTimeout(() => { card.remove(); if (!BulkUpdatePanel.panel) syncUpdatesUI(); }, 300);
            }
            
            // 3. Buscar hostname del endpoint
            const endpoint = stack.endpoint === 'Actual' ? 'Actual' : stack.endpoint;
            const hostEntry = State.updatesDataGlobal?.find(
                h => h.endpoint?.toLowerCase() === endpoint.toLowerCase()
            );
            
            if (hostEntry?.hostname) {
                // 4. Usar API existente para eliminar update
                API.removeUpdate(stack.name, hostEntry.hostname)
                    .then(() => API.loadUpdates())
                    .then(updatesData => {
                        State.setUpdatesData(updatesData);
                    });
            }
        },
        
        checkIfAllDone() {
            // Contar solo los que YA empezaron a actualizar (tienen o tuvieron data-needs-polling)
            const startedRows = this.panel?.querySelectorAll('.stack-update-row .stack-update-status');
            let allDone = true;
            
            startedRows?.forEach(statusEl => {
                const text = statusEl.textContent;
                // Si aún está actualizando o iniciando
                if (text.includes('🔄') || text.includes('⏳')) {
                    allDone = false;
                }
            });
            
            if (allDone && startedRows && startedRows.length > 0) {
                this.isCompleted = true;
                this.isActive = false;
                clearInterval(this.totalTimer);
                // Cambiar título a completado
                const header = this.panel?.querySelector('.panel-header h3, .panel-header .panel-title');
                if (header) {
                    header.textContent = '✅ Actualizaciones completadas';
                        // const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
                        // const mins = Math.floor(elapsed / 60);
                        // const secs = elapsed % 60;
                        // header.textContent = `✅ Completado (${mins}:${secs.toString().padStart(2, '0')})`;
                }
                if (!this.hasErrors && !this.isCancelling) {
                    this.panel?.classList.add('success');
                }
                // En móvil, expandir panel para que se vea
                if (window.innerWidth <= 700) {
                    this.panel?.classList.add('open');
                }
            }
        },

        cancel() {
            this.isCancelling = true;
            
            // Cambiar título
            const header = this.panel?.querySelector('.panel-header h3, .panel-header .panel-title');
            if (header) {
                header.textContent = '⚠️ Cancelando actualizaciones...';
            }
            
            // Marcar pendientes como cancelados
            const rows = this.panel?.querySelectorAll('.stack-update-row');
            rows?.forEach(row => {
                const statusEl = row.querySelector('.stack-update-status');
                const text = statusEl.textContent;
                
                // Si está pendiente (no ha empezado)
                if (text.includes('⏳ Pendiente')) {
                    statusEl.textContent = '⏭️ Cancelado';
                    this.panel?.classList.add('error');
                }
            });
        },

        close() {
            if (!this.panel) return;
            this.isActive = false;
            
            // Desmarcar checkboxes de stacks cancelados o pendientes
            this.stacks.forEach(stack => {
                const checkbox = document.querySelector(
                    `.stack-checkbox[data-stack-name="${stack.name}"][data-endpoint="${stack.endpoint}"]`
                );
                if (checkbox) checkbox.checked = false;
            });
            
            // Resetear botón "Seleccionar todas"
            const btnSelectAll = document.querySelector('.btn-select-all');
            if (btnSelectAll) {
                btnSelectAll.textContent = 'Seleccionar todas';
                const btnUpdate = document.querySelector('.btn-update-selected');
                if (btnUpdate) btnUpdate.style.display = 'none';
            }
            
            this.panel.classList.remove('open');
            setTimeout(() => {
                this.panel?.remove();
                this.panel = null;
                this.isCancelling = false;
                this.hasStarted = false;
                this.isCompleted = false;
                this.updateButton();
                syncUpdatesUI();
                syncBulkButtons();
            }, 300);
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
            MobileMenu.close();
            MobileMenu.ensureToggle();

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
                const tryLoadDashboard = (attemptsLeft) => {
                    Promise.all([loadStacksConfig(), loadLinksConfig()]).then(() => {
                        MetricsManager.ensureContainer();
                        const dashboard = ensureDockmeRoot();
                        if (dashboard) {
                            DataLoader.loadAndDisplay();
                            MetricsManager.start();
                        } else if (attemptsLeft > 0) {
                            setTimeout(() => tryLoadDashboard(attemptsLeft - 1), 200);
                        }
                    });
                };
                setTimeout(() => tryLoadDashboard(10), 100);
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
                UIComponents.fixPortLinks();
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
                    document.title = `Dockme - ${titulo}`;
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
            const esMobil = window.innerWidth <= 700;

            // Handle móvil: visible solo en la raíz
            const mobileHandle = document.querySelector('#mobile-sidebar-handle');
            if (mobileHandle) mobileHandle.style.display = esRaiz ? '' : 'none';

            this.styleElement.textContent = esRaiz
                ? (esMobil ? '' :
                    `div.col-xl-3.col-md-4.col-12 {
                        display: block !important;
                        width: ${LayoutManager.getSidebarWidth()}px !important;
                        flex: 0 0 auto !important;
                    }`)
                : `div.col-xl-3.col-md-4.col-12 { display: none !important; }`;
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
    function getStackRepo(stackName, endpoint) {
        if (!stackName) return '';
        const entry = endpoint
            ? stacksConfig.find(s =>
                s.name.toLowerCase() === stackName.toLowerCase() &&
                s.endpoint.toLowerCase() === endpoint.toLowerCase()
              )
            : stacksConfig.find(s => s.name.toLowerCase() === stackName.toLowerCase());
        return entry?.repo || State.sourcesDataGlobal?.[stackName] || '';
    }

    function getStackIconUrl(stackName, endpoint) {
        if (!stackName) {
            return `${CONFIG.BASE_URL}/system-icons/no-icon.svg`;
        }
        if (stackName.toLowerCase() === 'dockme') {
            return `${CONFIG.BASE_URL}/system-icons/dockme.svg`;
        }
        const entry = endpoint
            ? stacksConfig.find(s =>
                s.name.toLowerCase() === stackName.toLowerCase() &&
                s.endpoint.toLowerCase() === endpoint.toLowerCase()
              )
            : stacksConfig.find(s => s.name.toLowerCase() === stackName.toLowerCase());
        const iconFile = entry?.icon || `${stackName}.svg`;
        return `${CONFIG.BASE_URL}/icons/${iconFile}?v=${dockmeIconVersion}`;
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
    function setupSidebarResizeHandle() {
        if (document.querySelector('#dockme-sidebar-handle')) return;
        const sidebar = document.querySelector('div.col-xl-3.col-md-4.col-12');
        const sidebarW = sidebar.offsetWidth;
        if (!sidebar) return;

        sidebar.style.position = 'relative';
        const handle = document.createElement('div');
        handle.id = 'dockme-sidebar-handle';
        handle.className = 'dockme-sidebar-handle-el';
        handle.style.cssText = ''; // limpiar — el CSS del #mobile-sidebar-handle lo gestiona
        handle.innerHTML = '<span style="color:#5fb8ed;font-size:18px;line-height:1">›</span>';
        sidebar.appendChild(handle);

        let startX = 0;
        let startW = 0;

        const onMove = (clientX) => {
            const diff = clientX - startX;
            const newW = Math.max(200, Math.min(600, startW + diff));
            sidebar.style.setProperty('width', newW + 'px', 'important');
            const styleEl = document.querySelector('#estilo-columna-dinamico');
            if (styleEl) {
                styleEl.textContent = styleEl.textContent.replace(/width:\s*\d+px\s*!important/, `width: ${newW}px !important`);
            }
        };

        const onEnd = () => {
            document.removeEventListener('mousemove', mouseMove);
            document.removeEventListener('mouseup', mouseUp);
            document.removeEventListener('touchmove', touchMove);
            document.removeEventListener('touchend', touchEnd);
            saveBlockOrder();
        };

        const mouseMove = e => onMove(e.clientX);
        const mouseUp = () => onEnd();
        const touchMove = e => { e.preventDefault(); onMove(e.touches[0].clientX); };
        const touchEnd = () => onEnd();

        handle.addEventListener('mousedown', e => {
            if (!document.body.classList.contains('dockme-organizing')) return;
            e.preventDefault();
            startX = e.clientX;
            startW = sidebar.offsetWidth;
            document.addEventListener('mousemove', mouseMove);
            document.addEventListener('mouseup', mouseUp);
        });

        handle.addEventListener('touchstart', e => {
            if (!document.body.classList.contains('dockme-organizing')) return;
            e.preventDefault();
            e.stopPropagation();
            startX = e.touches[0].clientX;
            startW = sidebar.offsetWidth;
            document.addEventListener('touchmove', touchMove, { passive: false });
            document.addEventListener('touchend', touchEnd);
        }, { passive: false });
    }
    function insertEditStacksIcon() {
        const headerTop = document.querySelector('.header-top');
        if (!headerTop) return;
        if (document.querySelector('.dockme-header-icons')) return;

        const wrapper = document.createElement('div');
        wrapper.className = 'dockme-header-icons';

        // Icono lápiz — edición de stacks
        const editIcon = document.createElement('div');
        editIcon.className = 'dockme-edit-stacks-icon';
        editIcon.title = 'Configuración Dockme';
        editIcon.innerHTML = '<img src="/system-icons/dockme-edit.svg" style="width:24px;height:24px;vertical-align:middle;">';
        editIcon.addEventListener('click', () => {
            // Cerrar modo organizar si está activo
            const row = document.querySelector('#dockme-blocks-row');
            if (row?.classList.contains('organizing')) {
                row.classList.remove('organizing');
                document.body.classList.remove('dockme-organizing');
                organizeIcon.classList.remove('active');
                row.querySelectorAll('.links-item-card, .stack-card-link[data-fav-nombre]').forEach(el => { el.draggable = false; });
                document.querySelector('#dockme-profile-bar')?.remove();
                layoutDirty = false;
            }
            if (!RouteManager.isRootPath()) {
                window.history.pushState({}, '', '/');
                window.dispatchEvent(new Event('popstate'));
                setTimeout(() => {
                    dockmeEditMode = true;
                    updateEditModeToggleUI();
                }, 400);
            } else {
                dockmeEditMode = !dockmeEditMode;
                updateEditModeToggleUI();
            }
        });

        // Icono reordenar — organizar dashboard
        const organizeIcon = document.createElement('div');
        organizeIcon.className = 'dockme-organize-icon';
        organizeIcon.title = 'Organizar dashboard';
        organizeIcon.innerHTML = '<img src="/system-icons/reordenar.svg" style="width:24px;height:24px;vertical-align:middle;">';
        organizeIcon.addEventListener('click', () => {
            // Cerrar modo edición si está activo y activar organizar
            if (dockmeEditMode) {
                dockmeEditMode = false;
                updateEditModeToggleUI();
                // Activar modo organizar tras cerrar edición
                setTimeout(() => {
                    const row = document.querySelector('#dockme-blocks-row');
                    if (!row) return;
                    row.classList.add('organizing');
                    document.body.classList.add('dockme-organizing');
                    organizeIcon.classList.add('active');
                    row.querySelectorAll('.links-item-card, .stack-card-link[data-fav-nombre]').forEach(el => { el.draggable = true; });
                    layoutDirty = false;
                    renderProfileBar();
                }, 300);
                return;
            }
            if (!RouteManager.isRootPath()) {
                window.history.pushState({}, '', '/');
                window.dispatchEvent(new Event('popstate'));
                setTimeout(() => {
                    const row = document.querySelector('#dockme-blocks-row');
                    if (row) {
                        row.classList.add('organizing');
                        organizeIcon.classList.add('active');
                        row.querySelectorAll('.links-item-card, .stack-card-link[data-fav-nombre]').forEach(el => {
                            el.draggable = true;
                        });
                    }
                }, 600);
            } else {
                const row = document.querySelector('#dockme-blocks-row');
                if (!row) return;
                const isOrganizing = row.classList.toggle('organizing');
                document.body.classList.toggle('dockme-organizing', isOrganizing);
                organizeIcon.classList.toggle('active', isOrganizing);
                row.querySelectorAll('.links-item-card, .stack-card-link[data-fav-nombre]').forEach(el => {
                    el.draggable = isOrganizing;
                });
                if (isOrganizing) {
                    layoutDirty = false;
                    renderProfileBar();
                } else {
                    document.querySelector('#dockme-profile-bar')?.remove();
                    if (layoutDirty) {
                        // Recargar perfil guardado descartando cambios
                        layoutDirty = false;
                        const blocks = LayoutManager.getActiveBlocks();
                        LayoutManager.applyToLinksConfig(blocks);
                        DataLoader.loadAndDisplay();
                    }
                }
            }
        });

        // Botón Novedades en header
        const mostrarNovedades = (currentVersion, udata) => {
            const hosts = Array.isArray(udata) ? udata : [];
            const localHost = hosts.find(h => (h.endpoint || '').toLowerCase() === 'actual');
            if (!currentVersion || !localHost) return;
            if (localHost.release === currentVersion) return;
            const novedadesIcon = document.createElement('button');
            novedadesIcon.className = 'btn-novedades-dockme';
            novedadesIcon.title = `Novedades v${currentVersion}`;
            novedadesIcon.innerHTML = '📣 Novedades';
            novedadesIcon.addEventListener('click', async () => {
                window.open('https://github.com/fernandeusto/dockme/releases', '_blank');
                localHost.release = currentVersion;
                novedadesIcon.remove();
                await fetch('/api/set-release-version', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ version: currentVersion })
                });
            });
            if (window.innerWidth > 700) wrapper.prepend(novedadesIcon);
        };
        Promise.all([
            fetch('/api/get-version').then(r => r.json()),
            fetch('/config/updates.json').then(r => r.json())
        ]).then(([vdata, udata]) => {
            const hosts = Array.isArray(udata) ? udata : [];
            const localHost = hosts.find(h => (h.endpoint || '').toLowerCase() === 'actual');
            mostrarNovedades(vdata.version, udata);
        }).catch(err => console.error('[Novedades] error:', err));

        wrapper.appendChild(editIcon);
        wrapper.appendChild(organizeIcon);
        const isMobile = window.innerWidth <= 700;

        if (isMobile) {
            const insertAfterToggle = () => {
                const mobileToggle = document.querySelector('.mobile-menu-toggle');
                if (mobileToggle) {
                    mobileToggle.after(wrapper);
                } else {
                    setTimeout(insertAfterToggle, 100);
                }
            };
            insertAfterToggle();
        } else {
            const navPills = document.querySelector('header .nav.nav-pills');
            const lastLi = navPills?.querySelector('li:last-child');
            if (lastLi) {
                const wrapperLi = document.createElement('li');
                wrapperLi.className = 'nav-item me-2';
                wrapperLi.appendChild(wrapper);
                navPills.insertBefore(wrapperLi, lastLi);
            } else {
                headerTop.prepend(wrapper);
            }
        }
        setTimeout(() => setupSidebarResizeHandle(), 500);
    } 
    function updateEditModeToggleUI() {
        const icon = document.querySelector('.dockme-edit-stacks-icon');
        if (!icon) return;
        if (dockmeEditMode) {
            icon.classList.add('active');
            icon.title = 'Salir de edición';
            document.body.classList.add('dockme-edit-mode');
            dockmeEditModeFilterBackup = MetricsManager.filterActive ? MetricsManager.currentFilter : null;
            document.querySelectorAll('a.item').forEach(item => {
                item.style.display = '';
            });
            hideDashboardContainer();
            MobileMenu.close();
            showConfigPanel('stacks');
        } else {
            icon.classList.remove('active');
            icon.title = 'Configurar Dockme';
            document.body.classList.remove('dockme-edit-mode');
            // Restaurar filtro de servidor si estaba activo antes de editar
            if (dockmeEditModeFilterBackup) {
                MetricsManager.applyHostFilter(dockmeEditModeFilterBackup);
            } else {
                document.querySelectorAll('a.item').forEach(item => {
                    item.style.display = '';
                });
            }
            dockmeEditModeFilterBackup = null;
            hideStackEditor();
            MobileMenu.close();
            RecentManager.add();
            API.loadUpdates().then(data => State.setUpdatesData(data));
            Promise.all([loadStacksConfig(), loadLinksConfig()]).then(() => {
                showDashboardContainer();
                DataLoader.loadAndDisplay();
            });
            dockmeIconVersion = Date.now();
            localStorage.setItem('dockmeIconVersion', dockmeIconVersion);
        }
    }
    function hideDashboardContainer() {
        const dashboard = document.querySelector('#dockme-dashboard');
        if (dashboard) dashboard.style.display = 'none';
        MetricsManager.stop();
    }
    function OcultarAddUrlComposEditor() {
        // Ocultar sección "Addicional" en modo edición de compose
        if (RouteManager.isComposePath()) {
            const addicionalH4 = Array.from(document.querySelectorAll('h4.mb-3'))
                .find(h4 => h4.textContent.trim() === 'Addicional');
            if (addicionalH4) {
                const container = addicionalH4.parentElement;
                if (container && container.style.display !== 'none') {
                    container.style.display = 'none';
                }
            }
        }
    }
    function showDashboardContainer() {
        const dashboard = document.querySelector('#dockme-dashboard');
        if (dashboard) dashboard.style.display = '';
        MetricsManager.start();
    }
    function addFavFilterBtn(editor, active = false) {
        if (!stacksConfig.some(s => s.favorite)) return;
        const panel = document.querySelector('#dockme-stack-editor');
        if (!panel) return;
        const h2 = editor?.querySelector('h2');
        if (!h2 || panel.querySelector('.dockme-fav-filter-btn')) return;
        const btn = document.createElement('button');
        btn.className = `btn dockme-fav-filter-btn ${active ? 'btn-primary' : 'btn-normal'}`;
        btn.textContent = '⭐ Solo favoritos';
        btn.style.marginLeft = '15px';
        btn.dataset.active = active ? 'true' : 'false';
        btn.addEventListener('click', () => {
            const isActive = btn.dataset.active === 'true';
            btn.dataset.active = String(!isActive);
            btn.classList.toggle('btn-primary', !isActive);
            btn.classList.toggle('btn-normal', isActive);
            document.querySelectorAll('a.item').forEach(item => {
                const href = item.getAttribute('href') || '';
                const match = href.match(/^\/compose\/([^/]+)(?:\/([^/]+))?/);
                if (!match) { item.style.display = isActive ? '' : 'none'; return; }
                const nombre = match[1];
                const endpoint = match[2] || 'Actual';
                const esFav = stacksConfig.some(s =>
                    s.name?.toLowerCase() === nombre.toLowerCase() &&
                    s.endpoint?.toLowerCase() === endpoint.toLowerCase() &&
                    s.favorite
                );
                item.style.display = (!isActive && !esFav) ? 'none' : '';
            });
        });
        h2.appendChild(btn);
    }
    function showConfigPanel(defaultTab = 'stacks') {
        let panel = document.querySelector('#dockme-stack-editor');
        if (panel) {
            // Ya existe, solo cambiar tab
            switchConfigTab(defaultTab);
            return;
        }
        panel = document.createElement('div');
        panel.id = 'dockme-stack-editor';
        panel.className = 'dockme-stack-editor-container shadow-box';
        panel.innerHTML = `
            <div class="config-panel-header">
                <h2 class="dashboard-section-title"><img src="/system-icons/dockme-edit.svg" style="width:24px;height:24px;vertical-align:sub;margin-right:6px;">Configuración Dockme</h2>
                <button class="config-panel-close" title="Cerrar">×</button>
            </div>
            <div class="config-tabs">
                <button class="config-tab active" data-tab="stacks">⚙️ Stacks</button>
                <button class="config-tab" data-tab="servidores">🖥️ Servidores</button>
                <button class="config-tab" data-tab="links">🔗 Links</button>
            </div>
            <div class="config-content active" id="config-tab-stacks">
                <p>Selecciona un stack de la lista izquierda para editar sus datos.</p>
            </div>
            <div class="config-content" id="config-tab-servidores"></div>
            <div class="config-content" id="config-tab-links">
                <p>Próximamente...</p>
            </div>
        `;

        // Listeners de tabs
        panel.querySelectorAll('.config-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                switchConfigTab(btn.dataset.tab);
            });
        });
        panel.querySelector('.config-panel-close').addEventListener('click', () => {
            dockmeEditMode = false;
            updateEditModeToggleUI();
        });
        const dashboard = document.querySelector('#dockme-dashboard');
        if (dashboard) dashboard.before(panel);

        switchConfigTab(defaultTab);
    }

    function showStackEditorPlaceholder() {
        showConfigPanel('stacks');
    }

    function switchConfigTab(tab) {
        const panel = document.querySelector('#dockme-stack-editor');
        if (!panel) return;
        panel.querySelectorAll('.config-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });
        panel.querySelectorAll('.config-content').forEach(content => {
            content.classList.toggle('active', content.id === `config-tab-${tab}`);
        });
        // Al volver al tab stacks, resetear el editor al estado por defecto
        if (tab === 'stacks') {
            const editor = panel.querySelector('#config-tab-stacks');
            if (editor) editor.innerHTML = '<p>Selecciona un stack de la lista izquierda para editar sus datos.</p>';
        }
        // Cargar contenido del tab si está vacío
        if (tab === 'servidores') {
            const container = panel.querySelector('#config-tab-servidores');
            if (container && !container.dataset.loaded) {
                container.dataset.loaded = 'true';
                renderServidoresTab(container);
            }
        }
        if (tab === 'links') {
            const container = panel.querySelector('#config-tab-links');
            if (container) {
                container.dataset.loaded = 'true';
                renderLinksTab(container);
            }
        }
    }
    function showStackEditorForStack(stackName, endpoint = 'Actual') {
        // Asegurar que el panel existe y el tab stacks está activo
        if (!document.querySelector('#dockme-stack-editor')) {
            showConfigPanel('stacks');
        } else {
            switchConfigTab('stacks');
        }
        const editor = document.querySelector('#config-tab-stacks');
        if (!editor) return;

        // Guardar estado del botón favoritos antes de reemplazar HTML
        const favBtn = document.querySelector('.dockme-fav-filter-btn');
        const favBtnActive = favBtn?.dataset.active === 'true';

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
            addFavFilterBtn(editor, favBtnActive);
            return;
        }
        editor.innerHTML = `
            <h2>Editar datos del stack</h2>
            <div class="dockme-editor-hint">
                👉 Puedes seleccionar otro stack para seguir editando sus datos,
                o salir del modo edición usando el botón ✏️.
            </div>
            <div class="dockme-editor-header">
                <div class="dockme-icon-preview">
                    <img src="${getStackIconUrl(stackName, endpoint)}" alt="Icono de ${stackName}">
                </div>
                <div>
                    <div class="dockme-stack-name">
                        ${Utils.capitalizeFirst(stackName)}
                        <span class="dockme-favorite-star" title="Marcar como favorito">★</span>
                    </div>
                    ${(() => {
                        const serverHostname = State.updatesDataGlobal?.find(h =>
                            h.endpoint?.toLowerCase() === endpoint.toLowerCase()
                        )?.hostname || (endpoint === 'Actual' ? '' : endpoint);
                        return serverHostname ? `<div class="stack-hostname">${serverHostname}</div>` : '';
                    })()}
                </div>
            </div>
            <div class="dockme-icon-editor">
                <label class="dockme-icon-label">URL del servicio</label>
                <div class="dockme-icon-input-row">
                    <input
                        type="text"
                        class="dockme-service-url-input"
                        placeholder="https://servicio.midominio.com"
                    />
                    <span class="dockme-icon-status service-url"></span>
                </div>
            </div>            
            <div class="dockme-icon-editor">
                <label class="dockme-icon-label">Repositorio en GitHub</label>
                <div class="dockme-icon-input-row">
                    <input
                        type="text"
                        class="dockme-repo-url-input"
                        placeholder="https://github.com/usuario/repo"
                    />
                    <span class="dockme-icon-status repo-url"></span>
                </div>
            </div>
            <div class="dockme-icon-editor">
                <label class="dockme-icon-label">URL del icono (SVG)</label>
                <div class="dockme-icon-input-row">
                    <img src="/system-icons/subir-icono.svg" class="dockme-icon-upload-btn" title="Subir icono local (SVG)" style="height:32px;width:32px;cursor:pointer;margin-right:8px;flex-shrink:0;">
                    <input
                        type="text"
                        class="dockme-icon-url-input"
                        placeholder="https://example.com/icon.svg"
                    />
                    <span class="dockme-icon-status url"></span>
                </div>
                <input
                    type="file"
                    class="dockme-icon-file-input"
                    accept=".svg"
                    style="display:none"
                />
                <div class="dockme-editor-hint">
                👉 Solo se admiten iconos en formato <strong>SVG</strong>.
                Si lo tienes en otro formato, puedes convertirlo online en
                <a href="https://www.freeconvert.com/es/png-to-svg" target="_blank" rel="noopener noreferrer">
                    freeconvert.com
                </a>
                 Tambien tienes un monton de iconos gratuitos para servicios autohospedados en
                <a href="https://selfh.st/icons/" target="_blank" rel="noopener noreferrer">
                    Self-Hosted Dashboard Icons
                </a>
                 que puedes usar directamente copiando la URL del SVG.
            </div>
            </div>


        `;
        addFavFilterBtn(editor, favBtnActive);
//      Cargar datos actuales del stack desde memoria (stacksConfig ya cargado al inicio)
        const stackEntry = stacksConfig.find(s =>
            s.name.toLowerCase() === stackName.toLowerCase() &&
            s.endpoint.toLowerCase() === endpoint.toLowerCase()
        );
        // Si no tiene icono, intentar buscarlo en CDN automáticamente
        if (!stackEntry?.icon) {
            fetch(`/api/auto-icon?name=${encodeURIComponent(stackName)}&endpoint=${encodeURIComponent(endpoint)}`)
                .then(r => r.json())
                .then(data => {
                    if (data.success && data.iconFile) {
                        // Actualizar en memoria y refrescar preview
                        const entry = stacksConfig.find(s =>
                            s.name.toLowerCase() === stackName.toLowerCase() &&
                            s.endpoint.toLowerCase() === endpoint.toLowerCase()
                        );
                        if (entry) entry.icon = data.iconFile;
                        dockmeIconVersion = Date.now();
                        localStorage.setItem('dockmeIconVersion', dockmeIconVersion);
                        const preview = editor.querySelector('.dockme-icon-preview');
                        if (preview) preview.innerHTML = `<img src="${getStackIconUrl(stackName, endpoint)}" alt="Icono de ${stackName}">`;
                        reasignarIconos();
                    }
                })
                .catch(() => {});
        }
        const serviceInput = editor.querySelector('.dockme-service-url-input');
        if (serviceInput && stackEntry?.url) serviceInput.value = stackEntry.url;
        const repoInput = editor.querySelector('.dockme-repo-url-input');
        if (repoInput) {
            repoInput.value = stackEntry?.repo || State.sourcesDataGlobal?.[stackName] || '';
        }
//      Estrella favorito
        const star = editor.querySelector('.dockme-favorite-star');
        if (star) {
            star.classList.toggle('active', !!stackEntry?.favorite);
            star.addEventListener('click', () => {
                const isFav = star.classList.contains('active');
                fetch('/api/set-stack', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: stackName, endpoint, favorite: !isFav })
                })
                .then(r => r.json())
                .then(data => {
                    if (data.success) {
                        star.classList.toggle('active', !isFav);
                        loadStacksConfig().then(() => {
                            const favBtn = editor.querySelector('.dockme-fav-filter-btn');
                            const wasActive = favBtn?.dataset.active === 'true';
                            if (favBtn) favBtn.remove();
                            addFavFilterBtn(editor, wasActive);
                            // Reaplicar filtro de favoritos si estaba activo
                            if (wasActive) {
                                document.querySelectorAll('a.item').forEach(item => {
                                    const href = item.getAttribute('href') || '';
                                    const match = href.match(/^\/compose\/([^/]+)(?:\/([^/]+))?/);
                                    if (!match) { item.style.display = 'none'; return; }
                                    const nombre = match[1];
                                    const endpoint = match[2] || 'Actual';
                                    const esFav = stacksConfig.some(s =>
                                        s.name?.toLowerCase() === nombre.toLowerCase() &&
                                        s.endpoint?.toLowerCase() === endpoint.toLowerCase() &&
                                        s.favorite
                                    );
                                    item.style.display = esFav ? '' : 'none';
                                });
                            }
                        });
                    }
                })
                .catch(() => {});
            });
        }
        // URL del servicio
        const handleServiceUrlSave = () => {
            // Si el endpoint es local y no tiene primaryHost guardado, preguntar primero
            if (endpoint.toLowerCase() === 'actual' && !primaryHostLocal) {
                // Guardar la URL pendiente para ejecutarla tras el modal
                const doSaveUrl = () => {
                    let url = serviceInput.value.trim();
                    if (url && !url.match(/^https?:\/\//)) {
                        url = 'http://' + url;
                        serviceInput.value = url;
                    }
                    fetch('/api/set-stack', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: stackName, endpoint, url })
                    })
                    .then(r => r.json())
                    .then(data => {
                        setIconStatus(editor, 'service-url', data.success, data.success ? '' : 'Error al guardar');
                        if (data.success) {
                            const entry = stacksConfig.find(s =>
                                s.name.toLowerCase() === stackName.toLowerCase() &&
                                s.endpoint.toLowerCase() === endpoint.toLowerCase()
                            );
                            if (entry) entry.url = url;
                            setTimeout(() => {
                                const status = editor.querySelector('.dockme-icon-status.service-url');
                                if (status) { status.textContent = ''; status.className = 'dockme-icon-status service-url'; }
                            }, 2000);
                        }
                    })
                    .catch(() => { setIconStatus(editor, 'service-url', false, 'Error de conexión'); });
                };
                showPrimaryHostModal('Actual', null, (newVal, onSuccess) => {
                    fetch('/api/set-primary-host', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ primaryHost: newVal, oldHostname: window.location.hostname })
                    })
                    .then(r => r.json())
                    .then(data => {
                        if (data.success) {
                            primaryHostLocal = newVal;
                            const span = document.querySelector('.agent-primary-host-value[data-endpoint="Actual"]');
                            if (span) span.textContent = newVal;
                            onSuccess();
                            doSaveUrl();
                        }
                    })
                    .catch(() => {});
                }, doSaveUrl); // onCancel también guarda la URL
                return;
            }
            let url = serviceInput.value.trim();
            if (url && !url.match(/^https?:\/\//)) {
                url = 'http://' + url;
                serviceInput.value = url;
            }
            fetch('/api/set-stack', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: stackName, endpoint, url })
            })
            .then(r => r.json())
            .then(data => {
                setIconStatus(editor, 'service-url', data.success, data.success ? '' : 'Error al guardar');
                if (data.success) {
                    const entry = stacksConfig.find(s =>
                        s.name.toLowerCase() === stackName.toLowerCase() &&
                        s.endpoint.toLowerCase() === endpoint.toLowerCase()
                    );
                    if (entry) entry.url = url;
                    setTimeout(() => {
                        const status = editor.querySelector('.dockme-icon-status.service-url');
                        if (status) { status.textContent = ''; status.className = 'dockme-icon-status service-url'; }
                    }, 2000);
                }
            })
            .catch(() => {
                setIconStatus(editor, 'service-url', false, 'Error de conexión');
            });
        };
        serviceInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleServiceUrlSave(); }
        });
        serviceInput.addEventListener('paste', () => {
            setTimeout(handleServiceUrlSave, 50);
        });
        // URL del repositorio GitHub
        const handleRepoUrlSave = () => {
            let repo = repoInput.value.trim();
            if (repo && !repo.match(/^https?:\/\//)) {
                repo = 'https://' + repo;
                repoInput.value = repo;
            }
            fetch('/api/set-stack', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: stackName, endpoint, repo, applyRepoToAll: true })
            })
            .then(r => r.json())
            .then(data => {
                setIconStatus(editor, 'repo-url', data.success, data.success ? '' : 'Error al guardar');
                if (data.success) {
                    // Actualizar todas las entradas con ese nombre en memoria
                    stacksConfig
                        .filter(s => s.name.toLowerCase() === stackName.toLowerCase())
                        .forEach(s => { s.repo = repo; });
                    setTimeout(() => {
                        const status = editor.querySelector('.dockme-icon-status.repo-url');
                        if (status) { status.textContent = ''; status.className = 'dockme-icon-status repo-url'; }
                    }, 2000);
                }
            })
            .catch(() => {
                setIconStatus(editor, 'repo-url', false, 'Error de conexión');
            });
        };
        repoInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleRepoUrlSave(); }
        });
        repoInput.addEventListener('paste', () => {
            setTimeout(handleRepoUrlSave, 50);
        });
        // URL SVG
        const urlInput = editor.querySelector('.dockme-icon-url-input');
        const handleUrlApply = () => {
            const url = urlInput.value.trim();
            if (!url || !url.toLowerCase().endsWith('.svg')) {
                setIconStatus(editor, 'url', false, 'La URL debe apuntar a un archivo SVG');
                return;
            }
            const urlFilename = url.split('/').pop() || `${stackName}.svg`;
            fetch('/api/stack-icon', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: stackName, endpoint, filename: urlFilename, type: 'url', url })
            })
            .then(res => res.json())
            .then(data => {
                if (!data.success) {
                    setIconStatus(editor, 'url', false, data.error || 'Error al actualizar el icono');
                    return;
                }
                // Actualizar stacksConfig en memoria con el nuevo icon
                const entry = stacksConfig.find(s =>
                    s.name.toLowerCase() === stackName.toLowerCase() &&
                    s.endpoint.toLowerCase() === endpoint.toLowerCase()
                );
                if (entry) entry.icon = data.iconFile;
                setIconStatus(editor, 'url', true);
                setTimeout(() => {
                    const status = editor.querySelector('.dockme-icon-status.url');
                    if (status) { status.textContent = ''; status.className = 'dockme-icon-status url'; }
                }, 2000);
                dockmeIconVersion = Date.now();
                localStorage.setItem('dockmeIconVersion', dockmeIconVersion);
                const preview = editor.querySelector('.dockme-icon-preview');
                if (preview) {
                    preview.innerHTML = `<img src="${getStackIconUrl(stackName, endpoint)}" alt="Icono de ${stackName}">`;
                }
            })
            .catch(() => {
                setIconStatus(editor, 'url', false, 'Error de conexión');
            });
        };
        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleUrlApply(); }
        });
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
                    uploadStackIconFromSvg(stackName, endpoint, file.name, svgText, editor);
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
        const endpoint  = parts[2] || 'Actual';
        if (!stackName) return;
        MobileMenu.close();
        showStackEditorForStack(stackName, endpoint);
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
    function uploadStackIconFromSvg(stackName, endpoint, filename, svgText, editor) {
        fetch('/api/stack-icon', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: stackName,
                endpoint,
                filename,
                type: 'upload',
                svg: svgText
            })
        })
        .then(res => res.json())
        .then(data => {
            if (!data.success) {
                setIconStatus(editor, 'upload', false, data.error || 'Error al guardar el icono');
                return;
            }
            // Actualizar stacksConfig en memoria con el nuevo icon
            const entry = stacksConfig.find(s =>
                s.name.toLowerCase() === stackName.toLowerCase() &&
                s.endpoint.toLowerCase() === endpoint.toLowerCase()
            );
            if (entry) entry.icon = data.iconFile;
            setIconStatus(editor, 'upload', true);
            dockmeIconVersion = Date.now();
            localStorage.setItem('dockmeIconVersion', dockmeIconVersion);
            const preview = editor.querySelector('.dockme-icon-preview');
            if (preview) {
                preview.innerHTML = `<img src="${getStackIconUrl(stackName, endpoint)}" alt="Icono de ${stackName}">`;
            }
        })
        .catch(() => {
            setIconStatus(editor, 'upload', false, 'Error de conexión');
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
            const match = href.match(/\/compose\/([^/]+)(?:\/([^/]+))?/);
            if (!match) return;
            const stackName = match[1];
            const endpointIcon = match[2] || 'Actual';
            const esperado = getStackIconUrl(stackName, endpointIcon);
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
        // 3. Renombrar boton "Componer" de Dockge
        const btnComponer = document.querySelector('a.btn.btn-primary[href="/compose"]');
        if (btnComponer && !btnComponer.dataset.renamed) {
            btnComponer.lastChild.textContent = ' Crear nuevo servicio';
            btnComponer.style.visibility = 'visible';
            btnComponer.dataset.renamed = 'true';
        }
    }


    // ==================== GESTIÓN DE MÉTRICAS ====================
    const MetricsManager = {
        container: null,
        intervalId: null,
        filterActive: false,
        currentFilter: null,
        lastCheckStatus: {},
        formatUptime(seconds) {
            if (!seconds || seconds < 0) return 'Desconectado';
            const days = Math.floor(seconds / 86400);
            const hours = Math.floor((seconds % 86400) / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            if (days > 0) return `${days} día${days > 1 ? 's' : ''}`;
            if (hours > 0) return `${hours}h`;
            if (minutes > 0) return `${minutes} min`;
            return '1 min';
        },

        formatLastCheck(isoDate) {
            if (!isoDate) return '';
            const diff = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
            if (diff < 60) return 'ahora';
            if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
            if (diff < 86400) return `hace ${Math.floor(diff / 3600)}h`;
            return `hace ${Math.floor(diff / 86400)} días`;
        },

        hasDockmeUpdate(endpoint) {
            if (!Array.isArray(window.allUpdatesGlobal)) return false;
            
            return window.allUpdatesGlobal.some(item => {
                const stackName = (item.stack || '').toLowerCase();
                const itemEndpoint = (item.endpoint || '').toLowerCase();
                const normalizedEndpoint = (endpoint || '').toLowerCase();
                return stackName === 'dockme' && itemEndpoint === normalizedEndpoint;
            });
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

        createCard(hostname, metrics, status, endpoint) {
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
                if (endpoint.toLowerCase() === 'actual' && version !== 'unknown') window.lastMetricsVersion = version;
                const cpuClass = this.getColorClass(metrics.cpu, 'cpu');
                const memClass = this.getColorClass(metrics.memory, 'memory');
                const tempClass = this.getColorClass(metrics.temp_cpu, 'temp');

                // Comprobar si hay update de Dockme
                const hasDockmeUpdate = this.hasDockmeUpdate(endpoint);
                const isUpdating = window.dockmeUpdatesInProgress?.[endpoint];
                const showUpdateBtn = hasDockmeUpdate && !isUpdating;
                const versionDisplay = version !== 'unknown' && !showUpdateBtn
                    ? `<span class="metric-version">v${version}</span>` 
                    : '';
                // Updates info
                const checkStatus = metrics.check_status || 'idle';
                const checkPercent = metrics.check_percent || 0;
                const hostEntry = State.updatesDataGlobal?.find(h => (h.endpoint || '').toLowerCase() === endpoint.toLowerCase());
                const checkUpdates = (hostEntry?.updates?.length) || metrics.check_updates || 0;
                const pruneSpace = metrics.prune_space || '';
                const checkLast = metrics.check_last || '';
                const checkLastTooltip = checkLast ? (() => {
                    const diff = Math.floor((Date.now() - new Date(checkLast).getTime()) / 60000);
                    let t = '';
                    if (diff < 60) t = `Último chequeo hace ${diff} min`;
                    else if (diff < 1440) t = `Último chequeo hace ${Math.floor(diff / 60)}h`;
                    else t = `Último chequeo hace ${Math.floor(diff / 1440)}d`;
                    return t;
                })() : '';
                const updatesLabel = checkStatus === 'checking'
                    ? `<span class="metric-value warning">Comprobando ${checkPercent}%</span>`
                    : checkLast
                        ? `<span class="metric-value ${checkUpdates > 0 ? 'danger' : 'normal'}" title="${checkLastTooltip}">${checkUpdates > 0 ? checkUpdates + ' pendientes' : '✓ Al día'}</span>`
                        : `<span class="metric-value">--</span>`;
                // Obtener uiUrl e icono del servidor
                const serverEntry = State.updatesDataGlobal?.find(h =>
                    h.endpoint?.toLowerCase() === endpoint.toLowerCase()
                );
                const uiUrl = serverEntry?.uiUrl || '';
                const serverIconUrl = `/icons/server-${hostname}.svg?v=${dockmeIconVersion}`;
                const serverIconHtml = `
                    <span class="metric-server-icon-wrap${uiUrl ? ' has-url' : ''}" 
                          title="${uiUrl ? 'Abrir UI del servidor' : 'Configurar servidor'}">
                        <img src="${serverIconUrl}" class="metric-server-icon stack-icon-normal" alt="${hostname}"
                            onerror="this.src='/system-icons/no-icon.svg'">
                        <img src="${uiUrl ? '/system-icons/open-external.svg' : '/system-icons/dockme-edit.svg'}" 
                            class="metric-server-icon stack-icon-hover" alt="acción">
                    </span>
                `;
                card.innerHTML = `
                    <div class="metric-header">
                        <span style="display:flex;align-items:center;gap:8px;">
                            ${serverIconHtml}
                            <span class="metric-hostname">${hostname}${versionDisplay}</span>
                        </span>
                        <button class="btn-update-dockme" data-endpoint="${endpoint}" style="display: ${showUpdateBtn ? '' : 'none'}">Actualizar <img src="/system-icons/dockme.svg" style="width:20px;height:20px;vertical-align:text-top;"></button>
                    </div>
                    <div class="metric-row">
                        <span class="metric-label">Activo:&nbsp;<span class="metric-uptime ${uptimeClass}">${uptime}</span></span>
                        <span class="metric-label">CPU: <span class="metric-value ${cpuClass}">${metrics.cpu}%</span></span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-label">Temp:&nbsp;<span class="metric-value ${tempClass}">${metrics.temp_cpu != null ? metrics.temp_cpu + '°C' : '----'}</span></span>
                        <span class="metric-label">RAM: <span class="metric-value ${memClass}" >${metrics.memory}%</span></span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-label">Contenedores:</span>
                        <span style="display:flex;align-items:center;gap:6px;">
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.5;flex-shrink:0"><polygon points="5,3 19,12 5,21"/></svg>
                            <span class="metric-docker">${metrics.docker_running}</span>
                            ${metrics.docker_stopped > 0 ? `
                            / 
                            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.5;flex-shrink:0"><rect x="4" y="4" width="16" height="16"/></svg>
                            <span class="metric-stopped">${metrics.docker_stopped}</span>` : ''}
                        </span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-label">Actualizaciones:</span>
                        <span style="display:flex;align-items:center;gap:6px;">
                            ${updatesLabel}
                            <img src="/system-icons/check-updates.svg" class="btn-check-now" data-endpoint="${endpoint}" title="Comprobar ahora" style="cursor:pointer;width:18px;height:18px;opacity:0.7;${checkStatus === 'checking' ? 'display:none;' : ''}" />
                        </span>
                    </div>
                    ${pruneSpace ? `
                    <div class="metric-row">
                        <span class="metric-label">Limpieza de docker:</span>
                        <span class="metric-value normal">${pruneSpace}&nbsp;&nbsp;🧹</span>
                    </div>` : ''}
                `;
                const iconWrap = card.querySelector('.metric-server-icon-wrap');
                if (iconWrap && !uiUrl) {
                    iconWrap.addEventListener('click', (e) => {
                        e.stopPropagation();
                        dockmeEditMode = true;
                        updateEditModeToggleUI();
                        setTimeout(() => switchConfigTab('servidores'), 50);
                    });
                } else if (iconWrap && uiUrl) {
                    iconWrap.addEventListener('click', (e) => {
                        e.stopPropagation();
                        window.open(uiUrl, '_blank');
                    });
                }
            }

            // Click para filtrar
            card.addEventListener('click', () => {
                // Si solo hay una tarjeta → no filtrar
                const totalCards = this.container.querySelectorAll('.metric-card').length;
                if (totalCards <= 1) return;
                // Click sobre el mismo host → desactivar filtro
                if (this.filterActive && this.currentFilter === hostname) {
                    this.clearHostFilter();
                    return;
                }
                // Deseleccionar todas al cambiar filtro
                document.querySelectorAll('.stack-checkbox:checked').forEach(cb => cb.checked = false);
                syncBulkButtons();
                // Click sobre otro host → activar / cambiar filtro
                this.applyHostFilter(hostname);
            });

            // Tooltip al hacer hover en tarjeta métricas
            card.addEventListener('mouseenter', () => {
                const totalCards = this.container.querySelectorAll('.metric-card').length;
                if (totalCards <= 1) {
                    card.removeAttribute('title');
                    return;
                }
                const isActive = this.filterActive && this.currentFilter === hostname;
                card.title = isActive ? 'Click para quitar filtro' : 'Click para filtrar';
            });

            // Listener del botón actualizar Dockme
            const btnUpdate = card.querySelector('.btn-update-dockme');
            if (btnUpdate) {
                btnUpdate.addEventListener('click', (e) => {
                    e.stopPropagation();
                    btnUpdate.style.display = 'none';
                    EventHandlers.updateDockme(endpoint);
                });
            
                btnUpdate.addEventListener('mouseenter', (e) => {
                    e.stopPropagation();
                    btnUpdate.title = 'Actualizar Dockme en este servidor';
                });
            }
            // Listener del botón comprobar actualizaciones ahora
            const btnCheckNow = card.querySelector('.btn-check-now');
            if (btnCheckNow) {
                btnCheckNow.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    btnCheckNow.style.display = 'none';
                    try {
                        await fetch('/api/run-check', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ endpoint })
                        });
                    } catch {}
                });
            }

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
            
            const connectedEndpoints = AgentsState.agents.map(a => a.endpoint.toLowerCase());
            cardsContainer.innerHTML = '';
            let needsReload = false;
            data.hosts.forEach(host => {
                // Solo mostrar si está conectado en Dockge
                if (!connectedEndpoints.includes(host.endpoint.toLowerCase())) {
                    return;
                }
                
                const card = this.createCard(
                    host.hostname,
                    host.metrics,
                    host.status,
                    host.endpoint
                );
                cardsContainer.appendChild(card);
                // Quitar minHeight fijo una vez cargadas las tarjetas
                const metricsBox = document.querySelector('#metrics-box');
                if (metricsBox) metricsBox.style.minHeight = '';

                // Detectar fin de check O bajada de updates pendientes → recargar dashboard
                const prev = this.lastCheckStatus[host.endpoint] || { status: 'idle', updates: null };
                const currStatus = host.metrics?.check_status || 'idle';
                const currUpdates = host.metrics?.total_updates ?? host.metrics?.check_updates ?? null;

                const checkFinished = prev.status === 'checking' && currStatus === 'idle';
                const updatesChanged = prev.updates !== null && currUpdates !== null && currUpdates !== prev.updates;

                if (checkFinished || updatesChanged) {
                    needsReload = true;
                }
                this.lastCheckStatus[host.endpoint] = { status: currStatus, updates: currUpdates };
            });

            // Recargar dashboard una sola vez si algún check terminó
            if (needsReload) {
                needsReload = false;
                MetricsManager.stop();
                MetricsManager.container = null;
                API.loadUpdates().then(updatesData => {
                    State.setUpdatesData(updatesData);
                    Promise.all([loadStacksConfig(), loadLinksConfig()]).then(() => {
                        DataLoader.loadAndDisplay();
                        setTimeout(() => MetricsManager.start(), 500);
                    });
                });
            }
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
            
            // Botón Gestionar eliminado — sustituido por tab Servidores en panel de edición
            const manageBtn = header.querySelector('.dockme-manage-btn');
            if (manageBtn) manageBtn.remove();
            
            // ALERTA DE DETECTADOS
            let alert = this.container.querySelector('.dockme-detected-alert-simple');
            if (detected.length > 0 && !alert) {
                alert = document.createElement('div');
                alert.className = 'dockme-detected-alert-simple';
                alert.innerHTML = `⚠️ Hay ${detected.length} servidor${detected.length > 1 ? 'es' : ''} detectado${detected.length > 1 ? 's' : ''} sin conectar`;
                alert.style.cssText = 'cursor:pointer;font-size:0.82em;color:#f0a500;margin-top:4px;';
                alert.addEventListener('click', () => {
                    dockmeEditMode = true;
                    updateEditModeToggleUI();
                    setTimeout(() => switchConfigTab('servidores'), 50);
                });
                const cardsContainer = this.container.querySelector('.metrics-container');
                cardsContainer.insertAdjacentElement('afterend', alert);
            } else if (detected.length === 0 && alert) {
                alert.remove();
            } else if (detected.length > 0 && alert) {
                alert.innerHTML = `⚠️ Hay ${detected.length} servidor${detected.length > 1 ? 'es' : ''} detectado${detected.length > 1 ? 's' : ''} sin conectar`;
            }
        },

        ensureContainer() {
            const dockmeBlocks = document.querySelector('#dockme-dashboard');
            if (!dockmeBlocks) return;

            // Encontrar o crear el blocksRow
            let blocksRow = dockmeBlocks.querySelector('#dockme-blocks-row');
            if (!blocksRow) {
                blocksRow = document.createElement('div');
                blocksRow.id = 'dockme-blocks-row';
                dockmeBlocks.appendChild(blocksRow);
            }

            this.container = document.querySelector('#metrics-section');
            if (this.container) return;

            // Box redimensionable
            let metricsBox = document.querySelector('#metrics-box');
            if (!metricsBox) {
                metricsBox = document.createElement('div');
                metricsBox.id = 'metrics-box';
                metricsBox.className = 'links-cat-box';
                metricsBox.dataset.blockKey = 'type:metrics';

                // Aplicar ancho y alto guardados ANTES de insertar en el DOM
                const metricsBlock = linksConfig.find(c => c.type === 'metrics');
                if (metricsBlock?.width) metricsBox.style.width = metricsBlock.width + 'px';
                metricsBox.style.minHeight = (metricsBlock?.height ?? 282) + 'px';

                setupResizeHandle(metricsBox, (newWidth) => {
                    let block = linksConfig.find(c => c.type === 'metrics');
                    const newHeight = metricsBox.offsetHeight;
                    if (!block) {
                        block = { type: 'metrics', width: newWidth, height: newHeight };
                        linksConfig.push(block);
                    } else {
                        block.width = newWidth;
                        block.height = newHeight;
                    }
                    saveBlockOrder();
                });

                blocksRow.appendChild(metricsBox);
                setupBlockDrag(metricsBox, blocksRow);
            }

            this.container = document.createElement('div');
            this.container.id = 'metrics-section';
            const header = document.createElement('div');
            header.className = 'dockme-section-header';
            const title = document.createElement('div');
            title.className = 'links-cat-box-title';
            title.textContent = '🖥️ Servidores';
            header.appendChild(title);
            this.container.appendChild(header);
            const cardsContainer = document.createElement('div');
            cardsContainer.className = 'metrics-container';
            this.container.appendChild(cardsContainer);
            metricsBox.appendChild(this.container);
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
            
            // Filtrar también tarjetas de updates
            const updateCards = document.querySelectorAll('.stack-card-horizontal.update');
            updateCards.forEach(card => {
                const checkbox = card.querySelector('.stack-checkbox');
                if (!checkbox) return;
                
                const cardEndpoint = checkbox.dataset.endpoint;
                const host = State.updatesDataGlobal?.find(h =>
                    h.endpoint.toLowerCase() === cardEndpoint.toLowerCase()
                );
                const cardHostname = host?.hostname || cardEndpoint;
                
                const link = card.closest('.stack-card-link');
                if (link) {
                    link.style.display = cardHostname === hostname ? '' : 'none';
                }
            });
            if (!document.querySelector('.bulk-update-controls:hover')) {
                syncUpdatesUI();
                syncBulkButtons();
            }

            // Filtrar tarjetas de recientes
            const recentLinks = document.querySelectorAll('#recientes-row .stack-card-link');
            recentLinks.forEach(link => {
                const cardEndpoint = link.dataset.endpoint || 'Actual';
                const host = State.updatesDataGlobal?.find(h =>
                    h.endpoint.toLowerCase() === cardEndpoint.toLowerCase()
                );
                const cardHostname = host?.hostname || cardEndpoint;
                link.style.display = cardHostname === hostname ? '' : 'none';
            });
            const visibleRecentCards = Array.from(recentLinks).filter(l => l.style.display !== 'none');
            const recientesTitle = document.getElementById('recientes-title');
            const recientesRow = document.getElementById('recientes-row');
            if (visibleRecentCards.length === 0) {
                if (recientesTitle) recientesTitle.style.display = 'none';
                if (recientesRow) recientesRow.style.display = 'none';
            } else {
                if (recientesTitle) recientesTitle.style.display = '';
                if (recientesRow) recientesRow.style.display = '';
            }

            // Filtrar favoritos
            const favoritoLinks = document.querySelectorAll('#favoritos-row .stack-card-link');
            favoritoLinks.forEach(link => {
                const cardEndpoint = link.dataset.endpoint || 'Actual';
                const host = State.updatesDataGlobal?.find(h =>
                    h.endpoint.toLowerCase() === cardEndpoint.toLowerCase()
                );
                const cardHostname = host?.hostname || cardEndpoint;
                link.style.display = cardHostname === hostname ? '' : 'none';
            });
            const visibleFavCards = Array.from(favoritoLinks).filter(l => l.style.display !== 'none');
            const favoritosTitle = document.getElementById('favoritos-title');
            const favoritosRow = document.getElementById('favoritos-row');
            if (visibleFavCards.length === 0) {
                if (favoritosTitle) favoritosTitle.style.display = 'none';
                if (favoritosRow) favoritosRow.style.display = 'none';
            } else {
                if (favoritosTitle) favoritosTitle.style.display = '';
                if (favoritosRow) favoritosRow.style.display = '';
            }
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
            
            // Mostrar todas las tarjetas de updates
            const updateLinks = document.querySelectorAll('.stack-card-link');
            updateLinks.forEach(link => {
                if (link.querySelector('.stack-card-horizontal.update')) {
                    link.style.display = '';
                }
            });
            
            // Mostrar sección de updates
            const updatesTitle = document.getElementById('updates-title');
            const updatesRow = document.getElementById('updates-row');
            if (updatesTitle) updatesTitle.style.display = '';
            if (updatesRow) updatesRow.style.display = '';

            // Mostrar todas las tarjetas de recientes
            document.querySelectorAll('#recientes-row .stack-card-link').forEach(link => {
                link.style.display = '';
            });
            const recientesTitle = document.getElementById('recientes-title');
            const recientesRow = document.getElementById('recientes-row');
            if (recientesTitle) recientesTitle.style.display = '';
            if (recientesRow) recientesRow.style.display = '';

            // Mostrar todas las tarjetas de favoritos
            document.querySelectorAll('#favoritos-row .stack-card-link').forEach(link => {
                link.style.display = '';
            });
            const favoritosTitle = document.getElementById('favoritos-title');
            const favoritosRow = document.getElementById('favoritos-row');
            if (favoritosTitle) favoritosTitle.style.display = '';
            if (favoritosRow) favoritosRow.style.display = '';
            syncUpdatesUI();

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
            if (this.container && !document.contains(this.container)) {
                this.container = null;
            }
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
        }
    };
    // ==================== ALERTA TEMPORAL EN MÉTRICAS ====================
    function showMetricsAlert(message, duration = 10000) {
        const metricsSection = document.querySelector('#metrics-section');
        if (!metricsSection) return;
        
        let alert = metricsSection.querySelector('.dockme-updating-alert');
        if (!alert) {
            alert = document.createElement('div');
            alert.className = 'dockme-updating-alert';
            alert.style.cssText = 'font-size:0.82em;color:#f0a500;margin-bottom:8px;';
            const cardsContainer = metricsSection.querySelector('.metrics-container');
            cardsContainer.insertAdjacentElement('afterend', alert);
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
        const iconUrl = `/icons/server-${agent.hostname}.svg?v=${dockmeIconVersion}`;
        const endpointHtml = isLocal ? '' : `<div class="agent-endpoint-small">${agent.endpoint}</div>`;
        const primaryHostHtml = isLocal ? `
            <div class="agent-endpoint-small" style="display:flex;align-items:center;gap:4px;margin-top:4px;">
                <span class="agent-primary-host-value" data-endpoint="${agent.endpoint}">—</span>
                <img src="/system-icons/dockme-edit.svg" 
                    class="agent-primary-host-edit" 
                    data-endpoint="${agent.endpoint}"
                    title="Editar IP base del servidor"
                    style="width:20px;height:20px;cursor:pointer;opacity:0.6;flex-shrink:0;">
            </div>` : '';
        return `
            <tr>
                <td class="text-center">
                    <img src="${iconUrl}" class="agent-server-icon" alt="${agent.hostname}"
                        onerror="this.src='/system-icons/no-icon.svg'"
                        data-endpoint="${agent.endpoint}" title="Click para cambiar icono">
                    <input type="file" class="agent-icon-file-input" accept=".svg" style="display:none" data-endpoint="${agent.endpoint}">
                </td>
                <td>
                    <strong>${agent.hostname}</strong>
                    ${endpointHtml}
                    ${primaryHostHtml}
                </td>
                <td>
                    <div style="display:flex;align-items:center;gap:6px;">
                        <input type="text" class="agent-ui-url-input dockme-service-url-input"
                            placeholder="https://ip:puerto"
                            data-endpoint="${agent.endpoint}"
                            value="">
                        <span class="agent-url-status" data-endpoint="${agent.endpoint}" style="font-size:18px;min-width:20px;"></span>
                    </div>
                </td>
                <td class="text-center">
                    ${isLocal 
                        ? `<img src="/system-icons/dockme-edit.svg" class="agent-primary-host-edit" data-endpoint="${agent.endpoint}" title="Editar IP base del servidor" style="width:28px;height:28px;cursor:pointer;opacity:0.7;">`
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
                        <th style="width: 48px;">Icono</th>
                        <th>Servidor</th>
                        <th>URL Interfaz web</th>
                        <th style="width: 60px;">Acción</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
            <div class="dockme-editor-hint">
                👉 Click en el icono del servidor para subir un nuevo icono, o edita la url a la que te llevara dicho icono desde la tarjeta de metricas para abrir la web del servidor.
            </div>
        </div>
    `;
}

// ==================== MOSTRAR PANEL DE GESTIÓN ====================
function showPrimaryHostModal(endpoint, currentValue, onSave, onCancel, fromServidores = false) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';
    const isFirstTime = !currentValue;
    const title = isFirstTime ? 'Configura tu servidor' : 'IP base del servidor';
    const desc = isFirstTime
        ? 'Ahora puedes configurar la URL base para lanzar los servicios Docker. Introduce la IP o hostname que quieres usar:'
        : 'IP o hostname local del servidor. Se usa para generar automáticamente las URLs de servicio.';
    const hint = isFirstTime
        ? `<p style="font-size:0.8em;color:#4f84c8;margin:0 0 16px;">Puedes cambiarlo después desde <strong>Configuración → Servidores → ✏️</strong></p>`
        : '';
    modal.innerHTML = `
        <div style="background:#1a2332;border:1px solid #3a4557;border-radius:12px;padding:24px;width:400px;max-width:90vw;">
            <h3 style="margin:0 0 10px;font-size:1.1em;">${title}</h3>
            <p style="font-size:0.85em;color:#888;margin:0 0 12px;line-height:1.5;">${desc}</p>
            <p style="font-size:0.85em;color:#888;margin:0 0 16px;line-height:2;">
                <code style="color:#4f84c8;">localhost</code> &nbsp;→ http://localhost:8080<br>
                <code style="color:#4f84c8;">192.168.0.15</code> → http://192.168.0.15:8080
            </p>
            <input type="text" id="primary-host-modal-input"
                value="${currentValue || 'localhost'}"
                placeholder="localhost"
                style="width:100%;box-sizing:border-box;padding:8px;border-radius:6px;border:1px solid #3a4557;background:#121821;color:#fff;font-family:monospace;margin-bottom:12px;">
            ${hint}
            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button id="primary-host-save" class="btn btn-normal">Guardar</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    const input = modal.querySelector('#primary-host-modal-input');
    input.focus();
    input.select();
    modal.querySelector('#primary-host-save').addEventListener('click', () => {
        const val = input.value.trim();
        if (!val) return;
        if (onSave) onSave(val, () => { modal.remove(); });
    });
}


function renderServidoresTab(container) {
    readAgentsFromDockgeDOM();
    container.innerHTML = `
        ${createAgentsTable()}
        ${createDetectedServersSection()}
    `;

    // Cargar uiUrl actuales desde updates.json
    fetch('/config/updates.json?t=' + Date.now())
        .then(r => r.json())
        .then(data => {
            container.querySelectorAll('.agent-ui-url-input').forEach(input => {
                const ep = input.dataset.endpoint;
                const entry = data.find(h => h.endpoint?.toLowerCase() === ep?.toLowerCase());
                if (entry?.uiUrl) {
                    input.value = entry.uiUrl;
                    setTimeout(() => { input.scrollLeft = 0; }, 50);
                    input.addEventListener('blur', () => { input.scrollLeft = 0; });
                }
            });
            // Cargar primaryHost para el servidor local
            let needsPrimaryHostSetup = false;
            container.querySelectorAll('.agent-primary-host-value').forEach(span => {
                const ep = span.dataset.endpoint;
                const entry = data.find(h => h.endpoint?.toLowerCase() === ep?.toLowerCase());
                if (entry?.primaryHost) {
                    span.textContent = entry.primaryHost;
                } else {
                    span.textContent = 'localhost';
                    needsPrimaryHostSetup = true;
                }
            });

        })
        .catch(() => {});

    // Listeners URL de UI
    container.querySelectorAll('.agent-ui-url-input').forEach(input => {
        const handleSave = () => {
            let url = input.value.trim();
            if (url && !url.match(/^https?:\/\//)) {
                url = 'http://' + url;
                input.value = url;
            }
            fetch('/api/set-server', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: input.dataset.endpoint, uiUrl: url })
            })
            .then(r => r.json())
            .then(data => {
                const status = container.querySelector(`.agent-url-status[data-endpoint="${input.dataset.endpoint}"]`);
                if (status) {
                    status.textContent = data.success ? '✅' : '❌';
                    setTimeout(() => status.textContent = '', 2000);
                }
            })
            .catch(() => {});
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
        });
        input.addEventListener('paste', () => setTimeout(handleSave, 50));
    });

    // Listener lápiz primaryHost — abre modal
    container.querySelectorAll('.agent-primary-host-edit').forEach(btn => {
        btn.addEventListener('click', () => {
            const ep = btn.dataset.endpoint;
            const currentVal = container.querySelector(`.agent-primary-host-value[data-endpoint="${ep}"]`)?.textContent || '';
            const isDefault = currentVal === 'localhost';
            showPrimaryHostModal(ep, isDefault ? null : currentVal, (newVal, onSuccess) => {
                fetch('/api/set-primary-host', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ primaryHost: newVal, oldHostname: primaryHostLocal || window.location.hostname })
                })
                .then(r => r.json())
                .then(data => {
                    if (data.success) {
                        primaryHostLocal = newVal;
                        const span = container.querySelector(`.agent-primary-host-value[data-endpoint="${ep}"]`);
                        if (span) span.textContent = newVal;
                        // Actualizar en memoria
                        if (Array.isArray(State.updatesDataGlobal)) {
                            const local = State.updatesDataGlobal.find(h => h.endpoint?.toLowerCase() === 'actual');
                            if (local) local.primaryHost = newVal;
                        }
                        // Recargar stacksConfig para que las URLs actualizadas estén disponibles
                        loadStacksConfig();
                        onSuccess();
                    }
                })
                .catch(() => {});
            }, null, true);
        });
    });

    // Listeners icono servidor
    container.querySelectorAll('.agent-server-icon').forEach(img => {
        img.addEventListener('click', () => {
            const fileInput = img.nextElementSibling;
            if (fileInput) fileInput.click();
        });
    });

    container.querySelectorAll('.agent-icon-file-input').forEach(fileInput => {
        fileInput.addEventListener('change', () => {
            const file = fileInput.files[0];
            if (!file) return;
            if (file.type !== 'image/svg+xml' && !file.name.toLowerCase().endsWith('.svg')) {
                alert('Solo se admiten iconos SVG');
                fileInput.value = '';
                return;
            }
            const reader = new FileReader();
            reader.onload = () => {
                const svgText = reader.result;
                if (!svgText || !/<svg[\s>]/i.test(svgText)) {
                    alert('El archivo no es un SVG válido');
                    return;
                }
                fetch('/api/set-server', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ endpoint: fileInput.dataset.endpoint, svg: svgText })
                })
                .then(r => r.json())
                .then(data => {
                    if (data.success) {
                        dockmeIconVersion = Date.now();
                        localStorage.setItem('dockmeIconVersion', dockmeIconVersion);
                        const img = container.querySelector(`.agent-server-icon[data-endpoint="${fileInput.dataset.endpoint}"]`);
                        if (img) img.src = img.src.split('?')[0] + '?v=' + dockmeIconVersion;
                        // Actualizar también en tarjeta de métricas
                        const metricImg = document.querySelector(`#metrics-box .metric-server-icon[alt="${fileInput.dataset.endpoint}"]`);
                        if (metricImg) metricImg.src = metricImg.src.split('?')[0] + '?v=' + dockmeIconVersion;
                    }
                })
                .catch(() => {});
                fileInput.value = '';
            };
            reader.readAsText(file);
        });
    });

    const deleteButtons = container.querySelectorAll('.btn-delete-agent');
    deleteButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            deleteAgent(btn.dataset.endpoint);
        });
    });

    const connectButtons = container.querySelectorAll('.dockme-connect-agent-btn');
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
            btn.disabled = true;
            btn.textContent = 'Conectando...';
            const success = await addAgentToDockge(`http://${endpoint}`, username, password, endpoint, errorDiv);
            if (success) {
                readAgentsFromDockgeDOM();
                container.dataset.loaded = '';
                renderServidoresTab(container);
            } else {
                btn.disabled = false;
                btn.textContent = 'Conectar agente';
            }
        });
    });

    const discardButtons = container.querySelectorAll('.btn-discard-detected');
    discardButtons.forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const endpoint = btn.dataset.endpoint;
            const row = btn.closest('.detected-server-row');
            const hostname = row.querySelector('.detected-server-hostname').textContent;
            if (!confirm(`¿Descartar servidor "${hostname}"?\n\nSi se vuelve a iniciar hacia este central, volverá a aparecer.`)) return;
            await discardDetectedServer(endpoint);
        });
    });
}

function renderLinksTab(container) {
    const render = () => {
        container.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <span style="font-size:1em;color:#aaa;">Añade y organiza tus enlaces</span>
                <button class="btn btn-normal btn-add-category">+ Nueva categoría</button>
            </div>
            <div id="links-categories-list"></div>
        `;

        const list = container.querySelector('#links-categories-list');
        renderCategories(list);

        container.querySelector('.btn-add-category').addEventListener('click', () => {
            linksConfig.push({ category: 'Nueva categoría', order: linksConfig.length, links: [] });
            saveLinks().then(() => {
                render();
                setTimeout(() => {
                    const inputs = container.querySelectorAll('.links-cat-name');
                    const last = inputs[inputs.length - 1];
                    if (last) { last.focus(); last.select(); }
                }, 50);
            });
        });
    };

    const saveLinks = () => {
        return fetch('/api/set-links', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ links: linksConfig })
        }).then(r => r.json());
    };

    const renderCategories = (list) => {
        list.innerHTML = '';
        linksConfig
            .filter(cat => cat.category)
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .forEach((cat) => {
                const catIdx = linksConfig.indexOf(cat);
                const catEl = document.createElement('div');
                catEl.className = 'links-category-editor';
                catEl.dataset.catIdx = catIdx;
                catEl.innerHTML = `
                    <div class="links-cat-header">
                        <input class="links-cat-name dockme-service-url-input" value="${cat.category}" style="flex:1;font-size:1em;font-weight:500;">
                        <button class="btn btn-danger btn-delete-category" style="padding:2px 8px;">🗑</button>
                    </div>
                    <div class="links-items-list"></div>
                    <button class="btn btn-normal btn-add-link" style="width:100%;margin-top:8px;">+ Añadir link</button>
                `;

                const itemsList = catEl.querySelector('.links-items-list');
                renderLinks(itemsList, cat, catIdx, saveLinks, render);

                catEl.querySelector('.links-cat-name').addEventListener('change', (e) => {
                    linksConfig[catIdx].category = Utils.capitalizeFirst(e.target.value.trim());
                    e.target.value = linksConfig[catIdx].category;
                    saveLinks();
                });
                catEl.querySelector('.links-cat-name').addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        e.target.blur();
                    }
                });

                catEl.querySelector('.btn-delete-category').addEventListener('click', () => {
                    if (!confirm(`¿Eliminar categoría "${cat.category}" y todos sus links?`)) return;
                    linksConfig.splice(catIdx, 1);
                    linksConfig.forEach((c, i) => c.order = i);
                    saveLinks().then(() => render());
                });

                catEl.querySelector('.btn-add-link').addEventListener('click', () => {
                    linksConfig[catIdx].links.push({ name: 'Nuevo link', url: '', icon: '', order: linksConfig[catIdx].links.length });
                    saveLinks().then(() => {
                        render();
                        setTimeout(() => {
                            // Buscar por data-catIdx en lugar de por posición
                            const thisCat = container.querySelector(`.links-category-editor[data-cat-idx="${catIdx}"]`);
                            if (thisCat) {
                                const rows = thisCat.querySelectorAll('.links-item-name');
                                const last = rows[rows.length - 1];
                                if (last) { last.focus(); last.select(); }
                            }
                        }, 100);
                    });
                });

                list.appendChild(catEl);
            });
    };

    render();
}

function renderLinks(container, cat, catIdx, saveLinks, rerender) {
    container.innerHTML = '';
    cat.links
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .forEach((link, linkIdx) => {
            const iconSrc = link.icon
                ? `/icons/${link.icon}`
                : '/system-icons/no-icon.svg';
            const row = document.createElement('div');
            row.className = 'links-item-row';
            row.dataset.linkIdx = linkIdx;
            row.innerHTML = `
                <span class="links-drag-handle">☰</span>
                <span class="links-item-icon-wrap" title="Click para cambiar icono">
                    <img src="${iconSrc}" class="links-item-icon" alt="${link.name}"
                        onerror="this.src='/system-icons/no-icon.svg'">
                    <input type="file" class="links-icon-file" accept=".svg,.png" style="display:none">
                </span>
                <input class="links-item-name dockme-service-url-input" value="${link.name}" placeholder="Nombre" style="flex:1;">
                <input class="links-item-url dockme-service-url-input" value="${link.url}" placeholder="https://..." style="flex:2;">
                <button class="btn btn-danger btn-delete-link" style="padding:2px 8px;">🗑</button>
            `;

            // Click icono → abrir file input
            row.querySelector('.links-item-icon-wrap').addEventListener('click', () => {
                row.querySelector('.links-icon-file').click();
            });

            // Subir icono
            row.querySelector('.links-icon-file').addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                    const ext = file.name.split('.').pop().toLowerCase();
                    const iconName = `link-${link.name.toLowerCase().replace(/\s+/g, '-')}.${ext}`;
                    fetch('/api/stack-icon', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ stack: `link-${link.name.toLowerCase().replace(/\s+/g, '-')}`, type: 'upload', svg: reader.result })
                    })
                    .then(r => r.json())
                    .then(data => {
                        if (data.success) {
                            linksConfig[catIdx].links[linkIdx].icon = iconName;
                            saveLinks().then(() => rerender());
                        }
                    });
                };
                reader.readAsText(file);
                e.target.value = '';
            });

            // Guardar nombre
            row.querySelector('.links-item-name').addEventListener('change', (e) => {
                linksConfig[catIdx].links[linkIdx].name = Utils.capitalizeFirst(e.target.value.trim());
                e.target.value = linksConfig[catIdx].links[linkIdx].name;
                saveLinks();
            });
            row.querySelector('.links-item-name').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    row.querySelector('.links-item-url').focus();
                }
            });

            // Guardar URL + favicon automático
            const urlInput = row.querySelector('.links-item-url');
            const handleUrlSave = () => {
                let url = urlInput.value.trim();
                if (url && !url.match(/^https?:\/\//)) {
                    url = 'http://' + url;
                    urlInput.value = url;
                }
                linksConfig[catIdx].links[linkIdx].url = url;
                saveLinks();
                // Intentar favicon si no tiene icono
                if (url && !linksConfig[catIdx].links[linkIdx].icon) {
                    const name = linksConfig[catIdx].links[linkIdx].name.toLowerCase().replace(/\s+/g, '-');
                    fetch('/api/fetch-favicon', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url, name })
                    })
                    .then(r => r.json())
                    .then(data => {
                        if (data.success) {
                            linksConfig[catIdx].links[linkIdx].icon = data.iconFile;
                            saveLinks().then(() => rerender());
                        }
                    })
                    .catch(() => {});
                }
            };
            urlInput.addEventListener('keydown', (e) => { 
                if (e.key === 'Enter') { 
                    e.preventDefault(); 
                    handleUrlSave();
                    urlInput.blur();
                } 
            });
            urlInput.addEventListener('paste', () => setTimeout(() => {
                handleUrlSave();
                urlInput.blur();
            }, 50));

            // Eliminar link
            row.querySelector('.btn-delete-link').addEventListener('click', () => {
                linksConfig[catIdx].links.splice(linkIdx, 1);
                linksConfig[catIdx].links.forEach((l, i) => l.order = i);
                saveLinks().then(() => rerender());
            });

            container.appendChild(row);
        });

    initLinkDragDrop(container, catIdx, saveLinks, rerender);
}

function initLinkDragDrop(container, catIdx, saveLinks, rerender) {
    let dragEl = null;
    container.querySelectorAll('.links-item-row').forEach(el => {
        el.querySelector('.links-drag-handle').addEventListener('mousedown', () => {
            el.draggable = true;
        });
        el.addEventListener('dragstart', (e) => {
            dragEl = el;
            e.dataTransfer.effectAllowed = 'move';
            setTimeout(() => el.style.opacity = '0.4', 0);
        });
        el.addEventListener('dragend', () => {
            el.style.opacity = '';
            el.draggable = false;
            dragEl = null;
            const items = container.querySelectorAll('.links-item-row');
            items.forEach((item, i) => {
                linksConfig[catIdx].links[parseInt(item.dataset.linkIdx)].order = i;
            });
            saveLinks().then(() => rerender());
        });
        el.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (dragEl && dragEl !== el) {
                const rect = el.getBoundingClientRect();
                const mid = rect.top + rect.height / 2;
                if (e.clientY < mid) {
                    container.insertBefore(dragEl, el);
                } else {
                    container.insertBefore(dragEl, el.nextSibling);
                }
            }
        });
    });
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
                        });
                    }
                    readAgentsFromDockgeDOM();
                    // Refrescar tab servidores del panel de configuración si está abierto
                    const configContainer = document.querySelector('#config-tab-servidores');
                    if (configContainer) {
                        configContainer.dataset.loaded = '';
                        renderServidoresTab(configContainer);
                    }
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
        const configContainer = document.querySelector('#config-tab-servidores');
        if (configContainer) {
            configContainer.dataset.loaded = '';
            renderServidoresTab(configContainer);
        }
        
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
                Promise.all([loadStacksConfig(), loadLinksConfig()]).then(() => DataLoader.loadAndDisplay());
                MetricsManager.stop();
                MetricsManager.start();
            }
        }
        ItemManager.processAll();
        ensureTitleIsCorrect();
        insertEditStacksIcon();
        setTimeout(() => ItemManager.refreshIcons(), CONFIG.ICON_REFRESH_DELAY);
        OcultarAddUrlComposEditor();
        if (RouteManager.isComposePath()) UIComponents.fixPortLinks();
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
        const maxAttempts = 50;
        const checkAndLoadAgents = () => {
            attempts++;

            // Esperar a que Vue haya renderizado el DOM de Dockge
            const root = ensureDockmeRoot();
            if (!root) {
                if (attempts < maxAttempts) setTimeout(checkAndLoadAgents, 200);
                return;
            }

            const agentsExist = document.querySelectorAll('.first-row .agent').length > 0;
            if (agentsExist) {
                readAgentsFromDockgeDOM();
            }

            Promise.all([loadStacksConfig(), loadLinksConfig()]).then(() => DataLoader.loadAndDisplay());
            // Interceptar navegación Vue para iconos con URL
            let lastMousePos = { x: 0, y: 0 };
            document.addEventListener('mousemove', (e) => {
                lastMousePos = { x: e.clientX, y: e.clientY };
            }, true);
            const vueRouter = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$router;
            if (vueRouter) {
                vueRouter.beforeEach((to, from, next) => {
                    if (to.path?.startsWith('/compose/')) {
                        const allIcons = document.querySelectorAll('img.cp-icon');
                        let img = null;
                        for (const icon of allIcons) {
                            const rect = icon.getBoundingClientRect();
                            if (lastMousePos.x >= rect.left && lastMousePos.x <= rect.right &&
                                lastMousePos.y >= rect.top  && lastMousePos.y <= rect.bottom) {
                                img = icon;
                                break;
                            }
                        }
                        if (img) {
                            const parentItem = img.closest('a.item');
                            const href = parentItem?.getAttribute('href') || '';
                            const nameFromHref = href.match(/^\/compose\/([^/]+)/)?.[1];
                            const endpointFromHref = href.match(/\/compose\/[^/]+\/(.+)$/)?.[1] || 'Actual';
                            const stackData = stacksConfig.find(s =>
                                s.name?.toLowerCase() === (nameFromHref || img.dataset.stackName)?.toLowerCase() &&
                                s.endpoint?.toLowerCase() === (endpointFromHref || img.dataset.stackEndpoint || 'Actual').toLowerCase()
                            );
                            if (stackData?.url) {
                                window.open(stackData.url, '_blank');
                            }
                            next(false);
                            return;
                        }
                    }
                    next();
                });
            }
            MetricsManager.start();
            // Pausar métricas cuando la pestaña no está activa
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    MetricsManager.stop();
                } else if (RouteManager.isRootPath()) {
                    MetricsManager.start();
                }
            });
        };
        setTimeout(checkAndLoadAgents, 300);
    }
}

    // ==================== START ====================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();