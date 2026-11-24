(meta) => {
  const d = document;
  d.querySelectorAll('select').forEach(s => [...s.options].forEach(o => o.selected ? o.setAttribute('selected','') : o.removeAttribute('selected')));
  d.querySelectorAll('input').forEach(i => { if (i.type==='checkbox'||i.type==='radio') { i.checked ? i.setAttribute('checked','') : i.removeAttribute('checked'); } else i.setAttribute('value', i.value); });
  d.querySelectorAll('textarea').forEach(t => t.textContent = t.value);
  const scrolls = [];
  d.querySelectorAll('*').forEach((el, n) => { if (el.scrollTop > 0 || el.scrollLeft > 0) { el.setAttribute('data-mock-scroll', n); scrolls.push([n, el.scrollTop, el.scrollLeft]); } });
  let css = '';
  for (const sh of d.styleSheets) { try { for (const r of sh.cssRules) css += r.cssText + '\n'; } catch (e) {} }
  const fonts = new Set();
  css = css.replace(/url\((['"]?)([^'")]+\.(?:woff2?|ttf|otf))\1\)/g, (m, q, u) => { fonts.add(u); return `url("../assets/${u.split('/').pop().split('?')[0]}")`; });
  const root = d.documentElement.cloneNode(true);
  root.querySelectorAll('script, link[rel="stylesheet"], link[rel="modulepreload"], style').forEach(e => e.remove());
  const head = root.querySelector('head');
  const m = d.createElement('meta'); m.name = 'mockup-viewport'; m.content = meta.vp; head.prepend(m);
  const st = d.createElement('style'); st.textContent = css; head.append(st);
  const sc = d.createElement('script');
  sc.textContent = `(function(){var t=new URLSearchParams(location.search).get('theme');if(t)document.documentElement.setAttribute('data-theme',t);addEventListener('load',function(){window.scrollTo(${scrollX},${scrollY});${JSON.stringify(scrolls)}.forEach(function(s){var e=document.querySelector('[data-mock-scroll="'+s[0]+'"]');if(e){e.scrollTop=s[1];e.scrollLeft=s[2];}});});})();`;
  head.append(sc);
  d.querySelectorAll('[data-mock-scroll]').forEach(e => e.removeAttribute('data-mock-scroll'));
  return { html: '<!doctype html>\n' + root.outerHTML, fonts: [...fonts] };
}
