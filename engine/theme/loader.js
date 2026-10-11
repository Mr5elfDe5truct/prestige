// Custom AI workstation theme switcher for Open WebUI (see custom.css).
// start-all.ps1 copies this into Open WebUI's static folder and puts the -Theme default on the first line.
// Ctrl+Alt+T cycles the themes; the choice is remembered in this browser profile.
(() => {
	const THEMES = { dragon: 'Dragon Red & Gold', neon: 'Cyberpunk Neon', glass: 'Glass', hud: 'Terminal HUD', off: 'Open WebUI default' };
	const ORDER = Object.keys(THEMES);
	const fallback = THEMES[window.CAI_DEFAULT_THEME] ? window.CAI_DEFAULT_THEME : 'dragon';

	const saved = () => {
		try { return localStorage.getItem('cai-theme'); } catch { return null; }
	};
	const apply = (name) => {
		document.documentElement.dataset.caiTheme = name;
		const bg = getComputedStyle(document.documentElement).getPropertyValue('--cai-bg').trim();
		const meta = document.querySelector('meta[name="theme-color"]');
		if (meta && /^#[0-9a-f]{3,8}$/i.test(bg)) meta.setAttribute('content', bg);
	};

	// A new -Theme default from start-all.ps1 replaces the choice made in the app.
	try {
		if (localStorage.getItem('cai-theme-default') !== fallback) {
			localStorage.setItem('cai-theme-default', fallback);
			localStorage.removeItem('cai-theme');
		}
	} catch {}

	let current = THEMES[saved()] ? saved() : fallback;
	apply(current);

	let toastTimer;
	const toast = (text) => {
		let el = document.getElementById('cai-theme-toast');
		if (!el) {
			el = document.createElement('div');
			el.id = 'cai-theme-toast';
			document.body.appendChild(el);
		}
		el.textContent = text;
		el.classList.add('show');
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
	};

	document.addEventListener('keydown', (e) => {
		if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 't') {
			e.preventDefault();
			current = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
			try { localStorage.setItem('cai-theme', current); } catch {}
			apply(current);
			toast('Theme: ' + THEMES[current]);
		}
	});

	// Small palette button in the bottom-right corner that opens a theme menu.
	const picker = () => {
		const btn = document.createElement('button');
		btn.id = 'cai-theme-button';
		btn.title = 'Theme (Ctrl+Alt+T)';
		btn.setAttribute('aria-label', 'Choose theme');
		btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.9 1.4-1.9-.3-1 .4-2.1 1.5-2.1H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/></svg>';
		const menu = document.createElement('div');
		menu.id = 'cai-theme-menu';
		menu.setAttribute('role', 'menu');
		const render = () => {
			menu.innerHTML = '';
			ORDER.forEach((name) => {
				const item = document.createElement('button');
				item.setAttribute('role', 'menuitemradio');
				item.setAttribute('aria-checked', String(name === current));
				item.dataset.theme = name;
				item.innerHTML = '<span class="cai-swatch"></span>' + THEMES[name];
				item.onclick = () => { window.caiSetTheme(name); menu.classList.remove('open'); };
				menu.appendChild(item);
			});
		};
		btn.onclick = (e) => { e.stopPropagation(); render(); menu.classList.toggle('open'); };
		document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.classList.remove('open'); });
		document.body.append(btn, menu);
	};
	if (document.body) picker(); else document.addEventListener('DOMContentLoaded', picker);

	window.caiSetTheme = (name) => {
		if (!THEMES[name]) return Object.keys(THEMES);
		current = name;
		try { localStorage.setItem('cai-theme', name); } catch {}
		apply(name);
		return name;
	};
})();
