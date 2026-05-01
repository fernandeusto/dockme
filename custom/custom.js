(function () {
    'use strict';
    let dockmeWaitingForLogin = false;
    let dockmeLoginWasVisible = false;
    let dockmeEditMode = false;
    let dockmeEditModeFilterBackup = null;
    let logsEventSource = null;
    let xtermInstance = null;
    let logsAutoScroll = true;
    let logsCurrentStack = null;
    let logsCurrentEndpoint = null;
    let logsActiveTab = 'logs'; // recordar el tab activo entre stacks
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
        RECENT_COMPOSES_LIMIT: 9,
        FOCUS_DELAY: 1200,
        ICON_REFRESH_DELAY: 1000
    };

    // ==================== GESTIÓN DE ESTADO GLOBAL ====================
    const State = {
        updatesDataGlobal: null,
        sourcesDataGlobal: null,
        settingsData: null,
        hostnameLocal: null,
        lastPath: window.location.pathname,
        
        setUpdatesData(data) {
            this.updatesDataGlobal = data;
            window.updatesDataGlobal = data;
            // primaryHost viene de settings.json (fuente de verdad)
            // updatesDataGlobal ya no lo lleva
            if (Array.isArray(data)) {
                const local = data.find(h => h.endpoint?.toLowerCase() === 'actual');
                const ph = this.settingsData?.primaryHost || local?.primaryHost || null;
                if (ph) {
                    primaryHostLocal = ph;
                } else if (local && RouteManager.isRootPath() && !State.settingsData?.centralUrl && !RouteManager.isSetupPath()) {
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
                                    if (State.settingsData) State.settingsData.primaryHost = newVal;
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

    };
    // ==================== UI / NAVEGACIÓN ====================
    function ensureTitleIsCorrect() {
        const titleElement = document.querySelector('.fs-4.title');
        if (!titleElement) return;
        // Actualizar título siempre con el hostname local
        const hostname = State.hostnameLocal || 'Dockme';
        titleElement.textContent = hostname;
        document.title = `Dockme - ${hostname}`;
        titleElement.style.visibility = '';
        document.body.classList.add('dockme-title-ready');
        // Click en el título → volver al dashboard
        if (!titleElement.dataset.dockmeClick) {
            titleElement.dataset.dockmeClick = '1';
            titleElement.style.cursor = 'pointer';
            titleElement.addEventListener('click', () => {
                if (document.body.classList.contains('dockme-logs-mode')) {
                    deactivateLogsMode();
                }
                window.history.pushState({}, '', '/');
                window.dispatchEvent(new Event('popstate'));
            });
        }
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
        isRootPath() {
            return window.location.pathname === '/';
        },

        isSetupPath() {
            return window.location.pathname === '/setup';
        }
    };

    // ==================== GESTIÓN DE VISITAS RECIENTES ====================
    const RecentManager = {
        KEY: 'recentComposes',

        add(stackName, endpoint) {
            if (!stackName) return;
            const ep = endpoint || 'Actual';
            let recientes = Storage.get(this.KEY, []);
            recientes = recientes.filter(item =>
                !(item.name.toLowerCase() === stackName.toLowerCase() &&
                  (item.endpoint || 'Actual').toLowerCase() === ep.toLowerCase())
            );
            recientes.unshift({
                name: stackName,
                visited: Date.now(),
                endpoint: ep
            });
            if (recientes.length > CONFIG.RECENT_COMPOSES_LIMIT) {
                recientes = recientes.slice(0, CONFIG.RECENT_COMPOSES_LIMIT);
            }
            Storage.set(this.KEY, recientes);
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

        async loadSettings() {
            try {
                return await this.fetchJSON(`${CONFIG.BASE_URL}/api/get-settings?t=${Date.now()}`);
            } catch {
                return {};
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
            let texto = Utils.capitalizeFirst(original);
            
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
            const { nombre, displayName, endpoint, composePath, dockerExtra } = 
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
                
                // Gestionar checkbox en updates — click siempre toggle, nunca navegar
                if (idBase.startsWith('updates')) {
                    e.preventDefault();
                    if (BulkUpdatePanel.panel) return;
                    const checkbox = card.querySelector('.stack-checkbox');
                    if (checkbox && !e.target.closest('.stack-checkbox')) {
                        checkbox.checked = !checkbox.checked;
                        syncBulkButtons();
                    }
                    return;
                }
                
                // Comportamiento normal — si no es updates, ir a logs
                e.preventDefault();
                if (!idBase.startsWith('updates')) {
                    if (!document.body.classList.contains('dockme-logs-mode')) {
                        activateLogsMode();
                        setTimeout(() => openLogsForStack(nombre, endpoint || 'Actual'), 100);
                    } else {
                        openLogsForStack(nombre, endpoint || 'Actual');
                    }
                    return;
                }
                window.history.pushState({}, '', link.href);
                window.dispatchEvent(new Event('popstate'));
            });

            const card = document.createElement('div');
            card.className = 'stack-card-horizontal';

            if (idBase.startsWith('updates')) {
                this.setupUpdateCard(card, item, nombre, displayName, iconoUrl, endpoint, blockTitle, blockRow);
            } else if (idBase.startsWith('recientes')) {
                this.setupRecentCard(card, item, displayName, iconoUrl);
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
            let nombre, displayName, endpoint, dockerExtra = '';

            if (idBase.startsWith('recientes') || idBase.startsWith('favoritos')) {
                nombre = item.name;
                endpoint = item.endpoint || 'Actual';

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

            displayName = Utils.capitalizeFirst(nombre) + dockerExtra;

            const isRemote = endpoint && endpoint.toLowerCase() !== 'actual';
            const composePath = isRemote ? `/compose/${nombre}/${endpoint}` : `/compose/${nombre}`;

            return { nombre, displayName, endpoint, composePath, dockerExtra };
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

        setupRecentCard(card, item, displayName, iconoUrl) {
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
            if (!!State.settingsData?.centralUrl) return; // agente: no dibujar dashboard
            if (document.body.classList.contains('dockme-logs-mode')) return; // logs activo: no redibujar
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

            // Renderizar bloques en orden guardado (o fijo en móvil)
            const esMobil = window.innerWidth <= 700;
            const sortedBlocks = esMobil
                ? [
                    ...(linksConfig.filter(b => b.type === 'metrics')),
                    ...(linksConfig.filter(b => b.type === 'favoritos')),
                    ...(linksConfig.filter(b => b.category).sort((a, b) => (a.order ?? 999) - (b.order ?? 999)))
                  ]
                : [...linksConfig].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

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

    // ==================== EVENT HANDLERS ====================
    function autoAssignServiceUrl(stackName, endpoint, composeContent) {
        if (!stackName) return;
        // Solo si no tiene URL asignada
        const entry = stacksConfig.find(s =>
            s.name.toLowerCase() === stackName.toLowerCase() &&
            s.endpoint.toLowerCase() === endpoint.toLowerCase()
        );
        // Leer el puerto del contenido pasado o del editor CodeMirror en el DOM
        const lines = composeContent || [...document.querySelectorAll('.cm-content .cm-line')]
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
                    if (document.body.classList.contains('dockme-logs-mode')) {
                        deactivateLogsMode();
                    }
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
                        <div class="stack-update-row" data-stack="${s.name}" data-endpoint="${s.endpoint || 'Actual'}" style="cursor:pointer;">
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

            // Click en tarjeta → modo logs del stack
            this.panel.querySelectorAll('.stack-update-row').forEach(row => {
                row.addEventListener('click', (e) => {
                    if (e.target.closest('.stack-update-icon-wrap.has-url')) return;
                    const stackName = row.dataset.stack;
                    const ep = row.dataset.endpoint;
                    const isUpdating = row.dataset.needsPolling === 'true' || row.dataset.checkingServices === 'true';
                    logsActiveTab = 'logs';
                    activateLogsMode();
                    if (isUpdating) window._dockme_force_badge = 'deploying';
                    setTimeout(() => openLogsForStack(stackName, ep), 100);
                });
            });
            
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
            ensureTitleIsCorrect();
            MobileMenu.close();
            MobileMenu.ensureToggle();

            if (RouteManager.isSetupPath()) {
                forceSetupLanguageES();
                replaceSetupBranding();
            }
            if (RouteManager.isRootPath()) {
                hideDockgeHomeBlock();
                ensureDockmeRoot();
                // Si modo logs activo, ocultar bloques nativos de Dockge inmediatamente
                if (document.body.classList.contains('dockme-logs-mode')) {
                    document.querySelectorAll('.main > *:not(#dockme-dashboard), .container-fluid > *:not(#dockme-dashboard)').forEach(el => {
                        if (el.id !== 'dockme-dashboard') el.style.visibility = 'hidden';
                    });
                }
                readAgentsFromDockgeDOM();
                const tryLoadDashboard = (attemptsLeft) => {
                    Promise.all([loadStacksConfig(), loadLinksConfig()]).then(() => {
                        if (!State.settingsData?.centralUrl) {
                            MetricsManager.ensureContainer();
                        }
                        const dashboard = ensureDockmeRoot();
                        if (dashboard) {
                            if (!document.body.classList.contains('dockme-logs-mode')) {
                                DataLoader.loadAndDisplay();
                            }
                            if (!State.settingsData?.centralUrl && !document.body.classList.contains('dockme-logs-mode')) MetricsManager.start();
                            // Si el modo logs estaba activo, restaurarlo
                            if (document.body.classList.contains('dockme-logs-mode')) {
                                setTimeout(() => {
                                    // Restaurar visibilidad de elementos ocultos
                                    document.querySelectorAll('.main > *:not(#dockme-dashboard), .container-fluid > *:not(#dockme-dashboard)').forEach(el => {
                                        el.style.visibility = '';
                                    });
                                    const blocksRow = document.querySelector('#dockme-blocks-row');
                                    if (blocksRow) blocksRow.style.display = 'none';
                                    MetricsManager.stop();

                                    // Asegurar que el panel existe
                                    let panel = document.querySelector('#dockme-logs-panel');
                                    if (!panel) {
                                        const dashboard = document.querySelector('#dockme-dashboard');
                                        panel = document.createElement('div');
                                        panel.id = 'dockme-logs-panel';
                                        dashboard?.appendChild(panel);
                                    }
                                    panel.style.display = '';
                                }, 600);
                            }
                        } else if (attemptsLeft > 0) {
                            setTimeout(() => tryLoadDashboard(attemptsLeft - 1), 200);
                        }
                    });
                };
                setTimeout(() => tryLoadDashboard(10), 100);
            } else {
                MetricsManager.stop();
            }
        },
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
            const [updatesData, sourcesData, settingsData] = await Promise.all([
                API.loadUpdates(),
                API.loadSources(),
                API.loadSettings()
            ]);
            State.settingsData = settingsData;
            // primaryHost viene de settings.json
            if (settingsData?.primaryHost) {
                primaryHostLocal = settingsData.primaryHost;
            }
            State.setUpdatesData(updatesData);
            State.setSourcesData(sourcesData);
            if (Array.isArray(updatesData) && updatesData.length > 0) {
                const localHost = updatesData.find(h =>
                    h.endpoint?.toLowerCase() === 'actual'
                ) || updatesData[0];

                if (localHost?.hostname) {
                    State.setLocalHostname(localHost.hostname);
                }
            }
            this.loaded = true;
            RouteObserver.handleRouteChange(window.location.pathname);

            // TODO: eliminar en v3.1 — avisar variables obsoletas en el compose (solo una vez)
            if (!settingsData?.centralUrl) setTimeout(() => checkDeprecatedVars(), 2000);

            // Bloqueo UI agente remoto
            if (!!settingsData?.centralUrl) {
                applyAgentMode(settingsData.centralUrl || '');
            }
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
    function openNewStackPanel() {
        // Activar modo logs si no está activo
        if (!document.body.classList.contains('dockme-logs-mode')) {
            activateLogsMode();
        }

        const panel = document.querySelector('#dockme-logs-panel');
        if (!panel) return;

        // Cerrar SSE si hay
        if (logsEventSource) { logsEventSource.close(); logsEventSource = null; }
        if (window._logsStatusInterval) { clearInterval(window._logsStatusInterval); window._logsStatusInterval = null; }
        logsCurrentStack = null;
        logsCurrentEndpoint = null;

        // Obtener lista de servidores disponibles
        const servers = [{ name: 'Local', endpoint: 'Actual' }];
        (State.updatesDataGlobal || []).forEach(h => {
            if ((h.endpoint || 'Actual').toLowerCase() !== 'actual') {
                servers.push({ name: h.hostname || h.endpoint, endpoint: h.endpoint });
            }
        });
        const serverOptions = servers.map(s =>
            `<option value="${s.endpoint}">${s.name}</option>`
        ).join('');

        const defaultCompose = `services:\n  nginx:\n    image: nginx:latest\n    container_name: nginx\n    restart: unless-stopped\n`;
        const createBtnHTML = `<svg class="svg-inline--fa" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512" style="width:0.875em;height:1em;margin-right:5px;"><path fill="currentColor" d="M256 80c0-17.7-14.3-32-32-32s-32 14.3-32 32V224H48c-17.7 0-32 14.3-32 32s14.3 32 32 32H192V432c0 17.7 14.3 32 32 32s32-14.3 32-32V288H400c17.7 0 32-14.3 32-32s-14.3-32-32-32H256V80z"/></svg> Crear y Desplegar`;

        panel.innerHTML = `
            <div id="logs-header-bar">
                <div class="logs-header-row1">
                    <div class="logs-stack-info">
                        <span class="logs-stack-name" id="new-stack-title">Nuevo Stack</span>
                        <span class="logs-stack-sep" id="new-stack-title-sep" style="display:none;">&mdash;</span>
                        <span class="logs-stack-host" id="new-stack-title-host" style="display:none;"></span>
                    </div>
                </div>
                <div class="logs-header-row2">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <button class="btn btn-normal logs-action-btn btn-back-dashboard" id="new-stack-back" title="Volver al dashboard">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                        </button>
                    </div>
                    <div></div>
                </div>
            </div>
            <div style="display:flex;flex-direction:column;flex:1;min-height:0;gap:10px;padding:12px 0;">
                <div style="display:flex;gap:12px;align-items:flex-end;flex-shrink:0;">
                    <div style="display:flex;flex-direction:column;gap:4px;">
                        <label style="font-size:0.82em;color:#888;">Nombre del stack</label>
                        <input id="new-stack-name" type="text" class="form-control" placeholder="mi-stack" style="width:220px;border-color:#ef5350;" autocomplete="off">
                    </div>
                    <div id="new-stack-server-wrap" style="display:flex;flex-direction:column;gap:4px;${servers.length <= 1 ? 'display:none;' : ''}">
                        <label style="font-size:0.82em;color:#888;">Servidor</label>
                        <select id="new-stack-server" class="form-control" style="width:180px;">${serverOptions}</select>
                    </div>
                    <div id="new-stack-error" style="color:#ef5350;padding-left:6px;padding-bottom:6px;display:none;"></div>
                </div>
                <div id="new-stack-compose-wrap" style="flex:1;min-height:0;overflow:hidden;background:#0d1117;border:1px solid #2a3441;border-radius:8px 8px 0 0;"></div>
                <div style="height:22px;background:#1a2535;">
                    <div style="display:flex;gap:3px;align-items:center;">
                        <span style="width:20px;height:2px;background:#4f84c8;"></span>
                        <span style="color:#4f84c8;">⚙️ .env</span>
                        <span style="height:2px;background:#4f84c8;flex:1;"></span>
                    </div>
                </div>
                <div id="new-stack-env-wrap" style="height:80px;overflow:hidden;background:#0d1117;border:1px solid #2a3441;border-top:none;border-radius:0 0 8px 8px;width:100%;"></div>
            </div>
            <div style="display:flex;align-items:center;justify-content:flex-start;gap:8px;padding:6px 12px;background:#1c2431;border:1px solid #2a3441;border-radius:8px;flex-shrink:0;margin-top:4px;">
                <button class="btn btn-primary" id="new-stack-create">__CREATE_BTN__</button>
            </div>
        `;

        panel.querySelector('#new-stack-create').innerHTML = createBtnHTML;

        // Focus en el nombre
        setTimeout(() => panel.querySelector('#new-stack-name')?.focus(), 100);

        // Actualizar título dinámicamente
        const titleEl     = panel.querySelector('#new-stack-title');
        const titleSep    = panel.querySelector('#new-stack-title-sep');
        const titleHost   = panel.querySelector('#new-stack-title-host');
        const nameInput   = panel.querySelector('#new-stack-name');
        const serverSel   = panel.querySelector('#new-stack-server');

        const updateTitle = () => {
            const raw  = nameInput.value.trim();
            const name = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'Nuevo Stack';
            const ep   = serverSel.value;
            const host = servers.find(s => s.endpoint === ep)?.name || ep;
            titleEl.textContent = name;
            if (ep !== 'Actual') {
                titleSep.style.display = '';
                titleHost.style.display = '';
                titleHost.textContent = host;
            } else {
                titleSep.style.display = 'none';
                titleHost.style.display = 'none';
            }
        };

        nameInput.addEventListener('input', () => {
            updateTitle();
            nameInput.style.borderColor = nameInput.value.trim() ? '' : '#ef5350';
        });
        serverSel.addEventListener('change', updateTitle);

        // Validar y limpiar nombre al salir del input
        nameInput.addEventListener('blur', () => {
            let val = nameInput.value.trim().toLowerCase();
            val = val.replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
            nameInput.value = val;
            nameInput.style.borderColor = val ? '' : '#ef5350';
            if (!val) {
                errorEl.textContent = '⚠️ El nombre es obligatorio';
                errorEl.style.display = '';
            } else {
                errorEl.style.display = 'none';
            }
            updateTitle();
        });

        // Enter en nombre → foco al compose con todo seleccionado
        nameInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            let val = nameInput.value.trim().toLowerCase();
            val = val.replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
            nameInput.value = val;
            nameInput.style.borderColor = val ? '' : '#ef5350';
            updateTitle();
            if (!val) return;
            setTimeout(() => {
                if (cmNew?.focus) {
                    cmNew.focus();
                    cmNew.execCommand?.('selectAll');
                }
            }, 50);
        });

        // Botón volver
        panel.querySelector('#new-stack-back').addEventListener('click', () => {
            deactivateLogsMode();
        });

        // Cargar CodeMirror si no está
        const initEditor = () => {
            const wrap = panel.querySelector('#new-stack-compose-wrap');
            const envWrap = panel.querySelector('#new-stack-env-wrap');
            const errorEl = panel.querySelector('#new-stack-error');
            const createBtn = panel.querySelector('#new-stack-create');
            let cmNew = null;
            if (window.CodeMirror) {
                const opts = {
                    value: defaultCompose,
                    mode: 'yaml',
                    theme: 'dracula',
                    lineNumbers: true,
                    lineWrapping: true,
                    tabSize: 2,
                    indentWithTabs: false,
                    extraKeys: { Tab: (cm) => cm.execCommand('insertSoftTab') },
                };
                if (window.jsyaml) {
                    opts.lint = true;
                    opts.gutters = ['CodeMirror-lint-markers'];
                }
                cmNew = window.CodeMirror(wrap, opts);
                cmNew.setSize('100%', '100%');
                // Validación en tiempo real
                if (window.jsyaml) {
                    cmNew.on('change', (cm, change) => {
                        // Sanitizar tabs al pegar o escribir
                        const val = cm.getValue();
                        if (val.includes('\t')) {
                            const cursor = cm.getCursor();
                            cm.setValue(val.replace(/\t/g, '  '));
                            cm.setCursor(cursor);
                        }
                        clearTimeout(cmNew._validateTimer);
                        cmNew._validateTimer = setTimeout(() => {
                            try {
                                window.jsyaml.load(cmNew.getValue());
                                wrap.style.borderColor = '#2a3441';
                                if (createBtn) createBtn.disabled = false;
                                // Limpiar error YAML si no hay otro error activo
                                if (errorEl.dataset.yamlError) {
                                    errorEl.style.display = 'none';
                                    delete errorEl.dataset.yamlError;
                                }
                            } catch (e) {
                                wrap.style.borderColor = '#ef5350';
                                if (createBtn) createBtn.disabled = true;
                                errorEl.textContent = `⚠️ ${e.reason || e.message}`;
                                errorEl.style.display = '';
                                errorEl.dataset.yamlError = '1';
                            }
                        }, 400);
                    });
                }
            } else {
                const ta = document.createElement('textarea');
                ta.value = defaultCompose;
                ta.style.cssText = 'width:100%;height:100%;background:transparent;color:#ccc;border:none;outline:none;resize:none;padding:12px;font-family:"Courier New",monospace;font-size:0.85em;';
                wrap.appendChild(ta);
                cmNew = ta;
            }
            // Editor .env
            let cmEnvNew = null;
            if (window.CodeMirror && envWrap) {
                cmEnvNew = window.CodeMirror(envWrap, {
                    value: '',
                    mode: 'shell',
                    theme: 'dracula',
                    lineNumbers: true,
                    lineWrapping: true,
                    tabSize: 2,
                    indentWithTabs: false,
                    placeholder: '# Variables de entorno\n# VARIABLE=valor',
                });
                cmEnvNew.setSize('100%', '80px');
            }
            return { cmNew, cmEnvNew };
        };

        let cmNew = null;
        let cmEnvNew = null;
        if (window.CodeMirror) {
            ({ cmNew, cmEnvNew } = initEditor());
        } else {
            // Cargar CodeMirror
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css';
            document.head.appendChild(link);
            const linkTheme = document.createElement('link');
            linkTheme.rel = 'stylesheet';
            linkTheme.href = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/theme/dracula.min.css';
            document.head.appendChild(linkTheme);
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js';
            script.onload = () => {
                const scriptYaml = document.createElement('script');
                scriptYaml.src = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/yaml/yaml.min.js';
                scriptYaml.onload = () => {
                    // Cargar js-yaml y lint si no están
                    let loaded = 0;
                    const tryInit = () => { if (++loaded === 2) ({ cmNew, cmEnvNew } = initEditor()); };
                    if (!window.jsyaml) {
                        const sJsYaml = document.createElement('script');
                        sJsYaml.src = 'https://cdnjs.cloudflare.com/ajax/libs/js-yaml/4.1.0/js-yaml.min.js';
                        sJsYaml.onload = tryInit;
                        document.head.appendChild(sJsYaml);
                    } else { tryInit(); }
                    if (!window.CodeMirror?.helpers?.lint) {
                        const linkLint = document.createElement('link');
                        linkLint.rel = 'stylesheet';
                        linkLint.href = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/lint/lint.min.css';
                        document.head.appendChild(linkLint);
                        const sLint = document.createElement('script');
                        sLint.src = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/lint/lint.min.js';
                        sLint.onload = tryInit;
                        document.head.appendChild(sLint);
                    } else { tryInit(); }
                };
                document.head.appendChild(scriptYaml);
            };
            document.head.appendChild(script);
        }

        // Crear y desplegar
        panel.querySelector('#new-stack-create').addEventListener('click', async () => {
            const errorEl   = panel.querySelector('#new-stack-error');
            const stackName = nameInput.value.trim();
            const endpoint  = serverSel.value;
            const content   = cmNew?.getValue ? cmNew.getValue().replace(/\t/g, '  ') : (cmNew?.value || defaultCompose).replace(/\t/g, '  ');
            const envContent = cmEnvNew?.getValue ? cmEnvNew.getValue() : (cmEnvNew?.value || '');

            if (!stackName) {
                errorEl.textContent = '⚠️ El nombre es obligatorio';
                errorEl.style.display = '';
                nameInput.focus();
                return;
            }
            if (!/^[a-zA-Z0-9_-]+$/.test(stackName)) {
                errorEl.textContent = '⚠️ Solo letras, números, - y _';
                errorEl.style.display = '';
                nameInput.focus();
                return;
            }
            // Validar YAML
            if (window.jsyaml) {
                try { window.jsyaml.load(content); }
                catch (e) {
                    errorEl.textContent = `⚠️ Error YAML: ${e.reason || e.message}`;
                    errorEl.style.display = '';
                    return;
                }
            }

            errorEl.style.display = 'none';
            const btn = panel.querySelector('#new-stack-create');
            btn.disabled = true;
            btn.textContent = 'Verificando...';

            // Verificar que no existe ya ese stack en ese servidor
            const epCheck = endpoint !== 'Actual' ? `?endpoint=${encodeURIComponent(endpoint)}` : '';
            try {
                const check = await fetch(`/api/compose/${encodeURIComponent(stackName)}${epCheck}`);
                const checkData = await check.json();
                if (checkData.success) {
                    errorEl.textContent = `⚠️ El stack "${stackName}" ya existe en este servidor`;
                    errorEl.style.display = '';
                    btn.disabled = false;
                    btn.innerHTML = createBtnHTML;
                    return;
                }
            } catch (_) {} // 404 = no existe, perfecto

            btn.textContent = 'Creando...';

            const epParam = endpoint !== 'Actual' ? `?endpoint=${encodeURIComponent(endpoint)}` : '';
            try {
                const r = await fetch(`/api/create-stack${epParam}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ stack: stackName, content, env: envContent, endpoint })
                });
                const d = await r.json();
                if (!d.success) throw new Error(d.message);
            } catch (e) {
                const msg = e.message?.toLowerCase().includes('fetch') || e.message?.toLowerCase().includes('network') || e.message?.toLowerCase().includes('failed')
                    ? `⚠️ No se puede conectar con el servidor "${servers.find(s=>s.endpoint===endpoint)?.name || endpoint}". Comprueba que el agente está activo.`
                    : `⚠️ ${e.message}`;
                errorEl.textContent = msg;
                errorEl.style.display = '';
                btn.disabled = false;
                btn.innerHTML = createBtnHTML;
                return;
            }

            // Capturar contenido antes de que openLogsForStack destruya el panel
            const composeVal = cmNew?.getValue ? cmNew.getValue() : (cmNew?.value || content);

            // Navegar a logs del nuevo stack y desplegar
            logsActiveTab = 'logs';
            openLogsForStack(stackName, endpoint);
            // Dar tiempo a que el panel se inicialice y lanzar deploy
            setTimeout(async () => {
                const logsArea = document.querySelector('#logs-area');
                if (!logsArea) return;
                if (logsEventSource) { logsEventSource.close(); logsEventSource = null; }
                logsArea.innerHTML = '';
                const epDeploy = endpoint !== 'Actual' ? `?endpoint=${encodeURIComponent(endpoint)}` : '';

                // Registrar en stacks.json e intentar icono siempre, antes del deploy
                autoAssignServiceUrl(stackName, endpoint || 'Actual', composeVal);

                const deploySource = new EventSource(`/api/deploy/${encodeURIComponent(stackName)}${epDeploy}`);
                deploySource.onmessage = (e) => {
                    const line = document.createElement('div');
                    line.className = 'logs-line';
                    line.dataset.raw = e.data;
                    const lower = e.data.toLowerCase();
                    let color = '#888';
                    if (lower.includes('started') || lower.includes('✅')) color = '#4caf50';
                    else if (lower.includes('starting') || lower.includes('pulling') || lower.includes('pulled')) color = '#4f84c8';
                    else if (lower.includes('error') || lower.includes('❌')) color = '#ef5350';
                    line.innerHTML = `<span class="logs-msg" style="color:${color};">${e.data.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span>`;
                    logsArea.appendChild(line);
                    logsArea.scrollTop = logsArea.scrollHeight;
                    if (e.data.includes('✅') || e.data.includes('❌')) {
                        deploySource.close();
                    }
                };
                deploySource.onerror = () => { deploySource.close(); };
            }, 800);
        });
    }

    function openLogsForStack(stackName, endpoint) {
        if (logsEventSource) { logsEventSource.close(); logsEventSource = null; }

        logsCurrentStack    = stackName;
        logsCurrentEndpoint = endpoint;
        RecentManager.add(stackName, endpoint);

        // Timer de inactividad — volver al dashboard tras 10s sin actividad
        const INACTIVITY_MS = 5 * 60 * 1000;
        let inactivityTimer = null;
        const resetInactivity = () => {
            clearTimeout(inactivityTimer);
            inactivityTimer = setTimeout(() => {
                if (document.body.classList.contains('dockme-logs-mode')) {
                    deactivateLogsMode();
                }
            }, INACTIVITY_MS);
        };
        const activityEvents = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
        activityEvents.forEach(ev => document.addEventListener(ev, resetInactivity, { passive: true }));
        resetInactivity();

        // Limpiar timer al salir del modo logs
        const cleanupInactivity = () => {
            clearTimeout(inactivityTimer);
            activityEvents.forEach(ev => document.removeEventListener(ev, resetInactivity));
            document.removeEventListener('dockme-logs-deactivated', cleanupInactivity);
        };
        document.addEventListener('dockme-logs-deactivated', cleanupInactivity, { once: true });

        const panel = document.querySelector('#dockme-logs-panel');
        if (!panel) return;

        // Auto-expandir si el panel de logs quedaría menor de 700px con la lista visible
        if (!document.body.classList.contains('logs-expanded')) {
            const sidebar = document.querySelector('.sidebar, nav.side-nav, .stack-list')?.closest('.col-auto, .col, [class*="col-"]');
            const sidebarWidth = sidebar ? sidebar.offsetWidth : 250;
            const availableWidth = window.innerWidth - sidebarWidth;
            if (availableWidth < 700) {
                document.body.classList.add('logs-expanded');
            }
        }

        const hostEntry = State.updatesDataGlobal?.find(h =>
            h.endpoint.toLowerCase() === (endpoint || 'Actual').toLowerCase()
        );
        const hostname   = hostEntry?.hostname || endpoint || 'Actual';
        const iconUrl    = getStackIconUrl(stackName, endpoint || 'Actual');
        const githubUrl  = getStackRepo(stackName, endpoint || 'Actual');
        const serviceUrl = stacksConfig.find(s =>
            s.name?.toLowerCase() === stackName?.toLowerCase() &&
            s.endpoint?.toLowerCase() === (endpoint || 'Actual').toLowerCase()
        )?.url || '';

        const iconHtml = serviceUrl
            ? `<div class="stack-logo-left has-url" style="width:60px;height:60px;flex-shrink:0;cursor:pointer;" onclick="window.open('${serviceUrl}','_blank')">
                <div class="stack-logo-flip">
                    <div class="logo-front"><img src="${iconUrl}" class="logs-stack-icon" style="width:60px;height:60px;object-fit:contain;" onerror="this.src='/system-icons/no-icon.svg'"></div>
                    <div class="logo-back"></div>
                </div>
               </div>`
            : `<img src="${iconUrl}" class="logs-stack-icon" style="width:60px;height:60px;" onerror="this.src='/system-icons/no-icon.svg'">`;

        panel.innerHTML = `
            <div id="logs-header-bar">
                <div style="display:flex;flex-direction:row;align-items:stretch;gap:inherit;">
                    <div style="display:flex;align-items:center;flex-shrink:0;justify-content:center;width:75px;">
                        ${iconHtml}
                    </div>
                    <div style="display:flex;flex-direction:column;flex:1;min-width:0;gap:6px;">
                        <div class="logs-header-row1">
                            <div class="logs-stack-info">
                                <span class="logs-stack-name">${stackName}</span>
                                <span class="logs-stack-sep">&mdash;</span>
                                <span class="logs-stack-host">${hostname}</span>
                            </div>
                            ${githubUrl ? `<a href="${githubUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-normal" style="display:inline-flex;align-items:center;gap:6px;flex-shrink:0;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>Repositorio de GitHub</a>` : ''}
                        </div>
                        <div class="logs-header-row2">
                            <div style="display:flex;align-items:center;gap:8px;">
                                <button class="btn btn-normal logs-action-btn btn-back-dashboard" id="logs-btn-back" title="Volver al dashboard">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                                </button>
                                <div id="logs-badges"></div>
                            </div>
                            <div class="logs-action-btns">
                                <button class="btn btn-normal logs-action-btn" id="logs-btn-startstop" title="Iniciar/Detener"></button>
                                <button class="btn btn-normal logs-action-btn" id="logs-btn-restart" title="Reiniciar">
                                    <svg class="svg-inline--fa fa-rotate-right" aria-hidden="true" focusable="false" data-prefix="fas" data-icon="rotate-right" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" style="width:0.875em;height:1em;margin-right:5px;"><path fill="currentColor" d="M463.5 224H472c13.3 0 24-10.7 24-24V72c0-9.7-5.8-18.5-14.8-22.2s-19.3-1.7-26.2 5.2L413.4 96.6c-87.6-86.5-228.7-86.2-315.8 1c-87.5 87.5-87.5 229.3 0 316.8s229.3 87.5 316.8 0c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0c-62.5 62.5-163.8 62.5-226.3 0s-62.5-163.8 0-226.3c62.2-62.2 162.7-62.5 225.3-1L327 183c-6.9 6.9-8.9 17.2-5.2 26.2s12.5 14.8 22.2 14.8H463.5z"/></svg>
                                    Reiniciar
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div id="logs-tabs">
                <button class="logs-tab active" data-tab="logs">\uD83D\uDCCB Logs</button>
                <button class="logs-tab" data-tab="compose">\uD83D\uDCC4 Compose</button>
                <button class="logs-tab" data-tab="terminal">\uD83D\uDCBB Terminal</button>
                <button id="logs-expand-btn" title="Expandir" style="position:absolute;top:45px;left:-20px;z-index:10;width:25px;height:30px;border-radius:6px;background:#1c2431;border:2px solid #4f84c8;color:#4f84c8;cursor:pointer;display:flex;align-items:center;justify-content:center;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;"><polyline points="10,3 5,8 10,13"></polyline><polyline points="14,3 9,8 14,13"></polyline></svg></button>
            </div>
            <div id="logs-area"></div>
            <div id="compose-area" style="display:none;flex:1;flex-direction:column;min-height:0;position:relative;">
                <div id="compose-editor-wrap" style="flex:1;min-height:0;overflow:hidden;background:#0d1117;border:1px solid #2a3441;border-radius:8px 8px 0 0;width:100%;"></div>
                <div id="compose-resize-handle" style="height:22px;background:#1a2535;cursor:row-resize;">
                    <div style="display:flex;gap:3px;align-items:center;">
                        <span style="width:20px;height:2px;background:#4f84c8;"></span>
                        <span style="color:#4f84c8;">⚙️ .env</span>
                        <span style="height:2px;background:#4f84c8;flex:1;"></span>
                    </div>
                </div>
                <div id="env-editor-wrap" style="overflow:hidden;background:#0d1117;border:1px solid #2a3441;border-top:none;border-radius:0 0 8px 8px;width:100%;"></div>
            </div>
            </div>
            <div id="logs-footer-bar">
                <div class="logs-filter-wrap">
                        <input type="text" id="logs-filter" class="profile-bar-input" placeholder="Filtrar...">
                        <button id="logs-filter-clear" class="logs-filter-clear-btn" style="display:none">×</button>
                    </div><div class="logs-footer-controls">
                    
                    <label class="logs-autoscroll-wrap">
                        <span class="logs-autoscroll-label">Hora</span>
                        <label class="general-toggle">
                            <input type="checkbox" id="logs-show-ts" checked="">
                            <span class="general-toggle-slider"></span>
                        </label>
                    </label><label class="logs-autoscroll-wrap">
                        <span class="logs-autoscroll-label">Auto</span>
                        <label class="general-toggle">
                            <input type="checkbox" id="logs-autoscroll" checked="">
                            <span class="general-toggle-slider"></span>
                        </label>
                    </label><div class="logs-controls-sep"></div><button class="btn btn-normal" id="logs-clear">🗑 Limpiar</button>
                </div>
            </div>
            <div id="terminal-area" style="display:none;flex:1;flex-direction:column;min-height:0;gap:0;">
                <div id="terminal-xterm-wrap" style="flex:1;min-height:0;background:#0d1117;border:1px solid #2a3441;border-radius:8px 8px 0 0;overflow:hidden;padding:12px;"></div>
                <div id="terminal-footer" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px;background:#1c2431;border:1px solid #2a3441;border-top:none;border-radius:0 0 8px 8px;flex-shrink:0;">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <div id="terminal-container-wrap" style="display:none;align-items:center;gap:6px;">
                            <label style="font-size:0.82em;color:#888;white-space:nowrap;">Contenedor</label>
                            <select id="terminal-container-select" class="form-control" style="width:180px;padding:3px 8px;font-size:0.82em;"></select>
                        </div>
                    </div>
                    <button class="btn btn-normal" id="terminal-shell-btn" style="padding:3px 10px;font-size:0.82em;">Reconectar con sh</button>
                </div>
            </div>
            <div id="compose-footer-bar" style="display:none;">
                <div class="logs-footer-controls" style="justify-content:flex-start;gap:8px;flex-wrap:wrap;">
                    <button class="btn btn-normal" id="compose-btn-edit">
                        <svg class="svg-inline--fa" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" style="width:0.875em;height:1em;margin-right:5px;"><path fill="currentColor" d="M471.6 21.7c-21.9-21.9-57.3-21.9-79.2 0L362.3 51.7l97.9 97.9 30.1-30.1c21.9-21.9 21.9-57.3 0-79.2L471.6 21.7zm-299.2 220c-6.1 6.1-10.8 13.6-13.5 21.9l-29.6 88.8c-2.9 8.6-.6 18.1 5.8 24.6s15.9 8.7 24.6 5.8l88.8-29.6c8.2-2.7 15.7-7.4 21.9-13.5L437.7 172.3 339.7 74.3 172.4 241.7zM96 64C43 64 0 107 0 160V416c0 53 43 96 96 96H352c53 0 96-43 96-96V320c0-17.7-14.3-32-32-32s-32 14.3-32 32v96c0 17.7-14.3 32-32 32H96c-17.7 0-32-14.3-32-32V160c0-17.7 14.3-32 32-32h96c17.7 0 32-14.3 32-32s-14.3-32-32-32H96z"/></svg>
                        Editar
                    </button>
                    <button class="btn btn-normal" id="compose-btn-cancel" style="display:none;">✕ Cancelar</button>
                    <button class="btn btn-normal" id="compose-btn-save" style="display:none;">
                        <svg class="svg-inline--fa" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512" style="width:0.875em;height:1em;margin-right:5px;"><path fill="currentColor" d="M64 32C28.7 32 0 60.7 0 96V416c0 35.3 28.7 64 64 64H384c35.3 0 64-28.7 64-64V173.3c0-17-6.7-33.3-18.7-45.3L352 50.7C340 38.7 323.7 32 306.7 32H64zm0 96c0-17.7 14.3-32 32-32H288c17.7 0 32 14.3 32 32v64c0 17.7-14.3 32-32 32H96c-17.7 0-32-14.3-32-32V128zM224 288a64 64 0 1 1 0 128 64 64 0 1 1 0-128z"/></svg>
                        Guardar
                    </button>
                    <button class="btn btn-primary" id="compose-btn-deploy" style="display:none;">
                        <svg class="svg-inline--fa" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" style="width:0.875em;height:1em;margin-right:5px;"><path fill="currentColor" d="M156.6 384.9L125.7 354c-8.5-8.5-11.5-20.8-7.7-32.2l22-63.9-44.9-44.9-9.9 7.4c-14.7 11-21.2 28.2-18.1 45.6l21.1 118.2c2.2 12.5 9.3 23.6 19.6 31.2l87.7 63.1c10.9 7.9 25.9 7.9 36.8 0l87.7-63.1c10.4-7.5 17.4-18.6 19.6-31.2l21.1-118.2c3.1-17.4-3.4-34.6-18.1-45.6l-9.9-7.4-44.9 44.9 22 63.9c3.8 11.4.8 23.7-7.7 32.2L355.4 384.9l-99.4 71.6-99.4-71.6zM416 32L32 32C14.3 32 0 46.3 0 64v128c0 17.7 14.3 32 32 32h384c17.7 0 32-14.3 32-32V64c0-17.7-14.3-32-32-32zM64 112a16 16 0 1 1 32 0 16 16 0 1 1 -32 0z"/></svg>
                        Desplegar
                    </button>
                    <span class="compose-running-warning" style="display:none;color:#ffa726;font-size:0.85em;align-self:center;"></span>
                </div>
                <div style="display:flex;gap:8px;">
                    <button class="btn btn-normal" id="compose-btn-pause">
                        <svg class="svg-inline--fa" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512" style="width:0.75em;height:1em;margin-right:5px;"><path fill="currentColor" d="M0 128C0 92.7 28.7 64 64 64H320c35.3 0 64 28.7 64 64V384c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V128z"/></svg>
                        Desactivar
                    </button>
                    <button class="btn btn-danger" id="compose-btn-delete">
                        <svg class="svg-inline--fa" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512" style="width:0.75em;height:1em;margin-right:5px;"><path fill="currentColor" d="M135.2 17.7C140.6 6.8 151.7 0 163.8 0H284.2c12.1 0 23.2 6.8 28.6 17.7L320 32h96c17.7 0 32 14.3 32 32s-14.3 32-32 32H32C14.3 96 0 81.7 0 64S14.3 32 32 32h96l7.2-14.3zM32 128H416V448c0 35.3-28.7 64-64 64H96c-35.3 0-64-28.7-64-64V128zm96 64c-8.8 0-16 7.2-16 16V432c0 8.8 7.2 16 16 16s16-7.2 16-16V208c0-8.8-7.2-16-16-16zm96 0c-8.8 0-16 7.2-16 16V432c0 8.8 7.2 16 16 16s16-7.2 16-16V208c0-8.8-7.2-16-16-16zm96 0c-8.8 0-16 7.2-16 16V432c0 8.8 7.2 16 16 16s16-7.2 16-16V208c0-8.8-7.2-16-16-16z"/></svg>
                        Eliminar
                    </button>
                </div>
            </div>
        `;

        const filterInput  = panel.querySelector('#logs-filter');
        const filterClear  = panel.querySelector('#logs-filter-clear');
        const autoToggle   = panel.querySelector('#logs-autoscroll');
        const clearBtn     = panel.querySelector('#logs-clear');
        const logsArea     = panel.querySelector('#logs-area');
        const btnBack      = panel.querySelector('#logs-btn-back');
        const btnStartStop = panel.querySelector('#logs-btn-startstop');
        const cmpBtnEdit   = panel.querySelector('#compose-btn-edit');

        btnBack.addEventListener('click', () => {
            deactivateLogsMode();
        });
        const btnRestart   = panel.querySelector('#logs-btn-restart');
        // Botones start/stop y restart via socket de Dockge
        const getSocket = () => document.querySelector('#app')?._vnode?.component?.root?.proxy?.getSocket();
        const ep = (endpoint && endpoint.toLowerCase() !== 'actual') ? endpoint : '';

        let stackIsRunning = false; // se actualiza con el polling

        const svgRestartBtn = `<svg class="svg-inline--fa fa-rotate-right" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" style="width:0.875em;height:1em;margin-right:5px;"><path fill="currentColor" d="M463.5 224H472c13.3 0 24-10.7 24-24V72c0-9.7-5.8-18.5-14.8-22.2s-19.3-1.7-26.2 5.2L413.4 96.6c-87.6-86.5-228.7-86.2-315.8 1c-87.5 87.5-87.5 229.3 0 316.8s229.3 87.5 316.8 0c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0c-62.5 62.5-163.8 62.5-226.3 0s-62.5-163.8 0-226.3c62.2-62.2 162.7-62.5 225.3-1L327 183c-6.9 6.9-8.9 17.2-5.2 26.2s12.5 14.8 22.2 14.8H463.5z"/></svg> Reiniciar`;

        const waitForStateChange = (targetRunning) => {
            const socket = document.querySelector('#app')?._vnode?.component?.root?.proxy?.getSocket();
            if (!socket) return;
            const check = setInterval(() => {
                socket.emit('agent', ep, 'serviceStatusList', stackName, (res) => {
                    if (!res?.ok || !res.serviceStatusList) return;
                    const services = Object.entries(res.serviceStatusList);
                    const anyRunning = services.some(([, s]) =>
                        s.state === 'running' || s.state === 'healthy'
                    );
                    const allStopped = services.length === 0 || services.every(([, s]) =>
                        s.state === 'exited' || s.state === 'stopped'
                    );
                    // Si el estado ya coincide con lo esperado, reanudar
                    if ((targetRunning && anyRunning) || (!targetRunning && allStopped)) {
                        clearInterval(check);
                        actionInProgress = false;
                        setButtonsDisabled(false);
                        if (btnRestart) btnRestart.innerHTML = svgRestartBtn;
                        renderBadges(services);
                        // Si vuelve a running, mostrar btnPause y reanudar polling si estaba parado
                        if (targetRunning && anyRunning) {
                            
                            if (!logsStatusInterval) startStatusPolling();
                            // Refrescar puertos tras deploy exitoso
                            fetch(`/api/stack-containers/${encodeURIComponent(stackName)}${epParam}`)
                                .then(r => r.json())
                                .then(d => {
                                    if (d.containers?.length > 0) {
                                        window._dockme_ports = {};
                                        window._dockme_containers = {};
                                        d.containers.forEach(c => {
                                            const key = c.service || c.name;
                                            window._dockme_ports[key] = c.ports || [];
                                            window._dockme_containers[key] = c.name;
                                        });
                                        renderBadges(lastKnownServices);
                                    }
                                }).catch(() => {});
                            // Reconectar logs si el tab activo es logs
                            if (logsActiveTab === 'logs') {
                                if (logsEventSource) { logsEventSource.close(); logsEventSource = null; }
                                const sseEpParam = ep ? `&endpoint=${encodeURIComponent(endpoint)}` : '';
                                logsEventSource = new EventSource(`/api/logs/${encodeURIComponent(stackName)}?tail=50${sseEpParam}`);
                                logsEventSource.onmessage = (e) => {
                                    const line = buildLine(e.data, filterInput.value);
                                    logsArea.appendChild(line);
                                    if (logsAutoScroll) logsArea.scrollTop = logsArea.scrollHeight;
                                };
                                logsEventSource.onerror = () => {
                                    const errLine = document.createElement('div');
                                    errLine.className = 'logs-error-line';
                                    errLine.dataset.raw = '';
                                    errLine.textContent = '\u26A0\uFE0F Conexi\u00F3n perdida con el servidor de logs';
                                    logsArea.appendChild(errLine);
                                    if (logsAutoScroll) logsArea.scrollTop = logsArea.scrollHeight;
                                };
                            }
                        }
                    }
                });
            }, 2000);
            // Timeout de seguridad: 2 minutos
            setTimeout(() => {
                clearInterval(check);
                actionInProgress = false;
                setButtonsDisabled(false);
                if (btnRestart) btnRestart.innerHTML = svgRestartBtn;
            }, 2 * 60 * 1000);
        };

        btnStartStop.addEventListener('click', () => {
            const socket = getSocket();
            if (!socket) return;
            const action = stackIsRunning ? 'stopStack' : 'startStack';
            const forceState = stackIsRunning ? 'stopping' : 'starting';
            const targetRunning = !stackIsRunning;
            actionInProgress = true;
            setButtonsDisabled(true);
            btnStartStop.innerHTML = svgSpin;
            renderBadges(lastKnownServices, forceState);
            socket.emit('agent', ep, action, stackName, () => {});
            waitForStateChange(targetRunning);
        });

        btnRestart.addEventListener('click', () => {
            const socket = getSocket();
            if (!socket) return;
            actionInProgress = true;
            setButtonsDisabled(true);
            btnRestart.innerHTML = svgSpin;
            renderBadges(lastKnownServices, 'restarting');
            socket.emit('agent', ep, 'restartStack', stackName, () => {});
            waitForStateChange(true);
        });

        // Número de contenedores para decidir si mostrar el nombre
        let multiContainer = false;

        // Leer estado del stack desde el cp-circle de la lista de Dockge
        const getDockgeStackColor = () => {
            const composePath = endpoint && endpoint.toLowerCase() !== 'actual'
                ? `/compose/${stackName}/${endpoint}`
                : `/compose/${stackName}`;
            const item = document.querySelector(`a.item[href="${composePath}"]`);
            return item?.querySelector('.cp-circle')?.dataset.colorEstado || null;
        };

        const epParam = (endpoint && endpoint.toLowerCase() !== 'actual')
            ? `?endpoint=${encodeURIComponent(endpoint)}` : '';
        fetch(`/api/stack-containers/${encodeURIComponent(stackName)}${epParam}`)
            .then(r => r.json())
            .then(d => {
                multiContainer = (d.containers?.length || 0) > 1;
                if (d.containers?.length > 0) {
                    lastKnownServices = d.containers.map(c => [c.service || c.name, { state: c.state || 'exited' }]);
                    // Guardar puertos y container name por nombre de servicio
                    window._dockme_ports = {};
                    window._dockme_containers = {};
                    d.containers.forEach(c => {
                        const key = c.service || c.name;
                        window._dockme_ports[key] = c.ports || [];
                        window._dockme_containers[key] = c.name;
                    });
                    // Renderizar badges iniciales con estado real de todos los contenedores
                    renderBadges(lastKnownServices);
                } else {
                    stackIsRunning = false;
                    if (btnStartStop) btnStartStop.innerHTML = svgPlay;
                    // Distinguir inactivo (gris) de parado (rojo)
                    const color = getDockgeStackColor();
                    if (color === 'gray') {
                        badgesEl.innerHTML = `<span class="badge bg-secondary" style="font-size:0.82em;font-weight:400;padding:4px 8px;">Inactivo</span>`;
                        
                    } else {
                        // Stack parado (rojo) — mostrar badge exited
                        badgesEl.innerHTML = `<span class="badge bg-danger" style="font-size:0.82em;font-weight:400;padding:4px 8px;">Stack detenido</span>`;
                    }
                }
            })
            .catch(() => { multiContainer = true; });

        // Escapar HTML
        const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

        // Resaltar término en texto ya escapado
        const highlight = (text, term) => {
            if (!term) return text;
            const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'gi');
            return text.replace(re, m => `<span class="logs-highlight">${m}</span>`);
        };

        // Crear línea DOM a partir de raw SSE
        const buildLine = (raw, filterVal) => {
            const line = document.createElement('div');
            line.className = 'logs-line';
            line.dataset.raw = raw;

            const match = raw.match(/^(\S+)\s+\|\s+(\S+Z)\s+([\s\S]*)$/);
            if (match) {
                const container = match[1];
                const tsRaw     = match[2];
                const msg       = match[3];
                const d  = new Date(tsRaw);
                const ts = isNaN(d) ? tsRaw : d.toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit', second:'2-digit' });

                const escapedMsg = esc(msg);
                const highlightedMsg = highlight(escapedMsg, filterVal);
                // Siempre generamos logs-cn — CSS decide si mostrarlo
                const cnClass = multiContainer ? 'logs-cn' : 'logs-cn logs-cn-single';
                if (!multiContainer) line.classList.add('logs-single-cn');
                line.innerHTML =
                    `<span class="logs-ts">${ts}&nbsp;</span>` +
                    `<span class="${cnClass}">${esc(container)}&nbsp;</span>` +
                    `<span class="logs-msg">${highlightedMsg}</span>`;
            } else {
                line.innerHTML = `<span class="logs-msg">${highlight(esc(raw), filterVal)}</span>`;
            }

            if (filterVal && !raw.toLowerCase().includes(filterVal.toLowerCase())) {
                line.style.display = 'none';
            }
            return line;
        };

        // Re-aplicar filtro + highlight a todas las líneas existentes
        const applyFilter = (val) => {
            filterClear.style.display = val ? '' : 'none';
            logsArea.querySelectorAll('.logs-line').forEach(line => {
                const raw = line.dataset.raw || '';
                const match = raw.match(/^(\S+)\s+\|\s+(\S+Z)\s+([\s\S]*)$/);
                if (match) {
                    const container = match[1];
                    const tsRaw     = match[2];
                    const msg       = match[3];
                    const d  = new Date(tsRaw);
                    const ts = isNaN(d) ? tsRaw : d.toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
                    const cnClass = line.classList.contains('logs-single-cn') ? 'logs-cn logs-cn-single' : 'logs-cn';
                    line.innerHTML =
                        `<span class="logs-ts">${ts}&nbsp;</span>` +
                        `<span class="${cnClass}">${esc(container)}&nbsp;</span>` +
                        `<span class="logs-msg">${highlight(esc(msg), val)}</span>`;
                } else {
                    line.innerHTML = `<span class="logs-msg">${highlight(esc(raw), val)}</span>`;
                }
                line.style.display = (val && !raw.toLowerCase().includes(val.toLowerCase())) ? 'none' : '';
            });
        };

        autoToggle.addEventListener('change', () => { logsAutoScroll = autoToggle.checked; });

        const tsToggle = panel.querySelector('#logs-show-ts');
        tsToggle.addEventListener('change', () => {
            document.body.classList.toggle('logs-hide-ts', !tsToggle.checked);
        });

        const expandBtn = panel.querySelector('#logs-expand-btn');
        const svgExpand  = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="10,3 5,8 10,13"/><polyline points="14,3 9,8 14,13"/></svg>`;
        const svgCollapse = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6,3 11,8 6,13"/><polyline points="2,3 7,8 2,13"/></svg>`;
        expandBtn.addEventListener('click', () => {
            const expanded = document.body.classList.toggle('logs-expanded');
            expandBtn.title = expanded ? 'Contraer' : 'Expandir';
            expandBtn.innerHTML = expanded ? svgCollapse : svgExpand;
        });

        filterInput.addEventListener('input', () => applyFilter(filterInput.value));

        filterClear.addEventListener('click', () => {
            filterInput.value = '';
            applyFilter('');
        });

        clearBtn.addEventListener('click', () => { logsArea.innerHTML = ''; });

        // ── Tabs ──
        const composeArea        = panel.querySelector('#compose-area');
        const composeEditorWrap  = panel.querySelector('#compose-editor-wrap');
        const envEditorWrap      = panel.querySelector('#env-editor-wrap');
        const resizeHandle       = panel.querySelector('#compose-resize-handle');
        const logsFooter         = panel.querySelector('#logs-footer-bar');
        const composeFooter      = panel.querySelector('#compose-footer-bar');
        const btnDeploy          = panel.querySelector('#compose-btn-deploy');
        const btnSave            = panel.querySelector('#compose-btn-save');
        const btnCancel          = panel.querySelector('#compose-btn-cancel');
        const btnPause           = panel.querySelector('#compose-btn-pause');
        const btnDelete          = panel.querySelector('#compose-btn-delete');

        let composeContent  = '';
        let envContent      = '';
        let composeEditing  = false;
        let cmCompose       = null;
        let cmEnv           = null;

        const LINE_H = 21; // altura aproximada por línea en CodeMirror
        const ENV_MIN_LINES = 1;
        const ENV_MAX_LINES = 8;

        const applySplit = () => {
            const totalH = composeArea.clientHeight;
            const handleH = 10;
            const envLines = Math.min(ENV_MAX_LINES, Math.max(ENV_MIN_LINES, (envContent || '').split('\n').length));
            const envH = envLines * LINE_H + 24; // padding
            const compH = Math.max(60, totalH - handleH - envH);
            composeEditorWrap.style.height = compH + 'px';
            envEditorWrap.style.height     = envH + 'px';
            if (cmCompose?.setSize) cmCompose.setSize('100%', compH);
            if (cmEnv?.setSize)     cmEnv.setSize('100%', envH);
        };

        // Drag resize manual
        resizeHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startY   = e.clientY;
            const startEnvH = envEditorWrap.clientHeight;
            const startCompH = composeEditorWrap.clientHeight;
            const onMove = (ev) => {
                const delta = startY - ev.clientY; // arrastrar arriba = env más grande
                const newEnvH  = Math.max(LINE_H + 8, Math.min(startEnvH + delta, startEnvH + startCompH - 60));
                const newCompH = startCompH + startEnvH - newEnvH;
                composeEditorWrap.style.height = newCompH + 'px';
                envEditorWrap.style.height     = newEnvH + 'px';
                if (cmCompose?.setSize) cmCompose.setSize('100%', newCompH);
                if (cmEnv?.setSize)     cmEnv.setSize('100%', newEnvH);
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        const epParam2 = (endpoint && endpoint.toLowerCase() !== 'actual')
            ? `?endpoint=${encodeURIComponent(endpoint)}` : '';

        const makeEditor = (container, content, editable, mode) => {
            container.innerHTML = '';
            let ed;
            if (window.CodeMirror) {
                const options = {
                    value: content,
                    mode: mode || null,
                    theme: 'dracula',
                    lineNumbers: true,
                    readOnly: editable ? false : true,
                    lineWrapping: true,
                    tabSize: 2,
                    indentWithTabs: false,
                    extraKeys: { Tab: (cm) => cm.execCommand('insertSoftTab') },
                };
                // Activar lint solo en yaml y en modo edición
                if (mode === 'yaml' && editable && window.jsyaml) {
                    options.lint = true;
                    options.gutters = ['CodeMirror-lint-markers'];
                }
                ed = window.CodeMirror(container, options);
                // Validación en tiempo real para yaml
                if (mode === 'yaml' && window.jsyaml) {
                    ed.on('change', (cm, change) => {
                        // Sanitizar tabs al pegar o escribir
                        const val = cm.getValue();
                        if (val.includes('\t')) {
                            const cursor = cm.getCursor();
                            cm.setValue(val.replace(/\t/g, '  '));
                            cm.setCursor(cursor);
                        }
                        clearTimeout(ed._validateTimer);
                        ed._validateTimer = setTimeout(() => {
                            const warningEl = composeFooter?.querySelector('.compose-running-warning');
                            try {
                                window.jsyaml.load(ed.getValue());
                                container.style.borderColor = '#2a3441';
                                if (btnDeploy) btnDeploy.disabled = false;
                                if (btnSave) btnSave.disabled = false;
                                if (warningEl) warningEl.style.display = 'none';
                            } catch (e) {
                                container.style.borderColor = '#ef5350';
                                if (btnDeploy) btnDeploy.disabled = true;
                                if (btnSave) btnSave.disabled = true;
                                if (warningEl) {
                                    warningEl.textContent = `⚠️ ${e.reason || e.message}`;
                                    warningEl.style.display = '';
                                }
                            }
                        }, 400);
                    });
                }
            } else {
                const ta = document.createElement('textarea');
                ta.value = content;
                ta.readOnly = !editable;
                ta.style.cssText = `width:100%;height:100%;background:transparent;border:none;outline:none;resize:none;padding:12px;font-family:"Courier New",monospace;font-size:0.85em;line-height:1.5;color:${editable ? '#ccc' : '#888'};`;
                container.appendChild(ta);
                ed = ta;
            }
            container.style.opacity = editable ? '1' : '0.75';
            return ed;
        };

        const loadCompose = async () => {
            composeEditorWrap.innerHTML = '<p style="color:#666;padding:1rem;">Cargando...</p>';
            if (!window.CodeMirror) {
                await new Promise((resolve) => {
                    const link = document.createElement('link');
                    link.rel = 'stylesheet';
                    link.href = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css';
                    document.head.appendChild(link);
                    const linkTheme = document.createElement('link');
                    linkTheme.rel = 'stylesheet';
                    linkTheme.href = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/theme/dracula.min.css';
                    document.head.appendChild(linkTheme);
                    const linkLint = document.createElement('link');
                    linkLint.rel = 'stylesheet';
                    linkLint.href = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/lint/lint.min.css';
                    document.head.appendChild(linkLint);
                    const script = document.createElement('script');
                    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js';
                    script.onload = () => {
                        const scriptYaml = document.createElement('script');
                        scriptYaml.src = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/yaml/yaml.min.js';
                        scriptYaml.onload = () => {
                            const scriptShell = document.createElement('script');
                            scriptShell.src = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/shell/shell.min.js';
                            scriptShell.onload = () => {
                                // Cargar js-yaml y addon lint en paralelo
                                let loaded = 0;
                                const done = () => { if (++loaded === 2) resolve(); };
                                const scriptJsYaml = document.createElement('script');
                                scriptJsYaml.src = 'https://cdnjs.cloudflare.com/ajax/libs/js-yaml/4.1.0/js-yaml.min.js';
                                scriptJsYaml.onload = done;
                                document.head.appendChild(scriptJsYaml);
                                const scriptLint = document.createElement('script');
                                scriptLint.src = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/lint/lint.min.js';
                                scriptLint.onload = () => {
                                    // Registrar linter YAML
                                    if (window.CodeMirror && window.jsyaml) {
                                        window.CodeMirror.registerHelper('lint', 'yaml', (text) => {
                                            const found = [];
                                            try { window.jsyaml.load(text); }
                                            catch (e) {
                                                const mark = e.mark;
                                                found.push({
                                                    from: window.CodeMirror.Pos(mark ? mark.line : 0, mark ? mark.column : 0),
                                                    to:   window.CodeMirror.Pos(mark ? mark.line : 0, mark ? mark.column + 1 : 1),
                                                    message: e.reason || e.message,
                                                    severity: 'error'
                                                });
                                            }
                                            return found;
                                        });
                                    }
                                    done();
                                };
                                document.head.appendChild(scriptLint);
                            };
                            document.head.appendChild(scriptShell);
                        };
                        document.head.appendChild(scriptYaml);
                    };
                    document.head.appendChild(script);
                });
            }
            // Registrar linter si js-yaml ya está cargado pero el linter no
            if (window.CodeMirror && window.jsyaml && !window.CodeMirror.helpers?.lint?.yaml) {
                window.CodeMirror.registerHelper('lint', 'yaml', (text) => {
                    const found = [];
                    try { window.jsyaml.load(text); }
                    catch (e) {
                        const mark = e.mark;
                        found.push({
                            from: window.CodeMirror.Pos(mark ? mark.line : 0, mark ? mark.column : 0),
                            to:   window.CodeMirror.Pos(mark ? mark.line : 0, mark ? mark.column + 1 : 1),
                            message: e.reason || e.message,
                            severity: 'error'
                        });
                    }
                    return found;
                });
            }
            try {
                const r = await fetch(`/api/compose/${encodeURIComponent(stackName)}${epParam2}`);
                const d = await r.json();
                if (!d.success) throw new Error(d.message);
                composeContent = d.content;
                envContent     = d.env || '';
                cmCompose = makeEditor(composeEditorWrap, composeContent, false, 'yaml');
                cmEnv     = makeEditor(envEditorWrap, envContent, false, 'shell');
                setTimeout(applySplit, 50);
            } catch (e) {
                composeEditorWrap.innerHTML = `<p style="color:#e57373;padding:1rem;">Error: ${e.message}</p>`;
            }
        };

        const getCmValue = (ed) => {
            const val = ed?.getValue ? ed.getValue() : (ed?.value || '');
            return val.replace(/\t/g, '  ');
        };

        const setEditMode = (editing) => {
            composeEditing = editing;
            cmpBtnEdit.style.display  = editing ? 'none' : '';
            btnDeploy.style.display   = editing ? '' : 'none';
            btnSave.style.display     = editing ? '' : 'none';
            btnCancel.style.display   = editing ? '' : 'none';
            btnPause.style.display    = editing ? 'none' : '';
            btnDelete.style.display   = editing ? 'none' : '';
            [[cmCompose, composeEditorWrap], [cmEnv, envEditorWrap]].forEach(([ed, el]) => {
                if (window.CodeMirror && ed?.setOption) {
                    ed.setOption('readOnly', editing ? false : 'nocursor');
                } else if (ed) {
                    ed.readOnly = !editing;
                    ed.style.color = editing ? '#ccc' : '#888';
                }
                if (el) el.style.opacity = editing ? '1' : '0.75';
            });
            if (editing) {
                // Recrear editor de compose con lint activado
                if (window.CodeMirror && cmCompose?.setOption) {
                    cmCompose.setOption('readOnly', false);
                    if (window.jsyaml) {
                        cmCompose.setOption('lint', true);
                        cmCompose.setOption('gutters', ['CodeMirror-lint-markers']);
                    }
                }
                if (cmCompose?.focus) cmCompose.focus();
            } else {
                composeEditorWrap.style.borderColor = '#2a3441';
                if (btnDeploy) btnDeploy.disabled = false;
                if (btnSave) btnSave.disabled = false;
                const warningEl = composeFooter.querySelector('.compose-running-warning');
                if (warningEl) warningEl.style.display = 'none';
                setTimeout(applySplit, 50);
            }
        };

        // Expandir env a 8 líneas al hacer click en él en modo edición
        envEditorWrap.addEventListener('click', () => {
            if (!composeEditing) return;
            const envH = 8 * LINE_H + 24;
            const totalInner = composeArea.clientHeight;
            const compH = Math.max(60, totalInner - 10 - envH);
            composeEditorWrap.style.height = compH + 'px';
            envEditorWrap.style.height     = envH + 'px';
            if (cmCompose?.setSize) cmCompose.setSize('100%', compH);
            if (cmEnv?.setSize)     cmEnv.setSize('100%', envH);
        });

        btnSave.addEventListener('click', async () => {
            const newCompose = getCmValue(cmCompose);
            const newEnv     = getCmValue(cmEnv);
            try {
                const r = await fetch(`/api/compose/${encodeURIComponent(stackName)}${epParam2}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: newCompose, env: newEnv })
                });
                const d = await r.json();
                if (!d.success) throw new Error(d.message);
                composeContent = newCompose;
                envContent     = newEnv;
                setEditMode(false);
            } catch (e) {
                alert(`Error guardando: ${e.message}`);
            }
        });

        // ── Terminal ──
        const terminalWrap      = panel.querySelector('#terminal-xterm-wrap');
        const termContainerWrap = panel.querySelector('#terminal-container-wrap');
        const termContainerSel  = panel.querySelector('#terminal-container-select');
        const termShellBtn      = panel.querySelector('#terminal-shell-btn');

        let currentTermId = null;
        let currentShell  = 'bash';

        termShellBtn.addEventListener('click', () => {
            currentShell = 'sh';
            startXterm();
        });

        const getTermId = () => {
            const containerName = termContainerSel.value || Object.keys(window._dockme_containers || {})[0] || stackName;
            return `container-exec--${containerName}`;
        };

        const initTerminal = async () => {
            currentShell = 'bash';
            // Cargar xterm.js si no está
            if (!window.Terminal) {
                await new Promise((resolve, reject) => {
                    const link = document.createElement('link');
                    link.rel = 'stylesheet';
                    link.href = '/api/xterm.css';
                    document.head.appendChild(link);
                    const script = document.createElement('script');
                    script.src = '/api/xterm.js';
                    script.onload = resolve;
                    script.onerror = reject;
                    document.head.appendChild(script);
                });
            }

            // Refrescar contenedores del stack actual antes de poblar el selector
            const epParam = (endpoint && endpoint.toLowerCase() !== 'actual')
                ? `?endpoint=${encodeURIComponent(endpoint)}` : '';
            try {
                const r = await fetch(`/api/stack-containers/${encodeURIComponent(stackName)}${epParam}`);
                const d = await r.json();
                if (d.containers?.length > 0) {
                    window._dockme_ports = {};
                    window._dockme_containers = {};
                    d.containers.forEach(c => {
                        const key = c.service || c.name;
                        window._dockme_ports[key] = c.ports || [];
                        window._dockme_containers[key] = c.name;
                    });
                }
            } catch (_) {}

            // Poblar selector de contenedores
            const containers = Object.keys(window._dockme_containers || {});
            if (containers.length > 1) {
                termContainerWrap.style.display = 'flex';
                termContainerSel.innerHTML = containers.map(s =>
                    `<option value="${s}">${s}</option>`
                ).join('');
            } else {
                termContainerWrap.style.display = 'none';
            }

            startXterm();
        };

        const startXterm = () => {
            // Limpiar instancia anterior
            if (xtermInstance) { xtermInstance.dispose(); xtermInstance = null; }
            if (window._dockme_termResizeObs) { window._dockme_termResizeObs.disconnect(); window._dockme_termResizeObs = null; }
            terminalWrap.innerHTML = '';

            const shell = currentShell;
            const serviceName = termContainerSel.value || Object.keys(window._dockme_containers || {})[0] || stackName;
            const containerName = (window._dockme_containers || {})[serviceName] || serviceName;
            currentTermId = ep
                ? `container-exec-${ep}-${stackName}-${serviceName}-0`
                : `container-exec--${stackName}-${serviceName}-0`;

            const sock = document.querySelector('#app')?._vnode?.component?.root?.proxy?.getSocket();
            if (!sock) return;

            const term = new Terminal({
                theme: { background: '#0d1117', foreground: '#ccc', cursor: '#4f84c8' },
                fontFamily: '"Courier New", monospace',
                fontSize: 13,
                cursorBlink: true,
                convertEol: true,
            });
            xtermInstance = term;
            term.open(terminalWrap);

            // Calcular dimensiones reales basadas en el tamaño de celda de xterm
            // Medir tamaño de celda una vez tras renderizar
            let cellW = 0;
            let cellH = 0;
            const measureCell = () => {
                const rows = terminalWrap.querySelectorAll('.xterm-rows > div');
                for (const row of rows) {
                    const spans = row.querySelectorAll('span');
                    for (const span of spans) {
                        const len = span.textContent.length;
                        if (len > 0) {
                            const w = span.getBoundingClientRect().width / len;
                            if (w > 3) { cellW = w; break; }
                        }
                    }
                    if (cellW) break;
                }
                const screenEl = terminalWrap.querySelector('.xterm-screen');
                if (screenEl && term.rows > 0) {
                    const h = screenEl.getBoundingClientRect().height / term.rows;
                    if (h > 0) cellH = h;
                }
            };

            const fitTerminal = () => {
                if (terminalWrap.clientWidth < 50) return; // oculto o sin dimensiones válidas
                if (!cellW || !cellH) measureCell();
                if (!cellW || !cellH) return;
                const padding = 40;
                const cols = Math.max(2, Math.floor((terminalWrap.clientWidth - padding) / cellW));
                const rows = Math.max(1, Math.floor(terminalWrap.clientHeight / cellH));
                if (term.cols !== cols || term.rows !== rows) {
                    term.resize(cols, rows);
                }
            };
            setTimeout(() => {
                const tryFit = (attempts) => {
                    if (terminalWrap.clientWidth < 50) {
                        if (attempts > 0) setTimeout(() => tryFit(attempts - 1), 80);
                        return;
                    }
                    measureCell();
                    if (cellW && cellH) {
                        fitTerminal();
                    } else if (attempts > 0) {
                        setTimeout(() => tryFit(attempts - 1), 80);
                    }
                };
                tryFit(10);
            }, 50);

            // 1. Salir del terminal anterior
            sock.emit('agent', ep, 'leaveCombinedTerminal', stackName, () => {});

            // 2. Crear el terminal interactivo
            sock.emit('agent', ep, 'interactiveTerminal', stackName, serviceName, shell, () => {});

            // 3. Unirse y obtener buffer previo via callback
            sock.emit('agent', ep, 'terminalJoin', currentTermId, (res) => {
                if (res?.buffer) term.write(res.buffer);
            });

            // Recibir output
            if (startXterm._agentListener) sock.off('agent', startXterm._agentListener);
            const onAgent = function() {
                const args = Array.from(arguments);
                if (args[0] === 'terminalWrite' && args[1] === currentTermId && args[2]) {
                    term.write(args[2]);
                }
            };
            startXterm._agentListener = onAgent;
            sock.on('agent', onAgent);

            // Enviar input
            term.onData(data => sock.emit('agent', ep, 'terminalInput', currentTermId, data));

            // Resize al cambiar tamaño
            const resizeObs = new ResizeObserver(() => {
                fitTerminal();
                const rows = term.rows;
                const cols = term.cols;
                if (cols > 0 && rows > 0) {
                    sock.emit('agent', ep, 'terminalResize', currentTermId, rows, cols);
                }
            });
            resizeObs.observe(terminalWrap);
            window._dockme_termResizeObs = resizeObs;
        };

        termContainerSel.addEventListener('change', () => { if (xtermInstance) startXterm(); });

        cmpBtnEdit.addEventListener('click', () => setEditMode(true));

        btnCancel.addEventListener('click', () => {
            cmCompose = makeEditor(composeEditorWrap, composeContent, false, 'yaml');
            cmEnv     = makeEditor(envEditorWrap, envContent, false, 'shell');
            setTimeout(applySplit, 50);
            setEditMode(false);
        });

        btnDeploy.addEventListener('click', async () => {
            const newCompose = getCmValue(cmCompose);
            const newEnv     = getCmValue(cmEnv);
            const prevCompose = composeContent;
            const prevEnv     = envContent;

            // Si el compose usa imagen de dockme, usar el mecanismo especial de actualización
            const isDockme = /image:\s*[^\s]*\/dockme:|image:\s*dockme:/i.test(composeContent || newCompose);
            if (isDockme) {
                // Guardar primero
                try {
                    const r = await fetch(`/api/compose/${encodeURIComponent(stackName)}${epParam2}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content: newCompose, env: newEnv })
                    });
                    const d = await r.json();
                    if (!d.success) throw new Error(d.message);
                    composeContent = newCompose;
                    envContent = newEnv;
                    setEditMode(false);
                } catch (e) {
                    alert(`Error guardando: ${e.message}`);
                    return;
                }
                EventHandlers.updateDockme(endpoint || 'Actual');
                return;
            }

            // Guardar primero
            try {
                const r = await fetch(`/api/compose/${encodeURIComponent(stackName)}${epParam2}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: newCompose, env: newEnv })
                });
                const d = await r.json();
                if (!d.success) throw new Error(d.message);
                // No salimos del modo edición aún — esperamos confirmación del deploy
            } catch (e) {
                alert(`Error guardando: ${e.message}`);
                return;
            }

            // Mostrar badge "Desplegando" mientras dura el deploy
            actionInProgress = true;
            setButtonsDisabled(true);
            renderBadges(lastKnownServices, 'deploying');

            // Cambiar al tab de logs
            logsActiveTab = 'logs';
            panel.querySelectorAll('.logs-tab').forEach(t => t.classList.remove('active'));
            panel.querySelector('.logs-tab[data-tab="logs"]')?.classList.add('active');
            logsArea.style.display     = '';
            composeArea.style.display  = 'none';
            logsFooter.style.display   = '';
            composeFooter.style.display = 'none';

            if (logsEventSource) { logsEventSource.close(); logsEventSource = null; }
            logsArea.innerHTML = '';

            const deployUrl = `/api/deploy/${encodeURIComponent(stackName)}${epParam2 ? `?endpoint=${encodeURIComponent(endpoint)}` : ''}`;
            const deploySource = new EventSource(deployUrl);
            deploySource.onmessage = (e) => {
                const raw = e.data;
                const line = document.createElement('div');
                line.className = 'logs-line';
                line.dataset.raw = raw;
                const lower = raw.toLowerCase();
                let color = '#888';
                if (lower.includes('started') || lower.includes('running') || lower.includes('✅')) color = '#4caf50';
                else if (lower.includes('starting') || lower.includes('recreat') || lower.includes('pulling') || lower.includes('pulled')) color = '#4f84c8';
                else if (lower.includes('stopping') || lower.includes('stopped') || lower.includes('warning')) color = '#ffa726';
                else if (lower.includes('error') || lower.includes('❌')) color = '#ef5350';
                line.innerHTML = `<span class="logs-msg" style="color:${color};">${raw.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span>`;
                logsArea.appendChild(line);
                if (logsAutoScroll) logsArea.scrollTop = logsArea.scrollHeight;

                if (raw.includes('✅') || raw.includes('❌')) {
                    deploySource.close();
                    actionInProgress = false;
                    setButtonsDisabled(false);
                    if (raw.includes('❌')) {
                        // Deploy fallido — restaurar compose anterior en disco
                        fetch(`/api/compose/${encodeURIComponent(stackName)}${epParam2}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ content: prevCompose, env: prevEnv })
                        }).catch(() => {});
                        // Restaurar editores
                        composeContent = prevCompose;
                        envContent = prevEnv;
                        // No reconectar logs — el stack sigue con su estado anterior
                        renderBadges(lastKnownServices);
                        if (!logsStatusInterval) startStatusPolling();
                    } else {
                        // Deploy exitoso — actualizar contenido guardado y salir del modo edición
                        composeContent = newCompose;
                        envContent = newEnv;
                        setEditMode(false);
                        waitForStateChange(true);
                    }
                }
            };
            deploySource.onerror = () => {
                deploySource.close();
                actionInProgress = false;
                setButtonsDisabled(false);
                renderBadges(lastKnownServices);
                if (!logsStatusInterval) startStatusPolling();
            };
        });

        btnPause.addEventListener('click', () => {
            if (stackIsRunning) {
                const msg = composeFooter.querySelector('.compose-running-warning');
                if (msg) { msg.textContent = '⚠️ El servicio debe estar parado antes de realizar esta acción'; msg.style.display = ''; setTimeout(() => msg.style.display = 'none', 3000); }
                return;
            }
            const socket = document.querySelector('#app')?._vnode?.component?.root?.proxy?.getSocket();
            const ep = (endpoint && endpoint.toLowerCase() !== 'actual') ? endpoint : '';
            if (socket) {
                socket.emit('agent', ep, 'downStack', stackName, () => {});
                // Limpiar updates de este stack
                const hostEntry = State.updatesDataGlobal?.find(h => h.endpoint?.toLowerCase() === (endpoint || 'Actual').toLowerCase());
                if (hostEntry?.hostname) {
                    API.removeUpdate(stackName, hostEntry.hostname)
                        .then(() => API.loadUpdates())
                        .then(data => { State.setUpdatesData(data); DataLoader.loadAndDisplay(); });
                }
            }
        });

        btnDelete.addEventListener('click', () => {
            if (stackIsRunning) {
                const msg = composeFooter.querySelector('.compose-running-warning');
                if (msg) { msg.textContent = '⚠️ El servicio debe estar parado antes de realizar esta acción'; msg.style.display = ''; setTimeout(() => msg.style.display = 'none', 3000); }
                return;
            }
            if (!confirm(`¿Eliminar el stack "${stackName}"? Esta acción no se puede deshacer.`)) return;
            const socket = document.querySelector('#app')?._vnode?.component?.root?.proxy?.getSocket();
            if (socket) {
                socket.emit('agent', ep, 'deleteStack', stackName, null);
                // Limpiar updates de este stack
                const hostEntry = State.updatesDataGlobal?.find(h => h.endpoint?.toLowerCase() === (endpoint || 'Actual').toLowerCase());
                if (hostEntry?.hostname) {
                    API.removeUpdate(stackName, hostEntry.hostname)
                        .then(() => API.loadUpdates())
                        .then(data => { State.setUpdatesData(data); });
                }
                // Eliminar de stacks.json e icono si nadie más lo usa
                fetch('/api/set-stack', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: stackName, endpoint: endpoint || 'Actual', _delete: true })
                }).then(() => loadStacksConfig()).catch(() => {});
                // Volver al dashboard
                deactivateLogsMode();
            }
        });

        const terminalArea  = panel.querySelector('#terminal-area');

        panel.querySelectorAll('.logs-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                panel.querySelectorAll('.logs-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                logsActiveTab = tab.dataset.tab;
                const isLogs     = tab.dataset.tab === 'logs';
                const isCompose  = tab.dataset.tab === 'compose';
                const isTerminal = tab.dataset.tab === 'terminal';
                logsArea.style.display      = isLogs ? '' : 'none';
                composeArea.style.display   = isCompose ? 'flex' : 'none';
                terminalArea.style.display  = isTerminal ? 'flex' : 'none';
                logsFooter.style.display    = isLogs ? '' : 'none';
                composeFooter.style.display = isCompose ? '' : 'none';
                if (isLogs && logsAutoScroll) logsArea.scrollTop = logsArea.scrollHeight;
                if (isCompose && !composeContent) loadCompose();
                else if (isCompose) setTimeout(applySplit, 50);
                if (isTerminal) {
                    initTerminal();
                    setTimeout(() => xtermInstance?.focus(), 200);
                }
            });
        });

        // Restaurar tab activo
        if (logsActiveTab === 'compose') {
            panel.querySelectorAll('.logs-tab').forEach(t => t.classList.remove('active'));
            panel.querySelector('.logs-tab[data-tab="compose"]')?.classList.add('active');
            logsArea.style.display      = 'none';
            composeArea.style.display   = 'flex';
            terminalArea.style.display  = 'none';
            logsFooter.style.display    = 'none';
            composeFooter.style.display = '';
            loadCompose();
        } else if (logsActiveTab === 'terminal') {
            panel.querySelectorAll('.logs-tab').forEach(t => t.classList.remove('active'));
            panel.querySelector('.logs-tab[data-tab="terminal"]')?.classList.add('active');
            logsArea.style.display      = 'none';
            composeArea.style.display   = 'none';
            terminalArea.style.display  = 'flex';
            logsFooter.style.display    = 'none';
            composeFooter.style.display = 'none';
            initTerminal();
            setTimeout(() => xtermInstance?.focus(), 200);
        }

        // Polling de estado de contenedores via socket de Dockge
        const badgesEl = panel.querySelector('#logs-badges');

        const svgPlay = `<svg class="svg-inline--fa" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512" style="width:0.75em;height:1em;margin-right:5px;"><path fill="currentColor" d="M73 39c-14.8-9.1-33.4-9.4-48.5-.9S0 62.6 0 80V432c0 17.4 9.4 33.4 24.5 41.9s33.7 8.1 48.5-.9L361 297c14.3-8.7 23-24.2 23-41s-8.7-32.2-23-41L73 39z"/></svg> Iniciar`;
        const svgStop = `<svg class="svg-inline--fa" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512" style="width:0.75em;height:1em;margin-right:5px;"><path fill="currentColor" d="M0 128C0 92.7 28.7 64 64 64H320c35.3 0 64 28.7 64 64V384c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V128z"/></svg> Detener`;
        const svgSpin = `<svg class="svg-inline--fa fa-rotate-right fa-spin" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" style="width:0.875em;height:1em;margin-right:5px;"><path fill="currentColor" d="M463.5 224H472c13.3 0 24-10.7 24-24V72c0-9.7-5.8-18.5-14.8-22.2s-19.3-1.7-26.2 5.2L413.4 96.6c-87.6-86.5-228.7-86.2-315.8 1c-87.5 87.5-87.5 229.3 0 316.8s229.3 87.5 316.8 0c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0c-62.5 62.5-163.8 62.5-226.3 0s-62.5-163.8 0-226.3c62.2-62.2 162.7-62.5 225.3-1L327 183c-6.9 6.9-8.9 17.2-5.2 26.2s12.5 14.8 22.2 14.8H463.5z"/></svg> Espera...`;

        // Último estado conocido de los contenedores (para no perderlos al parar)
        let lastKnownServices = [];

        const setButtonsDisabled = (disabled) => {
            [btnStartStop, btnRestart].forEach(btn => {
                if (btn) btn.disabled = disabled;
            });
        };

        const renderBadges = (services, forceState) => {
            const svgPlayBtn = svgPlay;
            const svgStopBtn = svgStop;

            if (services.length > 0) lastKnownServices = services;

            // Si no hay servicios, usar los últimos conocidos como exited
            const displayServices = services.length > 0 ? services :
                lastKnownServices.map(([name]) => [name, { state: 'exited' }]);

            const anyRunning = services.some(([, s]) =>
                s.state === 'running' || s.state === 'healthy' || s.state === 'starting'
            );
            stackIsRunning = anyRunning;
            if (!anyRunning) { actionInProgress = false; setButtonsDisabled(false); }
            if (btnStartStop && !btnStartStop.disabled) {
                btnStartStop.innerHTML = anyRunning ? svgStopBtn : svgPlayBtn;
            }

            badgesEl.innerHTML = displayServices.map(([name, status]) => {
                const state = forceState || (status.state || 'unknown').toLowerCase();
                let cls = 'bg-secondary';
                if (state === 'running' || state === 'healthy') cls = 'bg-success';
                else if (state === 'starting' || state === 'stopping' || state === 'restarting' || state === 'deploying') cls = 'bg-warning';
                else if (state === 'unhealthy' || state === 'exited') cls = 'bg-danger';
                return `<span class="badge ${cls} logs-service-badge" data-service="${name}" style="font-size:0.82em;font-weight:400;padding:4px 8px;cursor:pointer;">${name} <b style="font-weight:700;">${state}</b></span>`;
            }).join('');

            // Click en badge → popover
            badgesEl.querySelectorAll('.logs-service-badge').forEach(badge => {
                const showPopover = (badge) => {
                    const existing = document.querySelector('.logs-badge-popover');
                    if (existing && existing.dataset.service === badge.dataset.service) return;
                    existing?.remove();

                    const serviceName = badge.dataset.service;
                    const ports = (window._dockme_ports || {})[serviceName] || [];
                    const containerName = (window._dockme_containers || {})[serviceName] || serviceName;
                    const isRemote = endpoint && endpoint.toLowerCase() !== 'actual';
                    const remoteHost = isRemote ? endpoint.split(':')[0] : null;
                    const primaryHost = primaryHostLocal || window.location.hostname;

                    const portBadges = ports.length
                        ? ports.map(p => {
                            const bindHost = (p.host && p.host !== '0.0.0.0') ? p.host
                                : isRemote ? remoteHost : primaryHost;
                            const url = `http://${bindHost}:${p.published}`;
                            return `<a href="${url}" target="_blank"><span class="badge me-1 bg-secondary">${p.published}</span></a>`;
                        }).join('')
                        : `<span style="color:#666;font-size:0.8em;">Sin puertos expuestos</span>`;

                    const pop = document.createElement('div');
                    pop.className = 'logs-badge-popover';
                    pop.dataset.service = serviceName;
                    const serviceState = lastKnownServices.find(([n]) => n === serviceName)?.[1]?.state || 'unknown';
                    const isRunning = serviceState === 'running' || serviceState === 'healthy' || serviceState === 'unhealthy';

                    const svgPlaySm  = `<svg class="svg-inline--fa" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512" style="width:0.65em;height:0.85em;margin-right:4px;"><path fill="currentColor" d="M73 39c-14.8-9.1-33.4-9.4-48.5-.9S0 62.6 0 80V432c0 17.4 9.4 33.4 24.5 41.9s33.7 8.1 48.5-.9L361 297c14.3-8.7 23-24.2 23-41s-8.7-32.2-23-41L73 39z"/></svg>`;
                    const svgStopSm  = `<svg class="svg-inline--fa" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512" style="width:0.65em;height:0.85em;margin-right:4px;"><path fill="currentColor" d="M0 128C0 92.7 28.7 64 64 64H320c35.3 0 64 28.7 64 64V384c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V128z"/></svg>`;
                    const svgRestSm  = `<svg class="svg-inline--fa" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" style="width:0.75em;height:0.85em;margin-right:4px;"><path fill="currentColor" d="M463.5 224H472c13.3 0 24-10.7 24-24V72c0-9.7-5.8-18.5-14.8-22.2s-19.3-1.7-26.2 5.2L413.4 96.6c-87.6-86.5-228.7-86.2-315.8 1c-87.5 87.5-87.5 229.3 0 316.8s229.3 87.5 316.8 0c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0c-62.5 62.5-163.8 62.5-226.3 0s-62.5-163.8 0-226.3c62.2-62.2 162.7-62.5 225.3-1L327 183c-6.9 6.9-8.9 17.2-5.2 26.2s12.5 14.8 22.2 14.8H463.5z"/></svg>`;

                    const btnStyle = 'class="btn btn-normal" style="padding:2px 8px;font-size:0.78em;display:inline-flex;align-items:center;"';

                    const actionBtns = multiContainer ? `
                        <div style="margin-top:10px;padding-top:8px;border-top:1px solid #666;">
                            <div style="font-size:0.75em;color:#96a4b1;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Control Docker individual</div>
                            <div style="display:flex;gap:25px;justify-content:center;">
                                <button ${btnStyle} data-action="${isRunning ? 'stop' : 'start'}" data-container="${containerName}">
                                    ${isRunning ? svgStopSm + 'Detener' : svgPlaySm + 'Iniciar'}
                                </button>
                                <button ${btnStyle} data-action="restart" data-container="${containerName}">
                                    ${svgRestSm}Reiniciar
                                </button>
                            </div>
                        </div>` : '';

                    pop.innerHTML = `
                        <div style="font-size:0.75em;color:#96a4b1;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Puertos expuestos</div>
                        <div style="display:flex;gap:4px;flex-wrap:wrap;">${portBadges}</div>
                        ${actionBtns}
                    `;
                    pop.style.cssText = 'position:absolute;background:#1c2431;border:1px solid #b1bfcc;border-radius:8px;padding:10px 14px;z-index:1000;min-width:160px;box-shadow:0 4px 20px rgba(0,0,0,0.5);';

                    const rect = badge.getBoundingClientRect();
                    const panelRect = panel.getBoundingClientRect();
                    pop.style.top  = (rect.bottom - panelRect.top + 6) + 'px';
                    pop.style.left = (rect.left - panelRect.left) + 'px';
                    panel.style.position = 'relative';
                    panel.appendChild(pop);

                    // Cerrar al salir del badge Y del popover
                    let hideTimer;
                    const startHide = () => { hideTimer = setTimeout(() => pop.remove(), 200); };
                    const cancelHide = () => clearTimeout(hideTimer);
                    badge.addEventListener('mouseleave', startHide);
                    pop.addEventListener('mouseenter', cancelHide);
                    pop.addEventListener('mouseleave', startHide);

                    // Cerrar al click fuera (móvil/tablet sin hover)
                    setTimeout(() => {
                        document.addEventListener('click', function closePopover(e) {
                            if (!pop.contains(e.target) && e.target !== badge) {
                                pop.remove();
                                document.removeEventListener('click', closePopover);
                            }
                        });
                    }, 10);

                    // Acciones de los botones
                    pop.querySelectorAll('button[data-action]').forEach(btn => {
                        btn.addEventListener('click', (ev) => {
                            ev.stopPropagation();
                            const action = btn.dataset.action;
                            const containerName = btn.dataset.container;
                            pop.remove();

                            const newState = action === 'stop' ? 'exited' : 'running';
                            const idx = lastKnownServices.findIndex(([n]) => n === serviceName);
                            if (idx >= 0) lastKnownServices[idx][1] = { state: newState };
                            renderBadges(lastKnownServices);
                            actionInProgress = true;
                            setButtonsDisabled(true);

                            const epStr = isRemote ? `?endpoint=${encodeURIComponent(endpoint)}` : '';
                            fetch(`/api/container-action${epStr}`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ container: containerName, action })
                            }).finally(() => {
                                setTimeout(() => {
                                    actionInProgress = false;
                                    setButtonsDisabled(false);
                                    if (action !== 'stop') {
                                        fetch(`/api/stack-containers/${encodeURIComponent(stackName)}${epParam}`)
                                            .then(r => r.json())
                                            .then(d => {
                                                if (d.containers?.length > 0) {
                                                    window._dockme_ports = {};
                                                    window._dockme_containers = {};
                                                    d.containers.forEach(c => {
                                                        const key = c.service || c.name;
                                                        window._dockme_ports[key] = c.ports || [];
                                                        window._dockme_containers[key] = c.name;
                                                    });
                                                }
                                            }).catch(() => {});
                                    }
                                }, 2000);
                            });
                        });
                    });
                };

                badge.addEventListener('mouseenter', () => showPopover(badge));
                badge.addEventListener('click', (e) => { e.stopPropagation(); showPopover(badge); });
            });
        };

        let actionInProgress = false;

        let logsStatusInterval = null;
        const startStatusPolling = () => {
            const socket = document.querySelector('#app')?._vnode?.component?.root?.proxy?.getSocket();
            if (!socket) return;
            const ep = (endpoint && endpoint.toLowerCase() !== 'actual') ? endpoint : '';

            // Si venimos del BulkPanel con deploy en curso, mostrar deploying inmediatamente
            if (window._dockme_force_badge) {
                renderBadges(lastKnownServices, window._dockme_force_badge);
                window._dockme_force_badge = null;
            }
            const poll = () => {
                if (actionInProgress) return;

                // Leer color del cp-circle de la lista — fuente de verdad para inactivo
                const color = getDockgeStackColor();
                if (color === 'gray') {
                    badgesEl.innerHTML = `<span class="badge bg-secondary" style="font-size:0.82em;font-weight:400;padding:4px 8px;">Inactivo</span>`;
                    stackIsRunning = false;
                    actionInProgress = false;
                    setButtonsDisabled(false);
                    if (btnStartStop) btnStartStop.innerHTML = svgPlay;
                    
                    if (logsStatusInterval) { clearInterval(logsStatusInterval); logsStatusInterval = null; }
                    return;
                }

                socket.emit('agent', ep, 'serviceStatusList', stackName, (res) => {
                    if (!res?.ok) return;
                    const services = res.serviceStatusList ? Object.entries(res.serviceStatusList) : [];
                    if (services.length === 0) {
                        // Consultar el estado real desde el root Vue — más fiable que el cp-circle
                        const root = document.querySelector('#app')?._vnode?.component?.proxy?.$root;
                        const stackKey = ep ? `${stackName}/${ep}` : stackName;
                        const stackData = root?.completeStackList?.[stackKey] || root?.stackList?.[stackName];
                        const col = getDockgeStackColor();

                        if (stackData?.status === 3 || stackData?.active) {
                            // Stack running según Vue — puede que serviceStatusList tarde en responder
                            badgesEl.innerHTML = `<span class="badge bg-success" style="font-size:0.82em;font-weight:400;padding:4px 8px;">Running</span>`;
                            stackIsRunning = true;
                            actionInProgress = false;
                            setButtonsDisabled(false);
                            if (btnStartStop) btnStartStop.innerHTML = svgStop;
                        } else if (col === 'red' || stackData?.status === 4) {
                            badgesEl.innerHTML = `<span class="badge bg-danger" style="font-size:0.82em;font-weight:400;padding:4px 8px;">Stack detenido</span>`;
                            stackIsRunning = false;
                            actionInProgress = false;
                            setButtonsDisabled(false);
                            if (btnStartStop) btnStartStop.innerHTML = svgPlay;
                        }
                        return;
                    }
                    // Merge: actualizar estados conocidos, preservar los que no vienen (exited)
                    services.forEach(([name, status]) => {
                        const idx = lastKnownServices.findIndex(([n]) => n === name);
                        if (idx >= 0) lastKnownServices[idx][1] = status;
                        else lastKnownServices.push([name, status]);
                    });
                    setButtonsDisabled(false);
                    renderBadges(lastKnownServices);
                });
            };
            poll();
            logsStatusInterval = setInterval(poll, 3000);
        };

        // Limpiar intervalo anterior si existía
        if (window._logsStatusInterval) { clearInterval(window._logsStatusInterval); }
        startStatusPolling();
        window._logsStatusInterval = logsStatusInterval;

        // SSE
        const sseEpParam = (endpoint && endpoint.toLowerCase() !== 'actual')
            ? `&endpoint=${encodeURIComponent(endpoint)}` : '';
        const url = `/api/logs/${encodeURIComponent(stackName)}?tail=200${sseEpParam}`;

        logsEventSource = new EventSource(url);

        logsEventSource.onmessage = (e) => {
            const line = buildLine(e.data, filterInput.value);
            logsArea.appendChild(line);
            if (logsAutoScroll) logsArea.scrollTop = logsArea.scrollHeight;
        };

        logsEventSource.onerror = () => {
            const errLine = document.createElement('div');
            errLine.className = 'logs-error-line';
            errLine.dataset.raw = '';
            errLine.textContent = '\u26A0\uFE0F Conexi\u00F3n perdida con el servidor de logs';
            logsArea.appendChild(errLine);
            if (logsAutoScroll) logsArea.scrollTop = logsArea.scrollHeight;
        };

        // Mostrar el panel solo cuando todo está construido
        requestAnimationFrame(() => {
            document.querySelector('#dockme-logs-panel').style.display = '';
        });
    }

    function activateLogsMode() {
        document.body.classList.add('dockme-logs-mode');
        // Cerrar modo edición si está activo
        if (typeof dockmeEditMode !== 'undefined' && dockmeEditMode) {
            dockmeEditMode = false;
            if (typeof updateEditModeToggleUI === 'function') updateEditModeToggleUI();
        }
        // Cerrar modo organizar si está activo
        const row = document.querySelector('#dockme-blocks-row');
        if (row?.classList.contains('organizing')) {
            row.classList.remove('organizing');
            document.body.classList.remove('dockme-organizing');
            row.querySelectorAll('.links-item-card, .stack-card-link[data-fav-nombre]').forEach(el => { el.draggable = false; });
            document.querySelector('#dockme-profile-bar')?.remove();
        }
        const blocksRow = document.querySelector('#dockme-blocks-row');
        const dashboard = document.querySelector('#dockme-dashboard');
        if (blocksRow) blocksRow.style.display = 'none';
        MetricsManager.stop();
        if (!document.querySelector('#dockme-logs-panel')) {
            const panel = document.createElement('div');
            panel.id = 'dockme-logs-panel';
            dashboard?.appendChild(panel);
        }
        document.querySelector('#dockme-logs-panel').style.display = 'none';
        // Si no hay stack previo, el panel queda vacío hasta que se seleccione uno
    }

    function deactivateLogsMode() {
        document.dispatchEvent(new Event('dockme-logs-deactivated'));
        document.body.classList.remove('dockme-logs-mode');
        document.body.classList.remove('logs-expanded');
        logsActiveTab = 'logs';
        if (logsEventSource) { logsEventSource.close(); logsEventSource = null; }
        if (window._logsStatusInterval) { clearInterval(window._logsStatusInterval); window._logsStatusInterval = null; }
        if (xtermInstance) { try { xtermInstance.dispose(); } catch(_) {} xtermInstance = null; }
        if (window._dockme_termResizeObs) { window._dockme_termResizeObs.disconnect(); window._dockme_termResizeObs = null; }
        const panel = document.querySelector('#dockme-logs-panel');
        if (panel) panel.style.display = 'none';
        const blocksRow = document.querySelector('#dockme-blocks-row');
        if (blocksRow) blocksRow.style.display = '';
        MetricsManager.start();
        Promise.all([loadStacksConfig(), loadLinksConfig()]).then(() => DataLoader.loadAndDisplay());
        // Focus en el buscador al volver al dashboard
        setTimeout(() => {
            const input = document.querySelector('.search-input');
            if (input) input.focus();
        }, 300);
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
            const wasInLogsMode = document.body.classList.contains('dockme-logs-mode');
            const savedStack = logsCurrentStack;
            const savedEndpoint = logsCurrentEndpoint;
            // Cerrar modo logs si está activo
            if (wasInLogsMode) {
                deactivateLogsMode();
            }
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
                    if (wasInLogsMode && savedStack) showStackEditorForStack(savedStack, savedEndpoint || 'Actual');
                }, 400);
            } else {
                dockmeEditMode = !dockmeEditMode;
                updateEditModeToggleUI();
                if (dockmeEditMode && wasInLogsMode && savedStack) {
                    setTimeout(() => showStackEditorForStack(savedStack, savedEndpoint || 'Actual'), 100);
                }
            }
        });

        // Icono reordenar — organizar dashboard
        const organizeIcon = document.createElement('div');
        organizeIcon.className = 'dockme-organize-icon';
        organizeIcon.title = 'Organizar dashboard';
        organizeIcon.innerHTML = '<img src="/system-icons/reordenar.svg" style="width:24px;height:24px;vertical-align:middle;">';
        organizeIcon.addEventListener('click', () => {
            // Cerrar modo logs si está activo
            if (document.body.classList.contains('dockme-logs-mode')) {
                deactivateLogsMode();
            }
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
        const mostrarNovedades = (currentVersion) => {
            if (!currentVersion) return;
            // release se lee de settings.json (fuente de verdad), no de updates.json
            const savedRelease = State.settingsData?.release || '';
            if (savedRelease === currentVersion) return;
            const novedadesIcon = document.createElement('button');
            novedadesIcon.className = 'btn-novedades-dockme';
            novedadesIcon.title = `Novedades v${currentVersion}`;
            novedadesIcon.innerHTML = '📣 Novedades';
            novedadesIcon.addEventListener('click', async () => {
                window.open('https://github.com/fernandeusto/dockme/releases', '_blank');
                if (State.settingsData) State.settingsData.release = currentVersion;
                novedadesIcon.remove();
                await fetch('/api/set-release-version', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ version: currentVersion })
                });
            });
            if (window.innerWidth > 700) wrapper.prepend(novedadesIcon);
        };
        fetch('/api/get-version')
            .then(r => r.json())
            .then(vdata => mostrarNovedades(vdata.version))
            .catch(err => console.error('[Novedades] error:', err));

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
    function showDashboardContainer() {
        const dashboard = document.querySelector('#dockme-dashboard');
        if (document.body.classList.contains('dockme-logs-mode')) {
            // En modo logs: mostrar el dashboard pero ocultar blocks-row y mantener el panel de logs
            if (dashboard) dashboard.style.display = '';
            const blocksRow = document.querySelector('#dockme-blocks-row');
            if (blocksRow) blocksRow.style.display = 'none';
            const logsPanel = document.querySelector('#dockme-logs-panel');
            if (logsPanel) logsPanel.style.display = '';
            // No arrancar métricas en modo logs
        } else {
            if (dashboard) dashboard.style.display = '';
            MetricsManager.start();
        }
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
                <button class="config-tab active" data-tab="stacks">📦 Stacks</button>
                <button class="config-tab" data-tab="servidores">🖥️ Servidores</button>
                <button class="config-tab" data-tab="links">🔗 Links</button>
                <button class="config-tab" data-tab="general">⚙️ General</button>
            </div>
            <div class="config-content active" id="config-tab-stacks">
                <p><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg><span>Selecciona un stack de la lista izquierda para editar sus datos.</span></p>
            </div>
            <div class="config-content" id="config-tab-servidores"></div>
            <div class="config-content" id="config-tab-links">
                <p>Próximamente...</p>
            </div>
            <div class="config-content" id="config-tab-general"></div>
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
        if (tab === 'general') {
            const container = panel.querySelector('#config-tab-general');
            if (container && !container.dataset.loaded) {
                container.dataset.loaded = 'true';
                renderGeneralTab(container);
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
                            if (State.settingsData) State.settingsData.primaryHost = newVal;
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
        serviceInput.addEventListener('blur', () => handleServiceUrlSave());
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
        repoInput.addEventListener('blur', () => handleRepoUrlSave());
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
        urlInput.addEventListener('blur', () => handleUrlApply());
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
        // Si es agente, mostrar mensaje en lugar del dashboard
        if (!!State.settingsData?.centralUrl) {
            const centralUrl = State.settingsData.centralUrl || '';
            const centralLink = centralUrl
                ? `<a href="${centralUrl}" style="color:#7eb8f7;text-decoration:underline;">${centralUrl}</a>`
                : 'el servidor central';
            const msg = document.createElement('div');
            msg.id = 'dockme-dashboard';
            msg.className = 'row mt-4';
            msg.innerHTML = `
                <div style="text-align:center;padding:40px 20px;max-width:560px;margin:0 auto;">
                    <img src="/system-icons/dockme.svg" style="width:48px;height:48px;margin-bottom:14px;opacity:0.75;">
                    <div style="font-size:1.1em;font-weight:600;color:#fff;margin-bottom:12px;">Servidor gestionado de forma centralizada</div>
                    <p style="color:#c0cfe0;font-size:0.9em;line-height:1.7;margin:0 0 10px 0;">
                        Este servidor está siendo gestionado desde ${centralLink}.
                    </p>
                    <p style="color:#a0b8d0;font-size:0.85em;line-height:1.7;margin:0 0 12px 0;">
                        Este servidor debería aparecer detectado en el servidor central. Si no aparece tras refrescar la página del central, verifica que las variables del compose tengan la URL del central correcta. Para volver al modo sin conexión a central, elimina las variables de agente en este compose.
                    </p>
                    <p style="color:#7a9cc4;font-size:0.82em;margin:0;">
                        Más info en <a href="https://github.com/fernandeusto/dockme" target="_blank" style="color:#7eb8f7;">github.com/fernandeusto/dockme</a>
                    </p>
                </div>
            `;
            hiddenBlock.after(msg);
            return msg;
        }
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

    function forceSetupLanguageES(attempts = 10) {
        const select = document.querySelector('#language');
        if (!select) {
            if (attempts > 0) setTimeout(() => forceSetupLanguageES(attempts - 1), 200);
            return;
        }
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
            // Reemplazar el object por un img ya que /system-icons/dockme.svg es un fichero directo
            const img = document.createElement('img');
            img.src = '/system-icons/dockme.svg';
            img.style.cssText = logoObject.style.cssText || 'width:64px;height:64px;';
            logoObject.replaceWith(img);
        }
        const titleDivs = Array.from(document.querySelectorAll('div'))
            .filter(div => div.childNodes.length === 1 && div.textContent?.trim() === 'Dockge');
        titleDivs.forEach(div => {
            div.textContent = 'Dockme';
        });
        document.body.dataset.dockmeBrandingApplied = 'true';
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
        // 3. Insertar botón "Nuevo Stack" antes del placeholder en header-top
        const headerTop = document.querySelector('.header-top[data-v-06020958]');
        if (headerTop && !headerTop.querySelector('.dockme-new-stack-btn, [data-dockme-newstack]')) {
            const placeholder = headerTop.querySelector('.placeholder');
            const btn = document.createElement('button');
            btn.className = 'btn btn-primary';
            btn.dataset.dockmeNewstack = '1';
            btn.style.cssText = 'margin-left:6px;padding-left:8px !important;padding-right:8px !important;';
            btn.title = 'Nuevo Stack';
            btn.innerHTML = `<svg class="svg-inline--fa fa-plus" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path fill="currentColor" d="M256 80c0-17.7-14.3-32-32-32s-32 14.3-32 32V224H48c-17.7 0-32 14.3-32 32s14.3 32 32 32H192V432c0 17.7 14.3 32 32 32s32-14.3 32-32V288H400c17.7 0 32-14.3 32-32s-14.3-32-32-32H256V80z"/></svg>`;
            btn.addEventListener('click', () => openNewStackPanel());
            if (placeholder) headerTop.insertBefore(btn, placeholder);
            else headerTop.prepend(btn);
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
                    : checkStatus === 'pruning'
                        ? `<span class="metric-value warning">Limpiando... 🧹</span>`
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
                            <img src="/system-icons/check-updates.svg" class="btn-check-now" data-endpoint="${endpoint}" title="Comprobar ahora" style="cursor:pointer;width:18px;height:18px;opacity:0.7;${checkStatus === 'checking' || checkStatus === 'pruning' ? 'display:none;' : ''}" />
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
            if (!!State.settingsData?.centralUrl) return;
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

    // Sincronizar al backend los endpoints conectados (online) para que el
    // scheduler no lance checks a servidores detectados pero no conectados
    const connectedEps = agents.filter(a => a.isOnline).map(a => a.endpoint);
    fetch('/api/set-connected-endpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoints: connectedEps })
    }).catch(() => {});
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
                    <div class="detected-server-endpoint"><a href="http://${server.endpoint}" target="_blank" rel="noopener" style="color:#7eb8f7;"><code>${server.endpoint}</code></a></div>
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
            <p style="color:#7a9cc4;font-size:0.82em;line-height:1.6;margin-bottom:14px;">
                ⚠️ Antes de conectar a un agente por primera vez, accede a su interfaz web y crea el usuario si aún no lo has hecho. Luego introduce las credenciales aquí para conectar con el agente.
            </p>
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

// ==================== BLOQUEO UI AGENTE REMOTO ====================
function applyAgentMode(centralUrl) {
    const centralLink = centralUrl
        ? `<a href="${centralUrl}" style="color:#7eb8f7;text-decoration:underline;">${centralUrl}</a>`
        : 'el servidor central';

    const applyUI = () => {
        // Ocultar columna de stacks de Dockge
        const stackCol = document.querySelector('.col-12.col-md-4.col-xl-3');
        if (stackCol) stackCol.style.setProperty('display', 'none', 'important');

        // Ocultar li con dockme-header-icons y botón Novedades — dejar avatar
        const dockmeIconsLi = document.querySelector('.dockme-header-icons')?.closest('li.nav-item');
        if (dockmeIconsLi) dockmeIconsLi.style.setProperty('display', 'none', 'important');
        const novedadesBtn = document.querySelector('.btn-novedades-dockme');
        if (novedadesBtn) novedadesBtn.style.setProperty('display', 'none', 'important');
    };

    applyUI();
    const obs = new MutationObserver(applyUI);
    obs.observe(document.body, { childList: true, subtree: true });
}

// ==================== AVISAR VARIABLES OBSOLETAS EN COMPOSE ====================
// TODO: eliminar en v2.3 cuando todos los usuarios hayan migrado
function checkDeprecatedVars() {
    if (document.querySelector('.deprecated-vars-modal')) return;
    if (State.settingsData?.migration_2_1_shown) return;
    if (RouteManager.isSetupPath()) return;

    // Solo mostrar si el settings tiene variables obsoletas realmente
    const settings = State.settingsData || {};
    const hasDeprecated = settings.telegramToken || settings.telegramChatId || 
                          settings.checkTimes || settings.webhookUrl || settings.endpoint;
    if (!hasDeprecated) {
        // Marcar como visto para no volver a comprobar
        fetch('/api/mark-agents-migration-shown', { method: 'POST' }).catch(() => {});
        if (State.settingsData) State.settingsData.migration_2_1_shown = true;
        return;
    }

    const code = v => `<code style="background:#0d1520;padding:2px 6px;border-radius:3px;display:block;margin:3px 0;">${v}</code>`;

    const modal = document.createElement('div');
    modal.className = 'deprecated-vars-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9999;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
        <div style="background:#1a2537;border-radius:10px;padding:28px 32px;max-width:500px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
            <div style="font-size:1.1em;font-weight:600;color:#fff;margin-bottom:12px;">⚠️ Variables del compose obsoletas</div>
            <p style="color:#c0cfe0;font-size:0.88em;line-height:1.6;margin-bottom:14px;">
                Ahora las siguientes variables se gestionan desde el nuevo panel de configuración del propio Dockme en <b>✏️ Editar → General</b>.
            </p>
            <p style="color:#c0cfe0;font-size:0.88em;margin:0 0 6px 0;">Elimina en el compose de Dockme las siguientes variables si las tienes configuradas:</p>
            <div style="margin:0 0 16px 16px;">
                ${['TELEGRAM_TOKEN','TELEGRAM_CHATID','CHECK_TIMES'].map(code).join('')}
            </div>
            <p style="color:#c0cfe0;font-size:0.88em;margin:0 0 6px 0;">Si tienes agentes Dockme remotos, además de eliminar las variables anteriores también debes renombrar en cada uno:</p>
            <div style="margin:0 0 20px 16px;">
                <div style="display:flex;align-items:center;gap:8px;margin:3px 0;">
                    ${code('WEBHOOK_URL')}<span style="color:#7a9cc4;flex-shrink:0;">por</span>${code('CENTRAL_URL')}
                </div>
                <div style="display:flex;align-items:center;gap:8px;margin:3px 0;">
                    ${code('ENDPOINT')}<span style="color:#7a9cc4;flex-shrink:0;">por</span>${code('AGENT_URL')}
                </div>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:10px;">
                <button class="btn btn-normal" id="deprecated-vars-later">Más tarde</button>
                <button class="btn btn-primary" id="deprecated-vars-ok">Entendido</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    const dismiss = () => {
        modal.remove();
        fetch('/api/mark-agents-migration-shown', { method: 'POST' }).catch(() => {});
        if (State.settingsData) State.settingsData.migration_2_1_shown = true;
    };
    modal.querySelector('#deprecated-vars-ok').addEventListener('click', dismiss);
    modal.querySelector('#deprecated-vars-later').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

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

    // Cargar uiUrl actuales desde updates.json y primaryHost desde settings.json
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
            // primaryHost viene de settings.json (ya en State.settingsData)
            container.querySelectorAll('.agent-primary-host-value').forEach(span => {
                const ph = State.settingsData?.primaryHost || primaryHostLocal || '';
                if (ph) {
                    span.textContent = ph;
                } else {
                    span.textContent = 'localhost';
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
        input.addEventListener('blur', () => handleSave());
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
                        // Actualizar en State.settingsData (fuente de verdad)
                        if (State.settingsData) State.settingsData.primaryHost = newVal;
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

function renderGeneralTab(container) {
    container.innerHTML = '<p style="color:#aaa;">Cargando configuración...</p>';

    fetch('/api/get-settings?t=' + Date.now())
        .then(r => r.json())
        .then(settings => {
            const notif        = settings.notifications || {};
            const notifEnabled = !!notif.enabled;
            const notifUrl     = (Array.isArray(notif.urls) ? notif.urls[0] : '') || '';
            const pruneMode    = settings.pruneMode || 'disabled';
            const checkTime    = settings.checkTime || '09:00';

            container.innerHTML = `
                <div class="general-tab-form">

                    <!-- NOTIFICACIONES -->
                    <div class="general-section">
                        <div class="general-section-title">🔔 Notificaciones</div>

                        <div class="general-field">
                            <div class="general-input-row" style="align-items:center;gap:10px;">
                                <label class="general-toggle">
                                    <input type="checkbox" id="gen-notif-enabled" ${notifEnabled ? 'checked' : ''}>
                                    <span class="general-toggle-slider"></span>
                                </label>
                                <span class="general-label" style="margin:0;">Enviar notificaciones</span>
                                <span class="gen-field-status" id="gen-notif-enabled-status"></span>
                            </div>
                        </div>

                        <div class="general-field">
                            <label class="general-label" style="margin-bottom:4px;display:block;">Ejemplos por servicio</label>
                            <select id="gen-notif-service-select" class="dockme-service-url-input" style="margin-bottom:6px;">
                                <option value="">— Selecciona un servicio —</option>
                            </select>
                            <div id="gen-notif-example" style="display:none;background:#0d1520;border-radius:6px;padding:8px 10px;font-size:0.82em;margin-bottom:10px;">
                                <div style="color:#6a7f9a;margin-bottom:6px;font-size:0.9em;">
                                    Copia el ejemplo y sustituye las palabras en MAYÚSCULAS por tus valores:
                                </div>
                                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
                                    <code id="gen-notif-example-url" style="word-break:break-all;color:#7eb8f7;flex:1;"></code>
                                    <button id="gen-notif-example-copy" class="btn btn-normal" style="padding:1px 8px;font-size:0.8em;flex-shrink:0;">Copiar</button>
                                </div>
                                <div id="gen-notif-example-notes" style="margin-top:6px;color:#7a9cc4;font-style:italic;line-height:1.4;"></div>
                                <a id="gen-notif-example-link" href="#" target="_blank" rel="noopener"
                                   style="display:none;margin-top:6px;font-size:0.82em;color:#5b8fc9;">
                                   📖 Ver documentación de este servicio
                                </a>
                            </div>
                        </div>

                        <div class="general-field">
                            <label class="general-label">URL de notificación</label>
                            <div class="general-input-row">
                                <input type="text" id="gen-notif-url" class="dockme-service-url-input"
                                    placeholder="telegram://TOKEN@telegram?chats=CHATID" value="${notifUrl}">
                                <span class="gen-field-status" id="gen-notif-url-status"></span>
                            </div>
                            <div style="margin-top:6px;display:flex;align-items:center;gap:8px;">
                                <button class="btn btn-normal" id="gen-notif-test" style="padding:2px 10px;font-size:0.85em;">Enviar prueba</button>
                                <span class="gen-field-status" id="gen-notif-test-status" style="font-size:0.85em;"></span>
                            </div>
                        </div>
                    </div>

                    <!-- PRUNE -->
                    <div class="general-section">
                        <div class="general-section-title">🧹 Limpieza de imágenes</div>

                        <div class="general-prune-row">
                            <div class="general-prune-left">
                                <label class="general-label">Limpieza diaria</label>
                                <div class="general-input-row">
                                    <select id="gen-prune-mode" class="dockme-service-url-input">
                                        <option value="disabled"     ${pruneMode === 'disabled'     ? 'selected' : ''}>Desactivado</option>
                                        <option value="conservative" ${pruneMode === 'conservative' ? 'selected' : ''}>Ligero (recomendado)</option>
                                        <option value="normal"       ${pruneMode === 'normal'       ? 'selected' : ''}>Completo</option>
                                        <option value="aggressive"   ${pruneMode === 'aggressive'   ? 'selected' : ''}>Agresivo</option>
                                    </select>
                                    <span class="gen-field-status" id="gen-prune-mode-status"></span>
                                </div>
                            </div>
                            <div class="general-prune-right">
                                <label class="general-label">Limpieza puntual</label>
                                <button class="btn btn-danger" id="gen-prune-total-btn" style="margin-top:-5px;height:36px;">🧹 Limpieza Total</button>
                                <span class="gen-field-status" id="gen-prune-total-status"></span>
                            </div>
                        </div>
                        <span class="general-field-hint" id="gen-prune-hint"></span>
                    </div>

                    <!-- CHECK AUTOMÁTICO -->
                    <div class="general-section">
                        <div class="general-section-title">⏰ Comprobación de actualizaciones</div>

                        <div class="general-field">
                            <label class="general-label">Programación diaria</label>
                            <div class="general-input-row">
                                <input type="time" id="gen-check-time" class="dockme-service-url-input general-time-input"
                                    value="${checkTime}">
                                <span class="gen-field-status" id="gen-check-time-status"></span>
                            </div>
                        </div>
                    </div>

                    <!-- SEGURIDAD -->
                    <div class="general-section">
                        <div class="general-section-title">🔒 Seguridad</div>
                        <div class="general-field">
                            <label class="general-label">Contraseña actual</label>
                            <div class="general-input-row">
                                <input type="password" id="gen-pass-current" class="dockme-service-url-input" autocomplete="current-password" placeholder="••••••••">
                            </div>
                        </div>
                        <div class="general-field">
                            <label class="general-label">Nueva contraseña</label>
                            <div class="general-input-row">
                                <input type="password" id="gen-pass-new" class="dockme-service-url-input" autocomplete="new-password" placeholder="••••••••">
                            </div>
                        </div>
                        <div class="general-field">
                            <label class="general-label">Repetir nueva contraseña</label>
                            <div class="general-input-row">
                                <input type="password" id="gen-pass-repeat" class="dockme-service-url-input" autocomplete="new-password" placeholder="••••••••">
                            </div>
                        </div>
                        <div class="general-field">
                            <button class="btn btn-primary" id="gen-pass-save">🔑 Cambiar contraseña</button>
                            <div id="gen-pass-msg" style="margin-top:10px;text-align:center;font-size:0.9em;line-height:1.5;"></div>
                        </div>
                    </div>

                </div>
            `;

            // Helper: muestra ✅ o ❌ junto al campo y lo borra a los 2s
            const showStatus = (statusId, ok) => {
                const el = container.querySelector(`#${statusId}`);
                if (!el) return;
                el.textContent = ok ? '✅' : '❌';
                setTimeout(() => { el.textContent = ''; }, 2000);
            };

            // Helper: envía solo el campo que cambió
            const saveField = (payload, statusId) => {
                fetch('/api/save-settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                })
                .then(r => r.json())
                .then(data => showStatus(statusId, !!data.success))
                .catch(() => showStatus(statusId, false));
            };

            // Helper para inputs de texto: guarda en blur y Enter
            const bindTextInput = (id, statusId, buildPayload) => {
                const el = container.querySelector(`#${id}`);
                if (!el) return;
                const save = () => saveField(buildPayload(el.value.trim()), statusId);
                el.addEventListener('blur', save);
                el.addEventListener('keydown', e => {
                    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
                });
            };

            // Toggle enabled
            container.querySelector('#gen-notif-enabled').addEventListener('change', function () {
                saveField(
                    { notifications: { enabled: this.checked } },
                    'gen-notif-enabled-status'
                );
            });

            // URL de notificación
            bindTextInput('gen-notif-url', 'gen-notif-url-status', val => ({
                notifications: { urls: val ? [val] : [] }
            }));

            // Cargar ejemplos de servicios desde el JSON estático
            fetch('/api/shoutrrr-services?t=' + Date.now())
                .then(r => r.json())
                .then(data => {
                    const services = data.services || [];
                    const sel = container.querySelector('#gen-notif-service-select');
                    if (!sel) return;
                    services.forEach(svc => {
                        const opt = document.createElement('option');
                        opt.value = svc.url || '';
                        opt.dataset.notes = svc.notes || '';
                        opt.dataset.link  = svc.link  || '';
                        opt.textContent = svc.name;
                        if (!svc.url) opt.disabled = true; // separadores de categoría
                        sel.appendChild(opt);
                    });

                    sel.addEventListener('change', function () {
                        const exampleDiv  = container.querySelector('#gen-notif-example');
                        const exampleUrl  = container.querySelector('#gen-notif-example-url');
                        const exampleNote = container.querySelector('#gen-notif-example-notes');
                        const exampleLink = container.querySelector('#gen-notif-example-link');
                        const copyBtn     = container.querySelector('#gen-notif-example-copy');
                        if (!this.value) {
                            exampleDiv.style.display = 'none';
                            return;
                        }
                        const opt = this.options[this.selectedIndex];
                        exampleUrl.textContent  = this.value;
                        exampleNote.textContent = opt.dataset.notes || '';
                        const link = opt.dataset.link || '';
                        if (link) {
                            exampleLink.href = link;
                            exampleLink.style.display = 'inline-block';
                        } else {
                            exampleLink.style.display = 'none';
                        }
                        exampleDiv.style.display = 'block';

                        copyBtn.onclick = () => {
                            navigator.clipboard.writeText(this.value).then(() => {
                                copyBtn.textContent = '✅';
                                setTimeout(() => { copyBtn.textContent = 'Copiar'; }, 1500);
                            }).catch(() => {});
                        };
                    });
                })
                .catch(() => {}); // si no carga el JSON, la sección simplemente no aparece

            // Botón Enviar prueba
            container.querySelector('#gen-notif-test').addEventListener('click', () => {
                const statusEl = container.querySelector('#gen-notif-test-status');
                fetch('/api/test-notification', { method: 'POST' })
                    .then(r => r.json())
                    .then(d => {
                        statusEl.textContent = d.success ? '✅' : '❌ ' + (d.message || 'Error');
                        statusEl.style.color = d.success ? '#8affc1' : '#ff8a8a';
                        setTimeout(() => { statusEl.textContent = ''; statusEl.style.color = ''; }, 4000);
                    })
                    .catch(() => {
                        statusEl.textContent = '❌ Error de conexión';
                        statusEl.style.color = '#ff8a8a';
                        setTimeout(() => { statusEl.textContent = ''; statusEl.style.color = ''; }, 4000);
                    });
            });

            // Hora del check
            bindTextInput('gen-check-time', 'gen-check-time-status', val => ({
                checkTime: val
            }));

            // Prune mode — guarda al cambiar el select
            const pruneSelect = container.querySelector('#gen-prune-mode');
            const pruneHints = {
                disabled:     '',
                conservative: 'Elimina imágenes antiguas reemplazadas por una actualización.\nLos stacks parados no se ven afectados.\nSe aplica tras 48h.',
                normal:       'Elimina todas las imágenes que no estén en uso,\nincluyendo las de stacks parados, eliminados o de versiones anteriores.\nSe aplica tras 48h.',
                aggressive:   'Como Completo pero sin espera mínima.\nElimina inmediatamente todo lo que no esté en uso.'
            };
            const updatePruneHint = () => {
                const hint = container.querySelector('#gen-prune-hint');
                if (hint) hint.textContent = pruneHints[pruneSelect.value] || '';
            };
            pruneSelect.addEventListener('change', function () {
                updatePruneHint();
                saveField({ pruneMode: this.value }, 'gen-prune-mode-status');
            });
            updatePruneHint();

            // Prune Total — modal de confirmación + lanzar en todos los servidores
            container.querySelector('#gen-prune-total-btn').addEventListener('click', () => {
                // Cerrar modo edición y volver al dashboard para ver las métricas
                dockmeEditMode = false;
                updateEditModeToggleUI();

                // Pequeño delay para que el dashboard se redibuje antes del modal
                setTimeout(() => {
                    const modal = document.createElement('div');
                    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9999;display:flex;align-items:center;justify-content:center;';
                    modal.innerHTML = `
                        <div style="background:#1a2537;border-radius:10px;padding:28px 32px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
                            <div style="font-size:1.1em;font-weight:600;color:#fff;margin-bottom:12px;">⚠️ Confirmar Prune Total</div>
                            <p style="color:#c0cfe0;font-size:0.95em;line-height:1.6;margin-bottom:8px;">
                                Se eliminarán <b>todas las imágenes Docker no usadas en este momento</b> en todos los servidores, sin límite de tiempo.
                            </p>
                            <p style="color:#f0a060;font-size:0.88em;line-height:1.5;margin-bottom:20px;">
                                Los stacks parados perderán su imagen y tendrán que descargarla de nuevo al arrancar.
                            </p>
                            <div style="display:flex;justify-content:flex-end;gap:10px;">
                                <button class="btn btn-normal" id="prune-total-cancel">Cancelar</button>
                                <button class="btn btn-danger" id="prune-total-confirm">Sí, limpiar todo</button>
                            </div>
                        </div>
                    `;
                    document.body.appendChild(modal);
                    modal.querySelector('#prune-total-cancel').addEventListener('click', () => modal.remove());
                    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

                    modal.querySelector('#prune-total-confirm').addEventListener('click', async () => {
                        modal.remove();

                        // Obtener todos los servidores del updates.json
                        let servers = [];
                        try {
                            const data = await fetch('/config/updates.json?t=' + Date.now()).then(r => r.json());
                            servers = Array.isArray(data) ? data : [];
                        } catch {}

                        // Lanzar prune agresivo en paralelo en todos los servidores
                        await Promise.allSettled(servers.map(async (host) => {
                            const endpoint = host.endpoint?.toLowerCase() === 'actual' ? null : host.endpoint;
                            const body = { pruneMode: 'aggressive' };
                            if (endpoint) body.endpoint = endpoint;
                            await fetch('/api/run-prune', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(body)
                            });
                        }));
                    });
                }, 300);
            });

            // Cambiar contraseña via socket de Dockge
            container.querySelector('#gen-pass-save')?.addEventListener('click', () => {
                const current  = container.querySelector('#gen-pass-current')?.value;
                const newPass  = container.querySelector('#gen-pass-new')?.value;
                const repeat   = container.querySelector('#gen-pass-repeat')?.value;
                const msgEl    = container.querySelector('#gen-pass-msg');

                const showMsg = (text, ok) => {
                    if (!msgEl) return;
                    msgEl.style.color = ok ? '#4caf50' : '#ff6b6b';
                    msgEl.textContent = text;
                    if (ok) setTimeout(() => { msgEl.textContent = ''; }, 5000);
                };

                if (!current || !newPass || !repeat) {
                    showMsg('Por favor rellena todos los campos.', false);
                    return;
                }
                if (newPass !== repeat) {
                    showMsg('Las contraseñas nuevas no coinciden.', false);
                    return;
                }

                const sock = document.querySelector('#app')?._vnode?.component?.root?.proxy?.getSocket();
                if (!sock) { showMsg('Error de conexión con el servidor.', false); return; }

                sock.emit('changePassword', { currentPassword: current, newPassword: newPass, repeatNewPassword: repeat }, (res) => {
                    if (res.ok) {
                        showMsg('✅ Contraseña actualizada correctamente.', true);
                        container.querySelector('#gen-pass-current').value = '';
                        container.querySelector('#gen-pass-new').value = '';
                        container.querySelector('#gen-pass-repeat').value = '';
                    } else {
                        const msgMap = {
                            'Incorrect current password': 'Contraseña actual incorrecta.',
                            'Password is too weak': 'Contraseña demasiado débil. Debe tener al menos 6 caracteres con letras y números.'
                        };
                        const translated = Object.entries(msgMap).find(([k]) => (res.msg || '').includes(k))?.[1]
                            || res.msg || 'Error al cambiar la contraseña.';
                        showMsg(`❌ ${translated}`, false);
                    }
                });
            });
        })
        .catch(() => {
            container.innerHTML = '<p style="color:#ff8a8a;">❌ No se pudo cargar la configuración.</p>';
        });
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
            // Marcar como logueado en updates.json (persiste entre reinicios)
            fetch('/api/set-agent-logged', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint, loggedIn: true })
            }).catch(() => {});
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
    // Interceptar clicks en a.item cuando editMode está activo
    document.addEventListener('click', (e) => {
        if (!dockmeEditMode) return;
        const stackItem = e.target.closest('a.item');
        if (!stackItem) return;
        e.preventDefault();
        e.stopPropagation();
        const href = stackItem.getAttribute('href');
        if (href) handleEditStackSelection(href);
    }, true);

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
                // Esperar a que Dockge conecte los agentes antes de cargar
                setTimeout(() => {
                    Promise.all([loadStacksConfig(), loadLinksConfig()]).then(() => DataLoader.loadAndDisplay());
                    MetricsManager.stop();
                    MetricsManager.start();
                }, 2000);
            }
        }
        ItemManager.processAll();
        ensureTitleIsCorrect();
        insertEditStacksIcon();
        setTimeout(() => ItemManager.refreshIcons(), CONFIG.ICON_REFRESH_DELAY);
        reasignarIconos();

        // Añadir footer de GitHub bajo la lista de stacks
        if (!document.querySelector('#dockme-github-footer')) {
            const stackList = document.querySelector('.stack-list.scrollbar');
            if (stackList) {
                const footer = document.createElement('a');
                footer.id = 'dockme-github-footer';
                footer.href = 'https://github.com/fernandeusto/dockme';
                footer.target = '_blank';
                footer.rel = 'noopener';
                footer.style.cssText = 'display:flex;align-items:center;gap:7px;opacity:0.4;text-decoration:none;color:rgb(204,204,204);transition:opacity 0.2s;justify-content:center;min-height:2.5em;line-height:1.25em;margin-left:-20px;';
                footer.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:24px;height:24px;flex-shrink:0;"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.2 11.38.6.11.82-.26.82-.58v-2.03c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49 1 .11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 3-.4c1.02 0 2.04.13 3 .4 2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58C20.57 21.8 24 17.3 24 12c0-6.63-5.37-12-12-12z"/></svg>DockMe — ¡Déjanos una estrella!`;
                footer.addEventListener('mouseenter', () => footer.style.opacity = '0.8');
                footer.addEventListener('mouseleave', () => footer.style.opacity = '0.4');
                stackList.insertAdjacentElement('afterend', footer);
            }
        }
    };

    DOMObserver.init(processTodoCompleto);
    processTodoCompleto();
    DOMObserver.start();

    setInterval(() => ItemManager.refreshIcons(), CONFIG.REORDER_INTERVAL);
    // Detectar navegación directa por URL (sin Vue Router)
    window.addEventListener('popstate', () => RouteObserver.observe());
    RouteObserver.observe(); // comprobar ruta inicial
    // setInterval(reasignarIconos, 500); // desactivado — DOMObserver ya cubre este caso

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
            MetricsManager.start();
            // Pausar métricas cuando la pestaña no está activa
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    MetricsManager.stop();
                } else if (RouteManager.isRootPath()) {
                    MetricsManager.start();
                }
            });

            // Limpiar stacks de agentes que se desconectan
            const sock = document.querySelector('#app')?._vnode?.component?.root?.proxy?.getSocket();
            if (sock) {
                sock.on('agentStatus', (agents) => {
                    const list = Array.isArray(agents) ? agents : [agents];
                    const root = document.querySelector('#app')?._vnode?.component?.proxy?.$root;
                    if (!root) return;
                    list.forEach(a => {
                        if (a.status === 'offline' && a.endpoint) {
                            delete root.allAgentStackList[a.endpoint];
                        }
                    });
                });
            }
        };
        setTimeout(checkAndLoadAgents, 300);
    }

    // Registrar beforeEach siempre — independientemente de la ruta de entrada
    const registerBeforeEach = () => {
        const vueRouter = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$router;
        if (!vueRouter) { setTimeout(registerBeforeEach, 200); return; }
        if (vueRouter._dockme_guard) return; // ya registrado
        vueRouter._dockme_guard = true;
        let lastMousePos = { x: 0, y: 0 };
        document.addEventListener('mousemove', (e) => { lastMousePos = { x: e.clientX, y: e.clientY }; }, true);
        vueRouter.beforeEach((to, from, next) => {
            // Solo notificar al RouteObserver si no vamos a interceptar la ruta
            if (!to.path?.startsWith('/compose/')) {
                RouteObserver.lastRoute = to.path;
                RouteObserver.handleRouteChange(to.path);
            }
            // Si venimos de /setup y vamos a /, resetear GlobalData para que recargue todo
            if (from.path === '/setup' && to.path === '/') {
                GlobalData.loaded = false;
                GlobalData.load();
            }
            if (to.path?.startsWith('/compose/')) {
                const allIcons = document.querySelectorAll('img.cp-icon');
                let img = null;
                for (const icon of allIcons) {
                    const rect = icon.getBoundingClientRect();
                    if (lastMousePos.x >= rect.left && lastMousePos.x <= rect.right &&
                        lastMousePos.y >= rect.top  && lastMousePos.y <= rect.bottom) {
                        img = icon; break;
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
                    if (stackData?.url) window.open(stackData.url, '_blank');
                    next(false);
                    return;
                }
                const parts = to.path.split('/').filter(Boolean);
                const stackName = parts[1] || '';
                const endpoint  = parts[2] || 'Actual';
                next(false);
                if (!document.body.classList.contains('dockme-logs-mode')) {
                    activateLogsMode();
                    setTimeout(() => openLogsForStack(stackName, endpoint), 100);
                } else {
                    openLogsForStack(stackName, endpoint);
                }
                return;
            }
            next();
        });
    };
    setTimeout(registerBeforeEach, 300);
}

    // ==================== START ====================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();